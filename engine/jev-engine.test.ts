import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ERROR_BODY_CHARS,
  JevEngine,
  JevParseError,
  JevUnavailableError,
  JEV_MODEL,
  INTENT_LINE,
  STATE_CHAR_LIMIT,
  StateTooLargeError,
  buildRequest,
  capElementOptions,
  fitToLimit,
  measureChars,
  parseResponse,
  renderPersonaBlock,
  renderStateText,
} from './jev-engine';
import type { DecideInput, HistoryEntry, Option, PageState, PersonaProfile } from './types';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDED = JSON.parse(
  readFileSync(path.join(HERE, '..', 'test', 'fixtures', 'jev-response.json'), 'utf-8'),
) as {
  answers: { next: { probabilities: Record<string, number> } };
  usage: { input_tokens: number };
};

const RECORDED_IDS = Object.keys(RECORDED.answers.next.probabilities);

const OLENA: PersonaProfile = {
  name: 'Olena',
  description: '38, from Kharkiv, in Wrocław since 2022.\nNeeds a CUKR residence card.',
  languages: { native: 'uk', reads: { uk: 'fluent', pl: 'weak', en: 'none' } },
  device: 'mobile',
  techLiteracy: 'low',
  domainLiteracy: 'low',
  patience: 'low',
  intent: 'high',
  facts: { givenName: 'Olena', pesel: '99010112345' },
};

function state(overrides: Partial<PageState['meta']> = {}): PageState {
  return {
    elements: [],
    meta: {
      url: 'https://dopomo.pl/pl',
      title: 'Dopomo',
      lang: 'pl',
      scrollY: 0,
      scrollMax: 1200,
      viewport: { width: 390, height: 844 },
      h1: 'Dopomo',
      mainText: 'Pomagamy w legalizacji pobytu.',
      validationMessages: [],
      langSwitcher: [],
      droppedElements: 4,
      belowFoldSample: ['Blog', 'Kariera'],
      visibleText: [],
      visibleTextDigest: '',
      belowFoldTextChars: 0,
      nonResponsive: false,
      disabledControls: [],
      skippedFrames: 0,
      closedRoots: 0,
      ...overrides,
    },
    stateHash: 'hash-a',
    viewHash: 'view-a',
  };
}

const OPTIONS: Option[] = [
  {
    id: 'el_14',
    kind: 'element',
    description: 'link "Karta CUKR" -> /pl/cukr (visible)',
    elementId: 'el_14',
  },
  { id: 'el_22', kind: 'element', description: 'button "Dalej" (below fold)', elementId: 'el_22' },
  { id: 'scroll_down', kind: 'scroll_down', description: 'scroll down to see more' },
];

const HISTORY: HistoryEntry[] = [
  {
    step: 1,
    viewHash: 'v0',
    actionName: 'clicked',
    targetName: 'Rozpocznij',
    targetHref: '/pl/start',
    outcomeSummary: 'navigated to /pl/start',
  },
];

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    persona: OLENA,
    goal: 'Get a CUKR residence card',
    state: state(),
    options: OPTIONS,
    history: HISTORY,
    repeats: ['you already clicked "Dalej" here 2 times; result: nothing changed'],
    seenText: [],
    ...overrides,
  };
}

function recordedIdOptions(): Option[] {
  return RECORDED_IDS.map((id) => ({
    id,
    kind: 'element' as const,
    description: `link "${id}"`,
    elementId: id,
  }));
}

/**
 * Pad the goal until the request sits exactly `over` chars past the limit. Measured rather
 * than guessed, so a change to the persona block or the question text cannot silently turn
 * this into a test of nothing.
 */
function overBy(over: number, overrides: Partial<DecideInput>): DecideInput {
  const base = input({ ...overrides, goal: '' });
  const room = STATE_CHAR_LIMIT - measureChars(buildRequest(base));
  return { ...base, goal: 'g'.repeat(room + over) };
}

