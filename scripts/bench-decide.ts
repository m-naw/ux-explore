// scripts/bench-decide.ts
// Replays recorded decision states against three engines so the launch article's cost and
// latency claims are reproducible. NOT an engine and not a product
// feature: the DecideEngine adapter below exists only for this script's --e2e mode.
//
// Usage:
//   npx tsx scripts/bench-decide.ts ./reports [--states 30] [--engines jev,haiku,sonnet]
//                                             [--repeat] [--out ./reports/bench] [--e2e]
//
// Input: a directory of run folders, each holding `decisions/step-NN.json` written by
// `npx tsx cli.ts ... --record-decisions`.
//
// Call budget per state: Jev 3, Haiku 5, Sonnet 5. Neither LLM makes a temperature-0 call —
// `claude-sonnet-5` rejects `temperature` outright, so Sonnet is sampled with
// `output_config.effort` instead and the reference choice is the MODE of its five samples.
// That reference is therefore stochastic: it is a reference point, not a correct answer, and
// two runs of this bench can disagree about it.
//
// EVERY call is sequential — engines in order, samples one after another, Jev repeats one
// after another. Nothing here runs concurrently, so a 30-state run takes roughly
// 30 × 13 × (one call's latency) of wall time: budget tens of minutes, not seconds. The
// reported latency is per call, which is the number the article quotes, and keeping the calls
// serial is what stops one engine's numbers being inflated by another engine's load.
//
// Output is written after EVERY state, so an interrupted run still leaves a usable
// `bench.json` and `bench.md` covering the states that finished. A state whose calls throw is
// recorded in `errors` and the run continues; the process exits non-zero if any state errored.
//
// Optional hand labels: put `labels.json` in that same input directory, shaped
//   { "<runId>#<step>": ["el_14", "scroll_down"] }
// mapping a state id to the set of option ids a human considers acceptable. The state id is
// the one printed in the per-state table. When the file is absent, the label column is "n/a";
// when it is present but malformed, the run stops and says which file and why.
//
// Keys come from the environment only, never from a file this script writes:
//   TYPESAFE_API_KEY  — Jev
//   ANTHROPIC_API_KEY — Claude Haiku 4.5 and Claude Sonnet 5
// Both are required; the script exits with a clear message when either is missing.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { drive, launchBrowser } from '../engine/driver';
import { argmaxOf } from '../engine/decide';
import { JevEngine, renderStateText } from '../engine/jev-engine';
import { l1Distance, mean, percentile } from '../engine/util';
import { loadPersona, PERSONA_DIR } from '../personas';
import type {
  DecideEngine,
  DecideInput,
  ExploreConfig,
  Option,
  RawDecision,
} from '../engine/types';
import type { RecordedDecision } from '../engine/record-decisions';

export type BenchEngineName = 'jev' | 'haiku' | 'sonnet';

/** Fixed order, so every table and every pair list reads the same way run to run. */
export const BENCH_ENGINES: readonly BenchEngineName[] = ['jev', 'haiku', 'sonnet'] as const;

/** USD per million tokens. The one place the article's numbers come from. */
export const PRICES: Record<BenchEngineName, { inputPerM: number; outputPerM: number }> = {
  jev: { inputPerM: 0.042, outputPerM: 0 },
  haiku: { inputPerM: 1, outputPerM: 5 },
  sonnet: { inputPerM: 2, outputPerM: 10 },
};

export const BENCH_MODELS: Record<'haiku' | 'sonnet', string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
};

/** Default number of states sampled across the input journeys. */
export const DEFAULT_STATES = 30;

/** Samples per LLM distribution. Both LLMs sample; neither makes a deterministic call. */
export const SAMPLES_PER_DISTRIBUTION = 5;

/** Jev calls per state. Three, so repeat stability is a mean over three pairs, not one. */
export const JEV_REPEATS = 3;

/**
 * Room for the JSON object and, on Sonnet, for the thinking it does before it. 256 was enough
 * for the answer alone and truncated anything else, which read as a parse failure rather than
 * as the budget problem it was.
 */
export const MAX_TOKENS = 1024;

/** Sonnet 5 takes no `temperature`; effort is the only sampling lever, and low is the cheap one. */
export const SONNET_EFFORT = 'low' as const;

/** Hard ceiling on --e2e journeys, so a benchmark cannot become an expensive run. */
export const E2E_JOURNEY_CAP = 20;

/**
 * Rebuild the exact `DecideInput` the driver had. Everything `buildRequest` reads is in the
 * record. The replay does not rely on that reconstruction for the words themselves: the Jev
 * path sends `record.stateText` verbatim via the `stateText` override, and the LLMs are handed
 * the same string, so all three engines read the identical text.
 */
