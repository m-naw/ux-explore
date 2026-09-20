import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  aggregate,
  argmaxInOptionOrder,
  argmaxOrEmpty,
  benchJev,
  costUsd,
  decideSchema,
  loadLabels,
  meanPairwiseL1,
  modeOf,
  renderMarkdown,
  sampleDistribution,
  toDecideInput,
  usableSamples,
  type EngineStateResult,
  type LlmSample,
  type StateResult,
} from './bench-decide';
import { argmaxOf } from '../engine/decide';
import { l1Distance, percentile } from '../engine/util';
import { JevEngine, renderStateText } from '../engine/jev-engine';
import type { Option, PageState, PersonaProfile } from '../engine/types';
import type { RecordedDecision } from '../engine/record-decisions';

const engineResult = (
  distribution: Record<string, number>,
  overrides: Partial<EngineStateResult> = {},
): EngineStateResult => ({
  distribution,
  repeatDistributions: [distribution, distribution],
  argmax: argmaxOrEmpty(distribution),
  latencyMs: 300,
  inputTokens: 1000,
  outputTokens: 20,
  invalidSamples: 0,
  ...overrides,
});

const state = (id: string): StateResult => ({
  stateId: id,
  engines: {
    jev: engineResult({ a: 0.8, b: 0.2 }),
    haiku: engineResult({ a: 0.6, b: 0.4 }),
    sonnet: engineResult({ a: 1 }, { referenceArgmax: 'a' }),
  },
});

describe('bench helpers', () => {
  it('turns sampled choices into a distribution', () => {
    expect(sampleDistribution(['a', 'a', 'b', 'a', 'b'])).toEqual({ a: 0.6, b: 0.4 });
  });

  it('measures L1 over the union of the keys', () => {
    expect(l1Distance({ a: 1 }, { a: 0.5, b: 0.5 })).toBeCloseTo(1);
    expect(l1Distance({ a: 1 }, { a: 1 })).toBe(0);
  });

  it('breaks an argmax tie by id so a run is reproducible', () => {
    expect(argmaxOf({ b: 0.5, a: 0.5 })).toBe('a');
    // A state whose samples were all rejected has nothing to rank, and must not throw here.
    expect(argmaxOrEmpty({})).toBe('');
  });

  it('prices each engine from the constant table', () => {
    expect(costUsd('jev', 1_000_000, 0)).toBeCloseTo(0.042);
    expect(costUsd('haiku', 1_000_000, 1_000_000)).toBeCloseTo(6);
    expect(costUsd('sonnet', 1_000_000, 1_000_000)).toBeCloseTo(12);
  });

  it('takes a percentile off the sorted values', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });

  it('averages repeat stability over every pair of repeats', () => {
    expect(meanPairwiseL1([{ a: 1 }, { a: 1 }])).toBe(0);
    // Three runs make three pairs: 2, 0 and 2.
    expect(meanPairwiseL1([{ a: 1 }, { b: 1 }, { a: 1 }])).toBeCloseTo(4 / 3);
  });

  it('has no repeat distance to report from a single run', () => {
    expect(meanPairwiseL1([{ a: 1 }])).toBeNull();
    expect(meanPairwiseL1([])).toBeNull();
  });
});

describe('modeOf', () => {
  it('picks the most frequent choice', () => {
    expect(modeOf(['a', 'b', 'b'], ['a', 'b'])).toBe('b');
  });

  it('breaks a tie by the order the options were offered in, not alphabetically', () => {
    expect(modeOf(['b', 'a'], ['a', 'b'])).toBe('a');
    expect(modeOf(['b', 'a'], ['b', 'a'])).toBe('b');
  });

  it('has no mode when every sample was thrown away', () => {
    expect(modeOf([], ['a', 'b'])).toBeNull();
  });
});