describe('renderPersonaBlock', () => {
  it('renders name, description, languages, device, literacy and the page language line', () => {
    const block = renderPersonaBlock(OLENA, 'pl');
    expect(block).toContain('Olena');
    expect(block).toContain('38, from Kharkiv');
    expect(block).toContain('Native language: uk. Reads: pl weak, en none.');
    expect(block).toContain('Device: mobile phone');
    expect(block).toContain('Tech literacy: low. Bureaucracy literacy: low. Patience: low.');
    expect(block).toContain('This page is in pl; you read pl weak');
  });

  it('never renders the persona facts', () => {
    const block = renderPersonaBlock(OLENA, 'pl');
    expect(block).not.toContain('99010112345');
    expect(block).not.toContain('pesel');
  });

  it('omits the reads clause for a persona who reads only their native language', () => {
    const monolingual: PersonaProfile = {
      ...OLENA,
      languages: { native: 'pl', reads: { pl: 'fluent' } },
    };
    const block = renderPersonaBlock(monolingual, 'pl');
    expect(block).toContain('Native language: pl.');
    expect(block).not.toContain('Reads:');
    expect(block).toContain('This page is in pl; you read pl fluent');
  });

  it('reads a region-tagged page language as its primary subtag', () => {
    // A `lang="pl-PL"` document must not read as a language nobody in the roster speaks.
    const anna: PersonaProfile = {
      ...OLENA,
      name: 'Anna',
      languages: { native: 'pl', reads: { pl: 'fluent', en: 'ok' } },
    };
    const block = renderPersonaBlock(anna, 'pl-PL');
    expect(block).toContain('This page is in pl; you read pl fluent');
    expect(block).not.toContain('pl-PL');
    expect(block).not.toContain('you read pl none');
  });

  it('treats an unusable language tag as an unknown language', () => {
    expect(renderPersonaBlock(OLENA, 'x-default')).toContain('This page is in an unknown language');
  });
});

describe('renderStateText', () => {
  it('orders persona, goal, page meta, history and repeat lines, and never repeats elements', () => {
    const text = renderStateText(input());
    const at = (needle: string): number => text.indexOf(needle);
    expect(at('Native language')).toBeLessThan(at('Get a CUKR residence card'));
    expect(at('Get a CUKR residence card')).toBeLessThan(at('https://dopomo.pl/pl'));
    expect(at('https://dopomo.pl/pl')).toBeLessThan(at('navigated to /pl/start'));
    expect(at('navigated to /pl/start')).toBeLessThan(at('you already clicked'));
    expect(text).toContain('4 more interactive elements were not listed');
    expect(text).toContain('Blog');
    expect(text).not.toContain('Karta CUKR');
  });

  it('sends at most the last 10 history entries', () => {
    const long = Array.from({ length: 14 }, (_, i) => ({
      ...HISTORY[0]!,
      step: i + 1,
      outcomeSummary: `step-${i + 1}`,
    }));
    const text = renderStateText(input({ history: long }));
    expect(text).not.toContain('step-4');
    expect(text).toContain('step-5');
    expect(text).toContain('step-14');
  });

  it('puts the state in spec order, and still sends no elements', () => {
    const text = renderStateText(
      input({
        state: state({
          visibleText: [{ text: '[h1] Dopomo', landmark: 'main', inAriaLive: false }],
        }),
      }),
    );
    const at = (needle: string): number => text.indexOf(needle);
    expect(at('https://dopomo.pl/pl')).toBeLessThan(at('On screen now:'));
    expect(at('On screen now:')).toBeLessThan(at('navigated to /pl/start'));
    expect(text).not.toContain('Karta CUKR');
    expect(text).not.toContain('scroll down to see more');
  });

  it('names the controls that are disabled right now, so the gate is understandable', () => {
    const text = renderStateText(
      input({ state: state({ disabledControls: ['Далі →', 'Довідка'] }) }),
    );
    expect(text).toContain('Disabled right now: "Далі →", "Довідка"');
  });

  it('leaves the disabled line out when nothing is disabled', () => {
    expect(renderStateText(input())).not.toContain('Disabled right now');
  });
});

describe('buildRequest', () => {
  it('uses the recorded request shape', () => {
    const req = buildRequest(input());
    expect(req.model).toBe(JEV_MODEL);
    expect(req.questions.next.type).toBe('choice');
    expect(req.questions.next.criteria).toEqual({
      el_14: 'link "Karta CUKR" -> /pl/cukr (visible)',
      el_22: 'button "Dalej" (below fold)',
      scroll_down: 'scroll down to see more',
    });
    expect(req.questions.goalMet.type).toBe('noul');
    expect(req.questions.confusion.criteria).toEqual([
      'obvious what to do',
      'mostly clear',
      'some hesitation',
      'confusing',
      'lost',
    ]);
  });
});