export function toDecideInput(record: RecordedDecision): DecideInput {
  return {
    persona: record.persona,
    goal: record.goal,
    state: record.state,
    options: record.options,
    history: record.history,
    repeats: record.repeats,
    seenText: record.seenText,
  };
}

export function sampleDistribution(choices: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const choice of choices) counts[choice] = (counts[choice] ?? 0) + 1;
  const distribution: Record<string, number> = {};
  for (const [id, count] of Object.entries(counts)) distribution[id] = count / choices.length;
  return distribution;
}

/**
 * Mean L1 over every unordered pair of the distributions. With two repeats this is the single
 * distance between them; with Jev's three it averages all three pairs, which is a steadier
 * read on stability than any one pair. Fewer than two distributions has no pair and returns null.
 */
export function meanPairwiseL1(distributions: Array<Record<string, number>>): number | null {
  const distances: number[] = [];
  for (let i = 0; i < distributions.length; i += 1) {
    for (let k = i + 1; k < distributions.length; k += 1) {
      distances.push(l1Distance(distributions[i]!, distributions[k]!));
    }
  }
  return distances.length === 0 ? null : mean(distances);
}

/**
 * `argmaxOf` from the engine, which breaks ties by id exactly as the bench needs, plus the one
 * case the engine never meets: every sample of a state was rejected, leaving nothing to rank.
 */
export function argmaxOrEmpty(distribution: Record<string, number>): string {
  return Object.keys(distribution).length === 0 ? '' : argmaxOf(distribution);
}

/**
 * Highest probability, ties broken by the order the options were offered in rather than
 * alphabetically: on a tie the option the persona would have read first wins, which is the
 * only ordering that means anything to the page. Null when the distribution is empty.
 *
 * This is the tie-break used for every reference comparison. The plain argmax keeps its
 * alphabetical rule for the places that have no option order to appeal to.
 */
export function argmaxInOptionOrder(
  distribution: Record<string, number>,
  optionOrder: string[],
): string | null {
  const rank = (id: string): number => {
    const index = optionOrder.indexOf(id);
    return index === -1 ? optionOrder.length : index;
  };
  let best: string | null = null;
  let bestP = -1;
  for (const [id, p] of Object.entries(distribution)) {
    if (p > bestP || (p === bestP && best !== null && rank(id) < rank(best))) {
      best = id;
      bestP = p;
    }
  }
  return best;
}

/**
 * The most frequent choice. Defined as the argmax of the distribution those choices make, so
 * the mode and every later argmax of the same distribution cannot disagree about a tie —
 * which is what made Sonnet look as though it disagreed with its own reference.
 */
export function modeOf(choices: string[], optionOrder: string[]): string | null {
  if (choices.length === 0) return null;
  return argmaxInOptionOrder(sampleDistribution(choices), optionOrder);
}

export function costUsd(
  engine: BenchEngineName,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = PRICES[engine];
  return (
    (inputTokens / 1_000_000) * price.inputPerM + (outputTokens / 1_000_000) * price.outputPerM
  );
}

/** Mean of the values that exist; null when none do, so a missing engine never reads as zero. */
function meanOrNull(values: number[]): number | null {
  return values.length === 0 ? null : mean(values);
}