describe('sample filtering', () => {
  const option = (id: string): Option => ({ id, kind: 'element', description: `button "${id}"` });
  const sample = (choice: string | null): LlmSample => ({
    answer: choice === null ? null : { choice, goalMet: 0.2, confusion: 1 },
    latencyMs: 10,
    inputTokens: 5,
    outputTokens: 1,
  });

  it('keeps offered choices and counts everything else as invalid', () => {
    const { usable, invalid } = usableSamples(
      [sample('el_01'), sample(null), sample('el_99'), sample('el_01')],
      [option('el_01')],
    );
    expect(usable.map((u) => u.choice)).toEqual(['el_01', 'el_01']);
    // One truncated/unparseable call, one choice that was never offered.
    expect(invalid).toBe(2);
  });

  it('constrains the schema to exactly the ids this state offered', () => {
    const schema = decideSchema([option('el_01'), option('leave')]);
    const choice = (schema['properties'] as Record<string, Record<string, unknown>>)['choice']!;
    expect(choice['enum']).toEqual(['el_01', 'leave']);
  });

  it('omits the enum rather than emitting an illegal empty one', () => {
    const schema = decideSchema([]);
    const choice = (schema['properties'] as Record<string, Record<string, unknown>>)['choice']!;
    expect(choice['enum']).toBeUndefined();
  });

  it('bounds confusion with an enum, because the API rejects minimum/maximum on an integer', () => {
    const confusion = (
      decideSchema([option('el_01')])['properties'] as Record<string, Record<string, unknown>>
    )['confusion']!;
    expect(confusion['type']).toBe('integer');
    expect(confusion['enum']).toEqual([0, 1, 2, 3, 4]);
  });

  it('uses no minimum or maximum key anywhere in the schema', () => {
    // The live run died on all 30 states with
    // `output_config.format.schema: For 'integer' type, properties maximum, minimum are not
    // supported`, so this walks the whole tree rather than checking the one field we know about.
    const offenders: string[] = [];
    const walk = (node: unknown, trail: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${trail}[${i}]`));
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'minimum' || key === 'maximum') offenders.push(`${trail}.${key}`);
        walk(value, `${trail}.${key}`);
      }
    };
    walk(decideSchema([option('el_01'), option('leave')]), 'schema');
    expect(offenders).toEqual([]);
  });
});

const PERSONA: PersonaProfile = {
  name: 'Olena',
  description: 'Needs a residence card.',
  languages: { native: 'uk', reads: { uk: 'fluent', pl: 'weak' } },
  device: 'mobile',
  techLiteracy: 'low',
  domainLiteracy: 'low',
  patience: 'low',
  intent: 'high',
  facts: {},
};

const STATE: PageState = {
  elements: [],
  meta: {
    url: 'https://dopomo.pl/uk/landing',
    title: 'Landing',
    lang: 'uk',
    scrollY: 0,
    scrollMax: 800,
    viewport: { width: 390, height: 844 },
    h1: 'Landing',
    mainText: 'text',
    visibleText: [{ text: '[h1] Отримайте карту CUKR', landmark: 'main', inAriaLive: false }],
    visibleTextDigest: '',
    belowFoldTextChars: 420,
    nonResponsive: false,
    validationMessages: [],
    langSwitcher: [],
    droppedElements: 0,
    belowFoldSample: [],
    disabledControls: [],
    skippedFrames: 0,
    closedRoots: 0,
  },
  stateHash: 'hash-a',
  viewHash: 'view-a',
};

/**
 * A recorded step whose `stateText` is NOT what a fresh render of the same input produces:
 * this one carries the trim note the size guard leaves behind. That difference is the whole
 * point of the fixture — it makes "the replay sent the recorded text" a real assertion rather
 * than a tautology about `renderStateText` being deterministic.
 */
const RECORDED_STATE_TEXT = [
  'Olena',
  'Needs a residence card.',
  'Native language: uk. Reads: pl weak.',
  'Intent: high (came here on purpose and needs this done)',
  '',
  'Your goal: Get a CUKR residence card',
  '',
  'You are on https://dopomo.pl/uk/landing',
  'On screen now:',
  '[h1] Отримайте карту CUKR',
  '... [text trimmed to fit the request size limit]',
].join('\n');

const OPTIONS: Option[] = [
  {
    id: 'el_01',
    kind: 'element',
    description: 'button "Перевірте →" (visible)',
    elementId: 'el_01',
  },
  { id: 'scroll_down', kind: 'scroll_down', description: 'scroll down' },
];

function recorded(): RecordedDecision {
  return {
    runId: 'run-1',
    step: 3,
    persona: PERSONA,
    goal: 'Get a CUKR residence card',
    state: STATE,
    options: OPTIONS,
    history: [],
    repeats: [],
    seenText: ['Безкоштовна перевірка за 2 хвилини.'],
    stateText: RECORDED_STATE_TEXT,
    jevDistribution: { el_01: 1 },
  };
}

describe('toDecideInput', () => {
  it('copies every field a decide call reads out of the record', () => {
    const record = recorded();
    expect(toDecideInput(record)).toEqual({
      persona: record.persona,
      goal: record.goal,
      state: record.state,
      options: record.options,
      history: record.history,
      repeats: record.repeats,
      seenText: record.seenText,
    });
  });

  it('carries the page text and the seen memory into a rendered replay', () => {
    const text = renderStateText(toDecideInput(recorded()));
    expect(text).toContain('On screen now:');
    expect(text).toContain('[h1] Отримайте карту CUKR');
    expect(text).toContain('Seen earlier on this page:');
    expect(text).toContain('About 420 characters of text below');
    expect(text).toContain('Intent: high');
  });
});

describe('benchJev', () => {
  const JEV_BODY = {
    answers: {
      next: { type: 'choice', probabilities: { el_01: 0.75, scroll_down: 0.25 } },
      goalMet: { type: 'noul', noul: 0.1 },
      confusion: { type: 'score', score: 1 },
    },
    usage: { input_tokens: 4200 },
  };

  it('sends the recorded state text verbatim rather than re-rendering it', async () => {
    const record = recorded();
    // Guards the assertion below: if a fresh render happened to equal the recording, the test
    // would pass without proving anything.
    expect(renderStateText(toDecideInput(record))).not.toBe(record.stateText);

    const bodies: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify(JEV_BODY), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const result = await benchJev(new JevEngine({ apiKey: 'test-key', fetchImpl }), record);

    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect((JSON.parse(body) as { state: string }).state).toBe(record.stateText);
    }
    // Three sequential runs, so repeat stability has three pairs to average.
    expect(result.repeatDistributions).toHaveLength(3);
    expect(result.argmax).toBe('el_01');
    expect(result.inputTokens).toBe(4200 * 3);
    expect(result.invalidSamples).toBe(0);
  });
});

describe('loadLabels', () => {
  it('reads labels, treats a missing file as none, and fails loudly on a malformed one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bench-labels-'));
    try {
      await expect(loadLabels(dir)).resolves.toBeUndefined();

      await writeFile(path.join(dir, 'labels.json'), '{"run-1#3":["el_01"]}', 'utf-8');
      await expect(loadLabels(dir)).resolves.toEqual({ 'run-1#3': ['el_01'] });

      await writeFile(path.join(dir, 'labels.json'), '{not json', 'utf-8');
      await expect(loadLabels(dir)).rejects.toThrow(/labels\.json is not valid JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('aggregate', () => {
  const report = aggregate([state('s1'), state('s2')]);

  it('reports cost and latency per engine', () => {
    expect(report.perEngine.haiku!.states).toBe(2);
    expect(report.perEngine.haiku!.medianLatencyMs).toBe(300);
    expect(report.perEngine.haiku!.p95LatencyMs).toBe(300);
    expect(report.perEngine.haiku!.inputTokens).toBe(2000);
    expect(report.perEngine.haiku!.totalCostUsd).toBeCloseTo(costUsd('haiku', 2000, 40));
  });

  it('summarises non-uniform latency and tokens rather than assuming they match', () => {
    const uneven = aggregate(
      [
        {
          stateId: 'a',
          engines: {
            haiku: engineResult({ a: 1 }, { latencyMs: 100, inputTokens: 10, outputTokens: 1 }),
          },
        },
        {
          stateId: 'b',
          engines: {
            haiku: engineResult({ a: 1 }, { latencyMs: 900, inputTokens: 20, outputTokens: 2 }),
          },
        },
        {
          stateId: 'c',
          engines: {
            haiku: engineResult({ a: 1 }, { latencyMs: 500, inputTokens: 30, outputTokens: 3 }),
          },
        },
      ],
      { engines: ['haiku'] },
    );
    expect(uneven.perEngine.haiku!.medianLatencyMs).toBe(500);
    expect(uneven.perEngine.haiku!.p95LatencyMs).toBe(900);
    expect(uneven.perEngine.haiku!.inputTokens).toBe(60);
    expect(uneven.perEngine.haiku!.outputTokens).toBe(6);
    expect(uneven.perEngine.haiku!.totalCostUsd).toBeCloseTo(costUsd('haiku', 60, 6));
  });

  it('reports repeat stability as a mean pairwise L1 over the repeats', () => {
    expect(report.perEngine.jev!.repeatL1).toBe(0);

    const three = aggregate(
      [
        {
          stateId: 's',
          engines: {
            jev: engineResult({ a: 1 }, { repeatDistributions: [{ a: 1 }, { b: 1 }, { a: 1 }] }),
          },
        },
      ],
      { engines: ['jev'] },
    );
    expect(three.perEngine.jev!.repeatL1).toBeCloseTo(4 / 3);
  });

  it('reports no repeat stability for an engine that was only run once', () => {
    const once = aggregate(
      [
        {
          stateId: 's',
          engines: { haiku: engineResult({ a: 1 }, { repeatDistributions: [{ a: 1 }] }) },
        },
      ],
      {
        engines: ['haiku'],
      },
    );
    expect(once.perEngine.haiku!.repeatL1).toBeNull();
  });

  it('scores each engine against the Sonnet sample mode', () => {
    expect(report.perEngine.jev!.referenceAgreement).toBe(1);
    expect(report.perEngine.haiku!.referenceAgreement).toBe(1);
    expect(report.perEngine.jev!.l1VsReference).toBeCloseTo(0.4);
  });

  it('reports every pairwise distance, Jev against Haiku included', () => {
    const jevHaiku = report.pairs.find((p) => p.a === 'jev' && p.b === 'haiku')!;
    expect(jevHaiku.meanL1).toBeCloseTo(0.4);
    expect(jevHaiku.argmaxAgreement).toBe(1);
    expect(report.pairs.map((p) => `${p.a}|${p.b}`)).toEqual([
      'jev|haiku',
      'jev|sonnet',
      'haiku|sonnet',
    ]);
  });

  it('breaks a pairwise argmax tie by offered order, same as the reference comparison', () => {
    // Jev ties 50/50; the plain argmax says 'a' but the offered-order pick is 'b'. Haiku
    // clearly picks 'b'. The raw (alphabetical) argmax would call this a disagreement.
    const tiedPair: StateResult = {
      stateId: 's1',
      optionOrder: ['b', 'a'],
      engines: { jev: engineResult({ b: 0.5, a: 0.5 }), haiku: engineResult({ b: 0.6, a: 0.4 }) },
    };
    expect(tiedPair.engines.jev!.argmax).toBe('a');
    expect(tiedPair.engines.haiku!.argmax).toBe('b');

    const scored = aggregate([tiedPair], { engines: ['jev', 'haiku'] });
    const jevHaiku = scored.pairs.find((p) => p.a === 'jev' && p.b === 'haiku')!;
    expect(jevHaiku.argmaxAgreement).toBe(1);
  });

  it('scores hand labels when they are supplied', () => {
    const labelled = aggregate([state('s1'), state('s2')], { labels: { s1: ['a'], s2: ['b'] } });
    expect(labelled.perEngine.jev!.labelAccuracy).toBe(0.5);
    expect(aggregate([state('s1')]).perEngine.jev!.labelAccuracy).toBeNull();
  });

  it('scores label accuracy with the same offered-order tie-break as the reference comparison', () => {
    // A 50/50 tie: the plain (alphabetical) argmax says 'a', but the option the persona would
    // have read first was 'b'. A hand label written against 'b' must not read as a miss.
    const tiedLabel: StateResult = {
      stateId: 's1',
      optionOrder: ['b', 'a'],
      engines: { jev: engineResult({ b: 0.5, a: 0.5 }) },
    };
    expect(tiedLabel.engines.jev!.argmax).toBe('a');

    const labelled = aggregate([tiedLabel], { engines: ['jev'], labels: { s1: ['b'] } });
    expect(labelled.perEngine.jev!.labelAccuracy).toBe(1);
  });

  it('drops an engine that was not run, and says the reference is gone with it', () => {
    const partial = aggregate([state('s1')], { engines: ['jev', 'haiku'] });
    expect(Object.keys(partial.perEngine).sort()).toEqual(['haiku', 'jev']);
    expect(partial.perEngine.jev!.referenceAgreement).toBeNull();
    expect(partial.perEngine.jev!.l1VsReference).toBeNull();
    expect(partial.perState[0]!.l1VsReference).toEqual({});
    expect(partial.pairs.map((p) => `${p.a}|${p.b}`)).toEqual(['jev|haiku']);
  });

  it('has no reference on a state where every Sonnet sample was invalid', () => {
    // An empty distribution gives an empty-string argmax. That is the absence of an answer,
    // not an answer, so it must not be matched against another engine that also has nothing.
    const dead: StateResult = {
      stateId: 's2',
      engines: { jev: engineResult({}), sonnet: engineResult({}, { invalidSamples: 5 }) },
    };
    expect(dead.engines.sonnet!.argmax).toBe('');

    const mixed = aggregate([state('s1'), dead]);
    expect(mixed.perState[1]!.reference).toBeNull();
    expect(renderMarkdown(mixed)).toContain('| s2 | n/a |');
    // s1 is the only state with a reference, and Jev agreed there: 1, not 0.5 from a spurious
    // ''-equals-'' match on s2, and not 0 from scoring s2 as a disagreement.
    expect(mixed.perEngine.jev!.referenceAgreement).toBe(1);
  });

  it('excludes a state with no Sonnet reference from l1VsReference instead of folding it in as a zero-distance pair', () => {
    const dead: StateResult = {
      stateId: 's2',
      engines: {
        jev: engineResult({ a: 0.8, b: 0.2 }),
        sonnet: engineResult({}, { invalidSamples: 5 }),
      },
    };
    // Both `state('s1')` states in `report` agree perfectly at L1 0.4 (see the reference test
    // above). Folding s2's empty-vs-nonempty pair in as a real distance of 1.0 would drag the
    // mean up to 0.7; excluding it (the `referenceOf` guard) keeps it at 0.4.
    const mixed = aggregate([state('s1'), dead]);
    expect(mixed.perEngine.jev!.l1VsReference).toBeCloseTo(0.4);
  });

  it('has Sonnet agree with itself when the reference tie is broken by offered order', () => {
    // Four usable samples split 2-2. The mode breaks the tie by offered order ('b' came
    // first); a plain alphabetical argmax would say 'a' and Sonnet would look as though it
    // disagreed with its own reference.
    const tied: StateResult = {
      stateId: 's1',
      optionOrder: ['b', 'a'],
      engines: { sonnet: engineResult({ b: 0.5, a: 0.5 }, { referenceArgmax: 'b' }) },
    };
    expect(tied.engines.sonnet!.argmax).toBe('a');

    const scored = aggregate([tied], { engines: ['sonnet'] });
    expect(scored.perState[0]!.reference).toBe('b');
    expect(scored.perEngine.sonnet!.referenceAgreement).toBe(1);
  });

  it('derives the mode from the distribution, so a mode and an argmax cannot split a tie differently', () => {
    expect(modeOf(['b', 'b', 'a', 'a'], ['b', 'a'])).toBe('b');
    expect(argmaxInOptionOrder({ b: 0.5, a: 0.5 }, ['b', 'a'])).toBe('b');
    expect(argmaxInOptionOrder({}, ['b', 'a'])).toBeNull();
  });

  it('says the reference is gone when Sonnet was asked for but never answered', () => {
    const noSonnet = aggregate([
      { stateId: 's1', engines: { jev: engineResult({ a: 1 }), haiku: engineResult({ a: 1 }) } },
    ]);
    expect(noSonnet.perEngine.jev!.referenceAgreement).toBeNull();
    expect(noSonnet.perEngine.jev!.l1VsReference).toBeNull();
    expect(noSonnet.perState[0]!.reference).toBeNull();
  });

  it('leaves a state an engine is missing from out of that engine average, rather than scoring it zero', () => {
    const mixed = aggregate([
      state('s1'),
      { stateId: 's2', engines: { sonnet: engineResult({ b: 1 }, { referenceArgmax: 'b' }) } },
    ]);
    // Haiku ran on s1 only. It agreed with the reference there, so its agreement is 1 —
    // not 0.5, which is what counting its absence from s2 as a disagreement would give.
    expect(mixed.perEngine.haiku!.states).toBe(1);
    expect(mixed.perEngine.haiku!.referenceAgreement).toBe(1);
    // Its one real distance is 0.8; folding s2 in as a zero would halve it to 0.4.
    expect(mixed.perEngine.haiku!.l1VsReference).toBeCloseTo(0.8);
    expect(mixed.perState[1]!.argmax.haiku).toBeUndefined();
  });

  it('summarises an empty run without inventing numbers', () => {
    const empty = aggregate([]);
    expect(empty.states).toBe(0);
    expect(empty.perEngine).toEqual({});
    expect(empty.pairs).toEqual([]);
    expect(empty.perState).toEqual([]);
    expect(empty.errors).toEqual([]);
    expect(() => renderMarkdown(empty)).not.toThrow();
  });

  it('counts the samples each engine lost, per state and in total', () => {
    const lossy = aggregate(
      [{ stateId: 's1', engines: { haiku: engineResult({ a: 1 }, { invalidSamples: 2 }) } }],
      { engines: ['haiku'] },
    );
    expect(lossy.perState[0]!.invalidSamples.haiku).toBe(2);
    expect(lossy.perEngine.haiku!.invalidSamples).toBe(2);
  });

  it('keeps a failed state out of the tables and names it in the report', () => {
    const withError = aggregate([state('s1')], {
      errors: [{ stateId: 's2', error: 'Jev unavailable' }],
    });
    expect(withError.states).toBe(1);
    expect(withError.errors).toEqual([{ stateId: 's2', error: 'Jev unavailable' }]);
    const md = renderMarkdown(withError);
    expect(md).toContain('## Errors');
    expect(md).toContain('| s2 | Jev unavailable |');
  });

  it('renders one markdown table per metric group', () => {
    const md = renderMarkdown(report);
    expect(md).toContain('## Cost and latency');
    expect(md).toContain('## Repeat stability');
    expect(md).toContain('## Agreement with the Sonnet reference');
    expect(md).toContain('## Pairwise distance');
    expect(md).toContain('| jev vs haiku |');
    expect(md).toContain('| jev |');
  });

  it('says in the markdown that the reference is a stochastic sample mode and the calls are serial', () => {
    const md = renderMarkdown(report);
    expect(md).toContain("Sonnet's sample mode");
    expect(md).toContain('All calls are sequential');
    expect(md).not.toContain('temperature-0');
  });
});