describe('fitToLimit', () => {
  it('leaves a normal request untouched', () => {
    const fitted = fitToLimit(input());
    expect(fitted.options).toHaveLength(3);
    expect(fitted.history).toHaveLength(1);
  });

  it('drops element options past 20, then history to 5, before giving up', () => {
    const fat = 'x'.repeat(1600);
    const many: Option[] = Array.from({ length: 30 }, (_, i) => ({
      id: `el_${i}`,
      kind: 'element' as const,
      description: `${fat}-${i}`,
      elementId: `el_${i}`,
    }));
    const longHistory: HistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
      ...HISTORY[0]!,
      step: i + 1,
      outcomeSummary: fat,
    }));
    const fitted = fitToLimit(input({ options: many, history: longHistory }));
    expect(fitted.options).toHaveLength(20);
    expect(fitted.history).toHaveLength(5);
    expect(measureChars(buildRequest(fitted))).toBeLessThanOrEqual(STATE_CHAR_LIMIT);
  });

  it('never drops the meta actions that let the persona leave the page', () => {
    const fat = 'x'.repeat(1600);
    const many: Option[] = [
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `el_${i}`,
        kind: 'element' as const,
        description: `${fat}-${i}`,
        elementId: `el_${i}`,
      })),
      { id: 'scroll_down', kind: 'scroll_down' as const, description: 'scroll down to see more' },
      { id: 'back', kind: 'back' as const, description: 'go back to the previous page' },
      { id: 'leave', kind: 'leave' as const, description: 'leave this site' },
    ];
    const fitted = fitToLimit(input({ options: many }));
    const ids = fitted.options.map((o) => o.id);
    expect(ids).toContain('scroll_down');
    expect(ids).toContain('back');
    expect(ids).toContain('leave');
    expect(fitted.options.filter((o) => o.kind === 'element')).toHaveLength(20);
  });

  it('throws StateTooLargeError when even the reduced request is over the limit', () => {
    const huge: Option[] = Array.from({ length: 20 }, (_, i) => ({
      id: `el_${i}`,
      kind: 'element' as const,
      description: 'y'.repeat(5000),
      elementId: `el_${i}`,
    }));
    expect(() => fitToLimit(input({ options: huge }))).toThrow(StateTooLargeError);
  });
});

describe('capElementOptions', () => {
  it('keeps meta actions and caps only the element-ish options', () => {
    const options: Option[] = [
      { id: 'el_01', kind: 'element', description: 'a', elementId: 'el_01' },
      { id: 'el_02', kind: 'element', description: 'b', elementId: 'el_02' },
      { id: 'type:el_03', kind: 'type', description: 'c', elementId: 'el_03', value: 'x' },
      { id: 'scroll_down', kind: 'scroll_down', description: 'scroll' },
      { id: 'leave', kind: 'leave', description: 'leave this site' },
    ];
    expect(capElementOptions(options, 2).map((o) => o.id)).toEqual([
      'el_01',
      'el_02',
      'scroll_down',
      'leave',
    ]);
  });
});