/** One LLM call's outcome. `answer` is null when the call produced nothing usable. */
export interface LlmSample {
  answer: { choice: string; goalMet: number; confusion: number } | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsableSample {
  choice: string;
  goalMet: number;
  confusion: number;
}

/**
 * The one filter both callers use, so the replay and the `--e2e` adapter agree on what counts.
 * A sample is discarded when the call produced no answer (truncated, no text block, unparseable)
 * or when the model named something it was not offered — the schema's `enum` should prevent the
 * second, and counting it is how we would find out that it did not.
 */
export function usableSamples(
  samples: LlmSample[],
  offered: Option[],
): { usable: UsableSample[]; invalid: number } {
  const ids = new Set(offered.map((o) => o.id));
  const usable: UsableSample[] = [];
  let invalid = 0;
  for (const sample of samples) {
    if (sample.answer && ids.has(sample.answer.choice)) usable.push(sample.answer);
    else invalid += 1;
  }
  return { usable, invalid };
}

export interface EngineStateResult {
  /** The engine's main distribution for this state: the first sample set. */
  distribution: Record<string, number>;
  /**
   * Every independent distribution measured for this state, `distribution` first. Repeat
   * stability is the mean pairwise L1 over these, so it needs at least two: Jev always has
   * three, an LLM has two only under `--repeat` and one otherwise.
   */
  repeatDistributions: Array<Record<string, number>>;
  argmax: string;
  /** Sonnet only: the mode of its five samples, the reference the other engines are scored against. */
  referenceArgmax?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Samples thrown away as unusable. Zero for Jev, which does not sample. */
  invalidSamples: number;
}

export interface StateResult {
  /** `<runId>#<step>`, the key a `labels.json` entry uses. */
  stateId: string;
  /**
   * The option ids this state offered, in the order the persona saw them. Every engine on a
   * state sees the same list, so it lives here and not per engine. Reference comparisons break
   * ties with it; when it is absent they fall back to each engine's own alphabetical argmax.
   */
  optionOrder?: string[];
  engines: Partial<Record<BenchEngineName, EngineStateResult>>;
}

export interface EngineSummary {
  /** States this engine actually produced a result for. Not the call count. */
  states: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  invalidSamples: number;
  /** Mean pairwise L1 between this state's repeats, averaged over states; null when not measured. */
  repeatL1: number | null;
  /** Share of states where this engine's argmax equals Sonnet's sample mode. */
  referenceAgreement: number | null;
  /** Mean L1 between this engine's distribution and Sonnet's. */
  l1VsReference: number | null;
  /** Share of argmaxes inside the hand-labelled acceptable set; null with no labels. */
  labelAccuracy: number | null;
}

export interface PairSummary {
  a: BenchEngineName;
  b: BenchEngineName;
  meanL1: number;
  argmaxAgreement: number;
}

export interface BenchStateError {
  stateId: string;
  error: string;
}

export interface BenchReport {
  states: number;
  engines: BenchEngineName[];
  perEngine: Partial<Record<BenchEngineName, EngineSummary>>;
  /** Every unordered pair of the engines that ran, so L1(Jev, Haiku) is always reported. */
  pairs: PairSummary[];
  perState: Array<{
    stateId: string;
    reference: string | null;
    argmax: Partial<Record<BenchEngineName, string>>;
    l1VsReference: Partial<Record<BenchEngineName, number>>;
    invalidSamples: Partial<Record<BenchEngineName, number>>;
  }>;
  /** States whose calls threw. The run continues past them and exits non-zero at the end. */
  errors: BenchStateError[];
  e2e?: Array<{
    engine: BenchEngineName;
    needMet: boolean | null;
    steps: number;
    wallMs: number;
    costUsd: number;
  }>;
}

export interface AggregateOptions {
  labels?: Record<string, string[]>;
  engines?: BenchEngineName[];
  errors?: BenchStateError[];
}

export function aggregate(states: StateResult[], options: AggregateOptions = {}): BenchReport {
  const engines = options.engines ?? [...BENCH_ENGINES];
  const labels = options.labels;
  // A reference exists only when Sonnet was asked for AND actually answered somewhere. Listing
  // Sonnet and having every one of its calls fail is not a reference, and every column that
  // depends on one then reads n/a rather than re-anchoring on whichever engine did run.
  const hasReference =
    engines.includes('sonnet') && states.some((s) => s.engines.sonnet !== undefined);

  /**
   * The reference choice for a state, or null when there isn't one. A state where every Sonnet
   * sample was invalid has an empty distribution and therefore an empty-string argmax: that is
   * the absence of an answer, not an answer, so it must not be matched against an engine that
   * also has nothing. Such a state is excluded from every reference average and reads n/a.
   */
  const referenceOf = (s: StateResult): string | null => {
    if (!hasReference) return null;
    const sonnet = s.engines.sonnet;
    if (!sonnet) return null;
    const pick = sonnet.referenceArgmax ?? sonnet.argmax;
    return pick === '' ? null : pick;
  };

  /**
   * The choice an engine is scored with against the reference. When the state records its
   * option order this re-derives the argmax with the same tie-break the reference used, so a
   * 2-2 tie cannot make Sonnet disagree with its own sample mode.
   */
  const scoredArgmaxOf = (s: StateResult, engine: BenchEngineName): string | null => {
    const result = s.engines[engine];
    if (!result) return null;
    const pick = s.optionOrder
      ? argmaxInOptionOrder(result.distribution, s.optionOrder)
      : result.argmax;
    return pick === '' || pick === null ? null : pick;
  };

  const perEngine: Partial<Record<BenchEngineName, EngineSummary>> = {};
  for (const engine of engines) {
    const results = states
      .map((s) => s.engines[engine])
      .filter((r): r is EngineStateResult => r !== undefined);
    if (results.length === 0) continue;

    const inputTokens = results.reduce((s, r) => s + r.inputTokens, 0);
    const outputTokens = results.reduce((s, r) => s + r.outputTokens, 0);
    // Only the states a label covers count towards label accuracy, so a partial labels.json
    // is still usable and an empty one reads as "no labels" rather than as zero accuracy.
    const labelled = labels
      ? states.filter((s) => labels[s.stateId] !== undefined && s.engines[engine])
      : [];
    // Every average below is taken over the states that have the data, never over all states:
    // a state this engine has no result for must not be folded in as a zero.
    const repeats = results
      .map((r) => meanPairwiseL1(r.repeatDistributions))
      .filter((d): d is number => d !== null);
    const agreements = states
      .filter((s) => referenceOf(s) !== null && scoredArgmaxOf(s, engine) !== null)
      .map((s) => (scoredArgmaxOf(s, engine) === referenceOf(s) ? 1 : 0));
    // Same guard as `referenceOf`: a state where every Sonnet sample was invalid has an empty
    // distribution, which is the absence of a reference, not a reference of zero distance.
    const referenceDistances = hasReference
      ? states
          .filter(
            (s) =>
              s.engines[engine] !== undefined &&
              s.engines.sonnet !== undefined &&
              referenceOf(s) !== null,
          )
          .map((s) => l1Distance(s.engines[engine]!.distribution, s.engines.sonnet!.distribution))
      : [];

    perEngine[engine] = {
      states: results.length,
      medianLatencyMs: percentile(
        results.map((r) => r.latencyMs),
        50,
      ),
      p95LatencyMs: percentile(
        results.map((r) => r.latencyMs),
        95,
      ),
      inputTokens,
      outputTokens,
      totalCostUsd: costUsd(engine, inputTokens, outputTokens),
      invalidSamples: results.reduce((s, r) => s + r.invalidSamples, 0),
      repeatL1: meanOrNull(repeats),
      referenceAgreement: meanOrNull(agreements),
      l1VsReference: meanOrNull(referenceDistances),
      // `scoredArgmaxOf`, not the raw argmax: a hand label is written against the option the
      // persona would have read first on a tie, the same tie-break the reference comparison
      // uses, so this cannot disagree with `referenceAgreement` about the same tie.
      labelAccuracy:
        labelled.length === 0
          ? null
          : labelled.filter((s) => {
              const pick = scoredArgmaxOf(s, engine);
              return pick !== null && labels![s.stateId]!.includes(pick);
            }).length / labelled.length,
    };
  }

  const ordered = [...BENCH_ENGINES].filter((e) => engines.includes(e));
  const pairs: PairSummary[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    for (let k = i + 1; k < ordered.length; k += 1) {
      const a = ordered[i]!;
      const b = ordered[k]!;
      const both = states.filter((s) => s.engines[a] && s.engines[b]);
      if (both.length === 0) continue;
      // `scoredArgmaxOf` for both sides, same tie-break as the reference comparison, and a
      // state where either side's distribution is empty (no usable pick) is excluded rather
      // than counted as agreement.
      const bothScored = both.filter(
        (s) => scoredArgmaxOf(s, a) !== null && scoredArgmaxOf(s, b) !== null,
      );
      pairs.push({
        a,
        b,
        meanL1: mean(
          both.map((s) => l1Distance(s.engines[a]!.distribution, s.engines[b]!.distribution)),
        ),
        argmaxAgreement: mean(
          bothScored.map((s) => (scoredArgmaxOf(s, a) === scoredArgmaxOf(s, b) ? 1 : 0)),
        ),
      });
    }
  }

  return {
    states: states.length,
    engines: ordered,
    perEngine,
    pairs,
    errors: options.errors ?? [],
    perState: states.map((s) => {
      const argmax: Partial<Record<BenchEngineName, string>> = {};
      const l1VsReference: Partial<Record<BenchEngineName, number>> = {};
      const invalidSamples: Partial<Record<BenchEngineName, number>> = {};
      for (const engine of ordered) {
        const result = s.engines[engine];
        if (!result) continue;
        argmax[engine] = result.argmax;
        invalidSamples[engine] = result.invalidSamples;
        if (hasReference && s.engines.sonnet) {
          l1VsReference[engine] = l1Distance(result.distribution, s.engines.sonnet.distribution);
        }
      }
      return {
        stateId: s.stateId,
        reference: referenceOf(s),
        argmax,
        l1VsReference,
        invalidSamples,
      };
    }),
  };
}

const usd = (n: number): string => `$${n.toFixed(4)}`;
const pct = (n: number | null): string => (n === null ? 'n/a' : `${(n * 100).toFixed(0)}%`);
const num = (n: number | null | undefined): string =>
  n === null || n === undefined ? 'n/a' : n.toFixed(3);

export function renderMarkdown(report: BenchReport): string {
  const lines: string[] = [`# Decide benchmark — ${report.states} states`, ''];
  lines.push(
    'All calls are sequential, so the latency below is per call and never a concurrency artefact.',
    'Per state: Jev 3 calls, Haiku 5, Sonnet 5.',
    '',
  );

  lines.push('## Cost and latency', '');
  lines.push('| engine | states | median ms | p95 ms | input tok | output tok | invalid | cost |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const engine of report.engines) {
    const s = report.perEngine[engine];
    if (!s) continue;
    lines.push(
      `| ${engine} | ${s.states} | ${s.medianLatencyMs} | ${s.p95LatencyMs} | ${s.inputTokens} | ${s.outputTokens} | ${s.invalidSamples} | ${usd(s.totalCostUsd)} |`,
    );
  }

  lines.push(
    '',
    '## Repeat stability',
    '',
    'Mean pairwise L1 between the independent distributions measured for the same state. Lower is steadier. Jev is always repeated three times, which gives three pairs; the LLMs are repeated only under `--repeat`, which gives one.',
    '',
  );
  lines.push('| engine | mean repeat L1 |');
  lines.push('| --- | --- |');
  for (const engine of report.engines)
    lines.push(`| ${engine} | ${num(report.perEngine[engine]?.repeatL1 ?? null)} |`);

  lines.push(
    '',
    '## Agreement with the Sonnet reference',
    '',
    "There is no ground truth here. The reference is Sonnet's sample mode — the most frequent of its five samples — which is stochastic: it is a reference point, not a correct answer, and another run may pick differently.",
    '',
  );
  lines.push('| engine | argmax agreement | mean L1 vs Sonnet | hand-label accuracy |');
  lines.push('| --- | --- | --- | --- |');
  for (const engine of report.engines) {
    const s = report.perEngine[engine];
    if (!s) continue;
    lines.push(
      `| ${engine} | ${pct(s.referenceAgreement)} | ${num(s.l1VsReference)} | ${pct(s.labelAccuracy)} |`,
    );
  }

  lines.push(
    '',
    '## Pairwise distance',
    '',
    'Every pair of engines that ran, so the two cheap engines are compared to each other and not only to Sonnet.',
    '',
  );
  lines.push('| pair | mean L1 | argmax agreement |');
  lines.push('| --- | --- | --- |');
  for (const pair of report.pairs) {
    lines.push(
      `| ${pair.a} vs ${pair.b} | ${pair.meanL1.toFixed(3)} | ${pct(pair.argmaxAgreement)} |`,
    );
  }

  lines.push('', '## Per state', '');
  lines.push(
    `| state | reference | ${report.engines.join(' | ')} | ${report.engines.map((e) => `L1 ${e}`).join(' | ')} |`,
  );
  lines.push(
    `| --- | --- | ${report.engines.map(() => '---').join(' | ')} | ${report.engines.map(() => '---').join(' | ')} |`,
  );
  for (const s of report.perState) {
    const picks = report.engines.map((e) => s.argmax[e] ?? '—').join(' | ');
    const distances = report.engines.map((e) => num(s.l1VsReference[e])).join(' | ');
    lines.push(`| ${s.stateId} | ${s.reference ?? 'n/a'} | ${picks} | ${distances} |`);
  }

  if (report.errors.length > 0) {
    lines.push('', '## Errors', '', 'These states are missing from every table above.', '');
    lines.push('| state | error |');
    lines.push('| --- | --- |');
    for (const row of report.errors) lines.push(`| ${row.stateId} | ${row.error} |`);
  }

  if (report.e2e) {
    lines.push('', '## End to end (books.toscrape smoke, 6 steps, seed 1)', '');
    lines.push('| engine | needMet | steps | wall ms | cost |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const row of report.e2e) {
      lines.push(
        `| ${row.engine} | ${String(row.needMet)} | ${row.steps} | ${row.wallMs} | ${usd(row.costUsd)} |`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * The schema for one call. `choice` is an `enum` of exactly the ids this state offered, so the
 * model cannot name something that is not on the page; `usableSamples` still checks, because a
 * schema the API did not honour is worth counting rather than trusting.
 */
export function decideSchema(options: Option[]): Record<string, unknown> {
  const ids = options.map((o) => o.id);
  return {
    type: 'object',
    additionalProperties: false,
    required: ['choice', 'goalMet', 'confusion'],
    properties: {
      choice: {
        type: 'string',
        // An empty enum is not a legal schema, and a state with no options is a bug elsewhere.
        ...(ids.length > 0 ? { enum: ids } : {}),
        description: 'The id of the single option you would take next.',
      },
      goalMet: {
        type: 'number',
        description: 'Probability from 0 to 1 that the goal is already met.',
      },
      confusion: {
        type: 'integer',
        // An enum, not minimum/maximum: structured output rejects numeric bounds on an integer
        // with `For 'integer' type, properties maximum, minimum are not supported`, which failed
        // every state of the first live run.
        enum: [0, 1, 2, 3, 4],
        description:
          '0 obvious what to do, 1 mostly clear, 2 some hesitation, 3 confusing, 4 lost.',
      },
    },
  };
}

const BENCH_SYSTEM =
  'You are the persona described in the state. Pick the single option you would take next ' +
  'toward the goal, given what you can see and read, and your history on this page. ' +
  'Answer only with the JSON object the schema describes.';

function optionList(options: Option[]): string {
  return options.map((option) => `- ${option.id}: ${option.description}`).join('\n');
}

/**
 * One structured-output call on the recorded state text — the same words `buildRequest` puts
 * in Jev's `state` field. Haiku samples at `temperature: 1`. Sonnet 5 rejects `temperature`
 * entirely, so it samples at its own default and `effort: 'low'` keeps it quick; `thinking` is
 * omitted on both and the model default applies.
 *
 * A call that comes back truncated, without a text block, or with a body that is not the JSON
 * the schema asked for yields `answer: null`. That is a counted sample, not an exception: one
 * bad sample out of five is a data point about the model, not a reason to lose the state.
 */
async function callClaude(
  client: Anthropic,
  engine: 'haiku' | 'sonnet',
  stateText: string,
  options: Option[],
): Promise<LlmSample> {
  const model = BENCH_MODELS[engine];
  const outputConfig: Anthropic.OutputConfig = {
    format: { type: 'json_schema', schema: decideSchema(options) },
  };
  if (engine === 'sonnet') outputConfig.effort = SONNET_EFFORT;

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: MAX_TOKENS,
    system: BENCH_SYSTEM,
    output_config: outputConfig,
    messages: [{ role: 'user', content: `${stateText}\n\nYour options:\n${optionList(options)}` }],
  };
  if (engine === 'haiku') params.temperature = 1;

  const started = performance.now();
  const message = await client.messages.create(params);
  const usage = {
    latencyMs: Math.round(performance.now() - started),
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };

  if (message.stop_reason === 'max_tokens') return { answer: null, ...usage };
  const block = message.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') return { answer: null, ...usage };

  try {
    const parsed = JSON.parse(block.text) as {
      choice?: unknown;
      goalMet?: unknown;
      confusion?: unknown;
    };
    if (
      typeof parsed.choice !== 'string' ||
      typeof parsed.goalMet !== 'number' ||
      typeof parsed.confusion !== 'number'
    ) {
      return { answer: null, ...usage };
    }
    return {
      answer: { choice: parsed.choice, goalMet: parsed.goalMet, confusion: parsed.confusion },
      ...usage,
    };
  } catch {
    return { answer: null, ...usage };
  }
}

/**
 * One LLM's numbers for one state: five sequential samples. `--repeat` adds a second set of
 * five so repeat stability can be measured, at double the price. Only Sonnet carries a
 * reference, and it is the mode of its first five samples.
 */
async function benchClaude(
  client: Anthropic,
  engine: 'haiku' | 'sonnet',
  record: RecordedDecision,
  repeat: boolean,
): Promise<EngineStateResult> {
  const optionOrder = record.options.map((o) => o.id);
  const distributions: Array<Record<string, number>> = [];
  const every: LlmSample[] = [];
  let invalid = 0;
  let firstChoices: string[] = [];

  for (let set = 0; set < (repeat ? 2 : 1); set += 1) {
    const samples: LlmSample[] = [];
    for (let i = 0; i < SAMPLES_PER_DISTRIBUTION; i += 1) {
      samples.push(await callClaude(client, engine, record.stateText, record.options));
    }
    every.push(...samples);
    const { usable, invalid: bad } = usableSamples(samples, record.options);
    invalid += bad;
    const choices = usable.map((u) => u.choice);
    if (set === 0) firstChoices = choices;
    distributions.push(sampleDistribution(choices));
  }

  const distribution = distributions[0]!;
  const reference = engine === 'sonnet' ? modeOf(firstChoices, optionOrder) : null;
  return {
    distribution,
    repeatDistributions: distributions,
    argmax: argmaxOrEmpty(distribution),
    ...(reference !== null ? { referenceArgmax: reference } : {}),
    latencyMs: percentile(
      every.map((a) => a.latencyMs),
      50,
    ),
    inputTokens: every.reduce((s, a) => s + a.inputTokens, 0),
    outputTokens: every.reduce((s, a) => s + a.outputTokens, 0),
    invalidSamples: invalid,
  };
}

/**
 * Jev on a recorded state, three sequential runs. The recorded `stateText` is sent verbatim
 * through the `stateText` override rather than re-rendered, so the replay measures the request
 * that was actually made; the unit test pins that the bytes on the wire are the recorded ones.
 */
export async function benchJev(
  engine: JevEngine,
  record: RecordedDecision,
): Promise<EngineStateResult> {
  const input = toDecideInput(record);
  const runs: RawDecision[] = [];
  for (let i = 0; i < JEV_REPEATS; i += 1) {
    runs.push(await engine.decide(input, { stateText: record.stateText }));
  }
  const distributions = runs.map((r) => r.distribution);
  return {
    distribution: distributions[0]!,
    repeatDistributions: distributions,
    argmax: argmaxOrEmpty(distributions[0]!),
    latencyMs: percentile(
      runs.map((r) => r.latencyMs),
      50,
    ),
    inputTokens: runs.reduce((s, r) => s + r.inputTokens, 0),
    // Jev reports no output tokens and its price table charges none.
    outputTokens: 0,
    // Jev's own parser rejects an unoffered id before it reaches here.
    invalidSamples: 0,
  };
}

/**
 * A `DecideEngine` backed by Claude, for `--e2e` only. It lives in this script on purpose:
 * the product has exactly one decide engine, and a second one in `engine/` would become a
 * supported feature the moment it was importable from there.
 */
class BenchClaudeEngine implements DecideEngine {
  inputTokens = 0;
  outputTokens = 0;
  invalidSamples = 0;

  constructor(
    private readonly client: Anthropic,
    private readonly engine: 'haiku' | 'sonnet',
  ) {}

  async decide(input: DecideInput): Promise<RawDecision> {
    const stateText = renderStateText(input);
    const samples: LlmSample[] = [];
    for (let i = 0; i < SAMPLES_PER_DISTRIBUTION; i += 1) {
      samples.push(await callClaude(this.client, this.engine, stateText, input.options));
    }
    for (const sample of samples) {
      this.inputTokens += sample.inputTokens;
      this.outputTokens += sample.outputTokens;
    }
    const { usable, invalid } = usableSamples(samples, input.options);
    this.invalidSamples += invalid;
    if (usable.length === 0) {
      throw new Error(
        `${BENCH_MODELS[this.engine]} produced no usable sample for the offered options`,
      );
    }
    return {
      distribution: sampleDistribution(usable.map((u) => u.choice)),
      goalMet: mean(usable.map((u) => u.goalMet)),
      confusion: Math.round(mean(usable.map((u) => u.confusion))),
      latencyMs: percentile(
        samples.map((a) => a.latencyMs),
        50,
      ),
      stateChars: stateText.length,
      inputTokens: samples.reduce((s, a) => s + a.inputTokens, 0),
      offeredOptions: input.options,
      stateText,
    };
  }
}

interface LoadedState {
  stateId: string;
  record: RecordedDecision;
}

/** Every `<runId>/decisions/step-NN.json` under the input root, in run then step order. */
export async function loadRecordedStates(root: string): Promise<LoadedState[]> {
  const out: LoadedState[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name, 'decisions');
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const record = JSON.parse(await readFile(path.join(dir, file), 'utf-8')) as RecordedDecision;
      out.push({ stateId: `${record.runId}#${record.step}`, record });
    }
  }
  return out;
}

/** Evenly spaced across the whole set, so one long journey cannot dominate the sample. */
export function sampleStates<T>(states: T[], count: number): T[] {
  if (states.length <= count) return states;
  const step = states.length / count;
  return Array.from({ length: count }, (_, i) => states[Math.floor(i * step)]!);
}

function parseEngines(value: string | undefined): BenchEngineName[] {
  if (!value) return [...BENCH_ENGINES];
  const wanted = value.split(',').map((s) => s.trim());
  const unknown = wanted.filter((s) => !(BENCH_ENGINES as readonly string[]).includes(s));
  if (unknown.length > 0) throw new Error(`--engines: unknown engine ${unknown.join(', ')}`);
  return [...BENCH_ENGINES].filter((e) => wanted.includes(e));
}

/**
 * Hand labels, when there are any. A missing file means "no labels" and is normal. A file that
 * is there but unreadable or malformed stops the run: silently scoring against no labels when
 * labels were meant to apply would quietly change what the benchmark measured.
 */
export async function loadLabels(root: string): Promise<Record<string, string[]> | undefined> {
  const file = path.join(root, 'labels.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw) as Record<string, string[]>;
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The smoke journey the live acceptance doc already uses, so the numbers are comparable. */
export const E2E_URL = 'https://books.toscrape.com/';
export const E2E_NEED = 'Find a Travel category book priced under £20 and open its detail page';
export const E2E_SUCCESS_URL = 'catalogue/[^/]+_[0-9]+/index\\.html';
export const E2E_MAX_STEPS = 6;
export const E2E_SEED = 1;

/**
 * One journey per engine, same URL, same goal, same seed, same step budget, run one after the
 * other. `drive()` is called directly, so no report call is made and the cost is the decide
 * calls only.
 */
async function runE2e(client: Anthropic, engines: BenchEngineName[]): Promise<BenchReport['e2e']> {
  const persona = await loadPersona(path.join(PERSONA_DIR, 'anna.yaml'));
  const config: ExploreConfig = {
    url: E2E_URL,
    need: E2E_NEED,
    persona,
    maxSteps: E2E_MAX_STEPS,
    seed: E2E_SEED,
    engine: 'jev',
    successUrl: new RegExp(E2E_SUCCESS_URL),
    output: './reports/',
    format: 'json',
    verbose: false,
    screenshots: false,
    recordDecisions: false,
    report: false,
  };

  if (engines.length > E2E_JOURNEY_CAP)
    throw new Error('--e2e would run more journeys than the cap allows');

  const out: NonNullable<BenchReport['e2e']> = [];
  const browser = await launchBrowser();
  try {
    for (const name of engines) {
      const engine = name === 'jev' ? new JevEngine() : new BenchClaudeEngine(client, name);
      const started = performance.now();
      const journey = await drive(config, { browser, engine });
      const wallMs = Math.round(performance.now() - started);
      const inputTokens =
        engine instanceof BenchClaudeEngine
          ? engine.inputTokens
          : journey.rows.reduce((s, r) => s + r.inputTokens, 0);
      const outputTokens = engine instanceof BenchClaudeEngine ? engine.outputTokens : 0;
      out.push({
        engine: name,
        needMet: journey.summary.outcome.needMet,
        steps: journey.summary.outcome.totalSteps,
        wallMs,
        costUsd: costUsd(name, inputTokens, outputTokens),
      });
    }
  } finally {
    await browser.close();
  }
  return out;
}

function missingKeys(engines: BenchEngineName[]): string[] {
  const missing: string[] = [];
  if (engines.includes('jev') && !process.env['TYPESAFE_API_KEY']) missing.push('TYPESAFE_API_KEY');
  if (engines.some((e) => e !== 'jev') && !process.env['ANTHROPIC_API_KEY'])
    missing.push('ANTHROPIC_API_KEY');
  return missing;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      states: { type: 'string', default: String(DEFAULT_STATES) },
      engines: { type: 'string' },
      repeat: { type: 'boolean', default: false },
      out: { type: 'string', default: './reports/bench' },
      e2e: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const engines = parseEngines(values.engines);
  const missing = missingKeys(engines);
  if (missing.length > 0) {
    console.error(
      `bench-decide needs these keys in the environment; missing: ${missing.join(', ')}. Skipping.`,
    );
    process.exitCode = 1;
    return;
  }

  const root = positionals[0] ?? './reports';
  // A missing input directory is the same user error as an empty one — a run that was never
  // made with --record-decisions — so it gets the message that names the fix, not an ENOENT.
  const all = await loadRecordedStates(root).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  });
  if (all.length === 0) {
    console.error(
      `No decisions/step-NN.json found under ${root}. Re-run the CLI with --record-decisions.`,
    );
    process.exitCode = 1;
    return;
  }

  // A non-numeric --states would otherwise sample NaN states and produce an empty benchmark
  // that still exits 0, which reads as a run that was made rather than one that never ran.
  const wantedStates = Number.parseInt(values.states ?? String(DEFAULT_STATES), 10);
  if (!Number.isInteger(wantedStates) || wantedStates < 1) {
    console.error(`--states must be a positive whole number; got "${values.states ?? ''}".`);
    process.exitCode = 1;
    return;
  }

  const chosen = sampleStates(all, wantedStates);
  const labels = await loadLabels(root);
  const client = new Anthropic();
  const jev = new JevEngine();
  const repeat = values.repeat ?? false;
  const outDir = values.out ?? './reports/bench';

  const results: StateResult[] = [];
  const errors: BenchStateError[] = [];
  let e2e: BenchReport['e2e'];

  // Written after every state, so an interrupted or partly failed run still leaves a usable
  // benchmark on disk for the states that did finish.
  const flush = async (): Promise<string> => {
    const report = aggregate(results, { ...(labels ? { labels } : {}), engines, errors });
    if (e2e) report.e2e = e2e;
    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.join(outDir, 'bench.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf-8',
    );
    const markdown = renderMarkdown(report);
    await writeFile(path.join(outDir, 'bench.md'), markdown, 'utf-8');
    return markdown;
  };

  for (const { stateId, record } of chosen) {
    try {
      // Sequential on purpose: one engine at a time, so no engine's latency is measured while
      // another engine's calls are in flight.
      const engineResults: Array<[BenchEngineName, EngineStateResult]> = [];
      for (const name of engines) {
        engineResults.push([
          name,
          name === 'jev'
            ? await benchJev(jev, record)
            : await benchClaude(client, name, record, repeat),
        ]);
      }
      results.push({
        stateId,
        optionOrder: record.options.map((o) => o.id),
        engines: Object.fromEntries(engineResults),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ stateId, error: message });
      console.error(`state ${stateId} failed: ${message}`);
    }
    await flush();
    console.error(`state ${stateId} done (${results.length + errors.length}/${chosen.length})`);
  }

  if (values.e2e) e2e = await runE2e(client, engines);

  console.log(await flush());
  if (errors.length > 0) {
    console.error(`${errors.length} of ${chosen.length} states failed; see the Errors table.`);
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && process.argv[1].endsWith('bench-decide.ts');
if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error(`bench-decide failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