describe('parseResponse', () => {
  it('reads the recorded response into a RawDecision', () => {
    const offered = recordedIdOptions();
    const raw = parseResponse(RECORDED, RECORDED_IDS, 300, 1200, offered);
    expect(raw.distribution).toEqual(RECORDED.answers.next.probabilities);
    expect(Object.values(raw.distribution).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
    expect(raw.goalMet).toBeGreaterThanOrEqual(0);
    expect(raw.goalMet).toBeLessThanOrEqual(1);
    expect(raw.confusion).toBeGreaterThanOrEqual(0);
    expect(raw.confusion).toBeLessThanOrEqual(4);
    expect(raw.latencyMs).toBe(300);
    expect(raw.stateChars).toBe(1200);
    expect(raw.inputTokens).toBe(RECORDED.usage.input_tokens);
    expect(raw.offeredOptions).toBe(offered);
  });

  it('drops probabilities for ids that were not offered and renormalizes', () => {
    const body = {
      answers: {
        next: {
          type: 'choice',
          choice: 'el_01',
          confidence: 0.5,
          probabilities: { el_01: 0.5, ghost: 0.5 },
        },
        goalMet: { type: 'noul', noul: 0 },
        confusion: { type: 'score', score: 1 },
      },
      usage: { input_tokens: 10, output_tokens: 3 },
    };
    expect(parseResponse(body, ['el_01'], 1, 1, []).distribution).toEqual({ el_01: 1 });
  });

  it('clamps out-of-range scores instead of trusting them', () => {
    const body = {
      answers: {
        next: { type: 'choice', choice: 'el_01', probabilities: { el_01: 1 } },
        goalMet: { type: 'noul', noul: 1.4 },
        confusion: { type: 'score', score: 9 },
      },
      usage: { input_tokens: 10, output_tokens: 3 },
    };
    const raw = parseResponse(body, ['el_01'], 1, 1, []);
    expect(raw.goalMet).toBe(1);
    expect(raw.confusion).toBe(4);
  });

  it('throws JevParseError when goalMet or confusion is missing or not a number', () => {
    const base = {
      answers: {
        next: { type: 'choice', choice: 'el_01', probabilities: { el_01: 1 } },
        goalMet: { type: 'noul', noul: 0.1 },
        confusion: { type: 'score', score: 1 },
      },
      usage: { input_tokens: 10, output_tokens: 3 },
    };
    const noGoal = { ...base, answers: { ...base.answers, goalMet: { type: 'noul' } } };
    const badConfusion = {
      ...base,
      answers: { ...base.answers, confusion: { type: 'score', score: 'high' } },
    };
    expect(() => parseResponse(noGoal, ['el_01'], 1, 1, [])).toThrow(JevParseError);
    expect(() => parseResponse(badConfusion, ['el_01'], 1, 1, [])).toThrow(JevParseError);
  });

  it('falls back to next.choice when every offered id carries zero mass', () => {
    const body = {
      answers: {
        next: { type: 'choice', choice: 'el_01', probabilities: { el_01: 0, el_02: 0 } },
        goalMet: { type: 'noul', noul: 0.2 },
        confusion: { type: 'score', score: 2 },
      },
      usage: { input_tokens: 10, output_tokens: 3 },
    };
    const raw = parseResponse(body, ['el_01', 'el_02'], 1, 1, []);
    expect(raw.distribution).toEqual({ el_01: 1 });
    expect(raw.goalMet).toBe(0.2);
    expect(raw.confusion).toBe(2);
  });

  it('throws JevParseError when the mass is zero and next.choice was never offered', () => {
    const body = {
      answers: {
        next: { type: 'choice', choice: 'ghost', probabilities: { el_01: 0 } },
        goalMet: { type: 'noul', noul: 0.2 },
        confusion: { type: 'score', score: 2 },
      },
      usage: { input_tokens: 10, output_tokens: 3 },
    };
    expect(() => parseResponse(body, ['el_01'], 1, 1, [])).toThrow(JevParseError);
    expect(() => parseResponse(body, ['el_01'], 1, 1, [])).toThrow(/no usable choice/);
  });

  it('throws JevParseError naming goalMet when the answers block is empty', () => {
    expect(() => parseResponse({ answers: {} }, ['el_01'], 1, 1, [])).toThrow(JevParseError);
    expect(() => parseResponse({ answers: {} }, ['el_01'], 1, 1, [])).toThrow(/goalMet\.noul/);
  });
});

describe('JevEngine', () => {
  const okResponse = () =>
    new Response(JSON.stringify(RECORDED), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const recordedInput = () => input({ options: recordedIdOptions() });

  it('posts to the systemone endpoint with a bearer token and records what Jev was offered', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => okResponse());
    const engine = new JevEngine({
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const raw = await engine.decide(recordedInput());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(raw.offeredOptions.map((o) => o.id)).toEqual(RECORDED_IDS);
    expect(raw.stateChars).toBeGreaterThan(0);
  });

  it('sends a supplied stateText verbatim instead of rendering the input', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => okResponse());
    const engine = new JevEngine({
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const override = 'a recorded state text that no render of this input would ever produce';

    const raw = await engine.decide(recordedInput(), { stateText: override });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1].body)) as { state: string };
    expect(body.state).toBe(override);
    // stateChars is measured after the substitution, so it describes what actually went out.
    expect(raw.stateChars).toBeLessThan(measureChars(buildRequest(recordedInput())));
  });

  it('renders the input as usual when no stateText override is given', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => okResponse());
    const engine = new JevEngine({
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await engine.decide(recordedInput());

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1].body)) as { state: string };
    expect(body.state).toBe(buildRequest(fitToLimit(recordedInput())).state);
  });

  it('records a copy of the offered options, not the array it was handed', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const engine = new JevEngine({
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const options = recordedIdOptions();
    const raw = await engine.decide(input({ options }));
    expect(raw.offeredOptions).not.toBe(options);
    expect(raw.offeredOptions).toEqual(options);
  });

  it('records the shrunken option list when the size guard trims the request', async () => {
    const fat = 'x'.repeat(1600);
    const many: Option[] = Array.from({ length: 30 }, (_, i) => ({
      id: `el_${i}`,
      kind: 'element' as const,
      description: `${fat}-${i}`,
      elementId: `el_${i}`,
    }));
    const body = {
      answers: {
        next: { type: 'choice', choice: 'el_0', probabilities: { el_0: 1 } },
        goalMet: { type: 'noul', noul: 0 },
        confusion: { type: 'score', score: 1 },
      },
      usage: { input_tokens: 9000, output_tokens: 20 },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const engine = new JevEngine({
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const raw = await engine.decide(input({ options: many }));
    expect(raw.offeredOptions).toHaveLength(20);
  });

  it('exposes the fitted state text actually sent, not a pre-fit render of the input', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const engine = new JevEngine({
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const padded = overBy(500, { options: recordedIdOptions(), seenText: ['s'.repeat(900)] });

    const raw = await engine.decide(padded);

    expect(raw.stateText).toBe(renderStateText(fitToLimit(padded)));
    expect(raw.stateText).not.toBe(renderStateText(padded));
  });

  it('retries 429 and 5xx with 500ms, 1s, 2s backoff and then succeeds', async () => {
    const delays: number[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response('rate limited', { status: 429 });
      if (call === 2) return new Response('boom', { status: 503 });
      return okResponse();
    });
    const engine = new JevEngine({
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await engine.decide(recordedInput());
    expect(delays).toEqual([500, 1000]);
    expect(engine.retryMs).toBe(1500);
  });

  it('retries a timed-out request the way it retries a 5xx', async () => {
    const delays: number[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        const aborted = new Error('The operation was aborted due to timeout');
        aborted.name = 'TimeoutError';
        throw aborted;
      }
      return okResponse();
    });
    const engine = new JevEngine({
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const raw = await engine.decide(recordedInput());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([500]);
    expect(engine.retryMs).toBe(500);
    expect(raw.distribution).toEqual(RECORDED.answers.next.probabilities);
  });

  // --- 3: the whole ladder, not just its first two rungs
  it('throws JevUnavailableError after the final retry and does not retry a 400', async () => {
    const delays: number[] = [];
    const down = vi.fn(async () => new Response('down', { status: 500 }));
    const engineDown = new JevEngine({
      apiKey: 'k',
      fetchImpl: down as unknown as typeof fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await expect(engineDown.decide(recordedInput())).rejects.toBeInstanceOf(JevUnavailableError);
    expect(down).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([500, 1000, 2000]);
    expect(engineDown.retryMs).toBe(3500);

    const bad = vi.fn(async () => new Response('bad request', { status: 400 }));
    const engineBad = new JevEngine({
      apiKey: 'k',
      fetchImpl: bad as unknown as typeof fetch,
      sleep: async () => {},
    });
    await expect(engineBad.decide(recordedInput())).rejects.toBeInstanceOf(JevUnavailableError);
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('clears retryMs from the previous step when the size guard throws', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1 ? new Response('rate limited', { status: 429 }) : okResponse();
    });
    const engine = new JevEngine({
      apiKey: 'test-key',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    await engine.decide(recordedInput());
    expect(engine.retryMs).toBe(500);

    const huge: Option[] = Array.from({ length: 20 }, (_, i) => ({
      id: `el_${i}`,
      kind: 'element' as const,
      description: 'y'.repeat(5000),
      elementId: `el_${i}`,
    }));
    await expect(engine.decide(input({ options: huge }))).rejects.toBeInstanceOf(
      StateTooLargeError,
    );
    expect(engine.retryMs).toBe(0);
  });

  it('wraps a 200 whose body is not JSON in JevParseError', async () => {
    const html = vi.fn(
      async () =>
        new Response('<html><body>Service temporarily unavailable</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    const engine = new JevEngine({
      apiKey: 'k',
      fetchImpl: html as unknown as typeof fetch,
      sleep: async () => {},
    });
    await expect(engine.decide(recordedInput())).rejects.toBeInstanceOf(JevParseError);
    // A transport-level success is not retried: one call, one parse, one failure.
    expect(html).toHaveBeenCalledTimes(1);
  });

  it('puts the error response body in the JevUnavailableError message, truncated', async () => {
    const body = `upstream said: ${'z'.repeat(500)}`;
    const down = vi.fn(async () => new Response(body, { status: 500 }));
    const engine = new JevEngine({
      apiKey: 'k',
      fetchImpl: down as unknown as typeof fetch,
      sleep: async () => {},
    });
    const err = await engine
      .decide(recordedInput())
      .catch((e: unknown) => e as JevUnavailableError);
    expect(err).toBeInstanceOf(JevUnavailableError);
    expect((err as JevUnavailableError).status).toBe(500);
    expect((err as JevUnavailableError).message).toContain('upstream said:');
    expect((err as JevUnavailableError).message).not.toContain('z'.repeat(ERROR_BODY_CHARS + 1));
  });

  it('names the key variable on 401 and 403', async () => {
    for (const status of [401, 403]) {
      const rejected = vi.fn(async () => new Response('{"error":"invalid api key"}', { status }));
      const engine = new JevEngine({
        apiKey: 'k',
        fetchImpl: rejected as unknown as typeof fetch,
        sleep: async () => {},
      });
      const err = await engine
        .decide(recordedInput())
        .catch((e: unknown) => e as JevUnavailableError);
      expect((err as JevUnavailableError).message).toContain('TYPESAFE_API_KEY rejected');
      expect((err as JevUnavailableError).message).toContain('invalid api key');
      expect(rejected).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses to construct without a key', () => {
    const previous = process.env['TYPESAFE_API_KEY'];
    delete process.env['TYPESAFE_API_KEY'];
    expect(() => new JevEngine()).toThrow(JevUnavailableError);
    if (previous !== undefined) process.env['TYPESAFE_API_KEY'] = previous;
  });
});

describe('renderStateText text sections', () => {
  it('renders on-screen blocks and drops the old heading and page-text lines', () => {
    const text = renderStateText(
      input({
        state: state({
          visibleText: [
            { text: '[h1] Отримайте карту CUKR', landmark: 'main', inAriaLive: false },
            { text: 'Безкоштовна перевірка за 2 хвилини.', landmark: 'main', inAriaLive: false },
          ],
        }),
      }),
    );
    expect(text).toContain('On screen now:');
    expect(text).toContain('[h1] Отримайте карту CUKR');
    expect(text).toContain('Безкоштовна перевірка за 2 хвилини.');
    expect(text).not.toContain('Main heading:');
    expect(text).not.toContain('Page text:');
  });

  it('says how much text is below the fold without sending any of it', () => {
    const text = renderStateText(input({ state: state({ belowFoldTextChars: 1840 }) }));
    expect(text).toContain('About 1840 characters of text below');
  });

  it('renders the seen-earlier section, most recent first', () => {
    const text = renderStateText(input({ seenText: ['Third paragraph.', 'Second paragraph.'] }));
    expect(text).toContain('Seen earlier on this page:');
    expect(text.indexOf('Third paragraph.')).toBeLessThan(text.indexOf('Second paragraph.'));
  });

  it('omits both sections when there is nothing to say', () => {
    const text = renderStateText(input());
    expect(text).not.toContain('On screen now:');
    expect(text).not.toContain('Seen earlier on this page:');
  });
});

describe('renderPersonaBlock intent', () => {
  it('renders the intent line from the fixed map', () => {
    expect(renderPersonaBlock({ ...OLENA, intent: 'low' }, 'pl')).toContain(
      `Intent: low ${INTENT_LINE.low}`,
    );
    expect(renderPersonaBlock({ ...OLENA, intent: 'high' }, 'pl')).toContain('Intent: high');
  });
});

describe('fitToLimit trim order', () => {
  const block = (n: number) => ({
    text: 'x'.repeat(n),
    landmark: 'main' as const,
    inAriaLive: false,
  });

  it('drops the seen text before anything else', () => {
    const padded = overBy(100, {
      seenText: ['s'.repeat(900)],
      state: state({ visibleText: [block(400)] }),
    });
    const fitted = fitToLimit(padded);
    expect(fitted.seenText).toEqual([]);
    expect(fitted.state.meta.visibleText).toHaveLength(1);
    expect(fitted.options).toHaveLength(padded.options.length);
    expect(fitted.history).toHaveLength(padded.history.length);
  });

  it('trims on-screen blocks before touching options or history', () => {
    const padded = overBy(1_200, {
      seenText: ['s'.repeat(900)],
      state: state({ visibleText: [block(400), block(400)] }),
    });
    const fitted = fitToLimit(padded);
    expect(fitted.seenText).toEqual([]);
    expect(fitted.state.meta.visibleText.length).toBeLessThan(2);
    expect(fitted.options).toHaveLength(padded.options.length);
    expect(fitted.history).toHaveLength(padded.history.length);
  });
});
