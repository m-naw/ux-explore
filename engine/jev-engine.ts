// engine/jev-engine.ts
// TypeSafe Jev System One decide engine.
// Plain fetch, no SDK. The API key is read from process.env.TYPESAFE_API_KEY only.

import type {
  DecideEngine,
  DecideInput,
  HistoryEntry,
  Option,
  PersonaProfile,
  RawDecision,
} from './types';
import { isTextInput, matchFact } from './typed-input';

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

/** Hard stop on request size. */
export const STATE_CHAR_LIMIT = 45_000;

/** Backoff for 429 and 5xx. */
export const RETRY_DELAYS_MS = [500, 1000, 2000] as const;

/**
 * Per-attempt request timeout. Without it a hung connection stalls the whole journey,
 * since fetch has no default timeout. An abort is retried exactly like a 5xx.
 */
export const FETCH_TIMEOUT_MS = 10_000;

/** Confusion criteria, in spec order. The index is the 0..4 score. */
export const CONFUSION_CRITERIA = [
  'obvious what to do',
  'mostly clear',
  'some hesitation',
  'confusing',
  'lost',
] as const;

export const HISTORY_WINDOW = 10;
export const REDUCED_OPTION_CAP = 20;
export const REDUCED_HISTORY = 5;

const NEXT_INSTRUCTIONS =
  'You are the persona. Pick the single option you would take next toward the goal, ' +
  'given what you can see and read, and your history on this page.';
const GOAL_MET_INSTRUCTIONS =
  'As far as the persona can tell, the goal is already achieved on this page.';
const CONFUSION_INSTRUCTIONS = 'How confusing is this page for this persona, given their goal?';

export interface JevRequest {
  state: string;
  model: string;
  questions: {
    next: { type: 'choice'; instructions: string; criteria: Record<string, string> };
    goalMet: { type: 'noul'; instructions: string };
    confusion: { type: 'score'; instructions: string; criteria: string[] };
  };
}

export class StateTooLargeError extends Error {
  constructor(chars: number) {
    super(`Jev state text is ${chars} chars, over the ${STATE_CHAR_LIMIT} limit`);
    this.name = 'StateTooLargeError';
  }
}

/** The transport worked but the body is not a usable answer. */
export class JevParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JevParseError';
  }
}

export class JevUnavailableError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'JevUnavailableError';
    this.status = status;
  }
}

const DEVICE_LABEL: Record<PersonaProfile['device'], string> = {
  desktop: 'desktop',
  mobile: 'mobile phone',
};

/**
 * The primary subtag of a BCP 47 tag, lowercased: `pl-PL` -> `pl`. `x-default` and anything
 * that is not a two or three letter language code becomes the empty string. The extractor
 * normalizes already; this is the guard for a state built by hand or by an older run.
 */
export function primaryLanguageSubtag(value: string): string {
  const code = (value || '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(code) ? code : '';
}

/**
 * How each intent level is said to the persona. A fixed map, not a number the code applies:
 * intent must not shape the distribution directly, so it reaches Jev only as English.
 */
export const INTENT_LINE: Record<PersonaProfile['intent'], string> = {
  low: '(tapped an ad out of curiosity, undecided, ready to close the tab)',
  medium: '(looking into this, but not committed to finishing today)',
  high: '(came here on purpose and needs this done)',
};

/** The persona block: who they are, not what they know. Facts are never rendered here. */
export function renderPersonaBlock(persona: PersonaProfile, rawPageLang: string): string {
  const pageLang = primaryLanguageSubtag(rawPageLang);
  const reads = Object.entries(persona.languages.reads)
    .filter(([code]) => code !== persona.languages.native)
    .map(([code, level]) => `${code} ${level}`)
    .join(', ');
  const level =
    persona.languages.reads[pageLang] ??
    (pageLang === persona.languages.native ? 'fluent' : 'none');
  const languages = reads
    ? `Native language: ${persona.languages.native}. Reads: ${reads}.`
    : `Native language: ${persona.languages.native}.`;
  return [
    persona.name,
    persona.description.trim(),
    languages,
    `Device: ${DEVICE_LABEL[persona.device]}`,
    `Tech literacy: ${persona.techLiteracy}. Bureaucracy literacy: ${persona.domainLiteracy}. Patience: ${persona.patience}.`,
    `Intent: ${persona.intent} ${INTENT_LINE[persona.intent]}`,
    `This page is in ${pageLang || 'an unknown language'}; you read ${pageLang || 'it'} ${level}`,
  ].join('\n');
}

function renderHistory(history: HistoryEntry[]): string {
  if (history.length === 0) return 'You have not done anything on this site yet.';
  return [
    'What you have done so far:',
    ...history.map((h) => {
      const target = h.targetName
        ? ` "${h.targetName}"${h.targetHref ? ` (${h.targetHref})` : ''}`
        : '';
      return `- step ${h.step}: ${h.actionName}${target} -> ${h.outcomeSummary}`;
    }),
  ].join('\n');
}

/** The state text. Elements never appear here; Jev only ever sees them as numbered options. */
export function renderStateText(input: DecideInput): string {
  const meta = input.state.meta;
  const metaParts = [`You are on ${meta.url}`, `Page title: ${meta.title || '(none)'}`];
  // What is on screen now, and what was on screen earlier on this page. The persona may read
  // nothing else: `meta.h1` and `meta.mainText` are still collected, but a heading below the
  // fold is not something they have seen.
  if (meta.visibleText.length > 0) {
    metaParts.push(['On screen now:', ...meta.visibleText.map((block) => block.text)].join('\n'));
  }
  if (meta.belowFoldTextChars > 0) {
    metaParts.push(
      `About ${meta.belowFoldTextChars} characters of text below, which you have not read.`,
    );
  }
  if (input.seenText.length > 0) {
    metaParts.push(['Seen earlier on this page:', ...input.seenText].join('\n'));
  }
  if (meta.wizardProgress) metaParts.push(`Progress indicator: ${meta.wizardProgress}`);
  if (meta.nonResponsive) metaParts.push('Page is not mobile-optimised; shown zoomed out');
  if (meta.validationMessages.length > 0) {
    metaParts.push(`Error or validation text on the page: ${meta.validationMessages.join(' | ')}`);
  }
  const unfillable = input.state.elements.filter(
    (el) => el.inViewport && !el.disabled && isTextInput(el) && !matchFact(el, input.persona.facts),
  );
  if (unfillable.length > 0) {
    metaParts.push(
      `Visible fields you cannot fill, so they are not options: ${unfillable
        .map((el) => `"${el.name}"`)
        .join(', ')}.`,
    );
  }
  if (meta.disabledControls.length > 0) {
    // Named but never offered: the persona has to be able to see the gate to reason about it.
    metaParts.push(`Disabled right now: ${meta.disabledControls.map((n) => `"${n}"`).join(', ')}`);
  }
  if (meta.droppedElements > 0) {
    const sample =
      meta.belowFoldSample.length > 0 ? ` For example: ${meta.belowFoldSample.join(', ')}.` : '';
    metaParts.push(
      `${meta.droppedElements} more interactive elements were not listed; they are further down the page.${sample}`,
    );
  }

  const sections = [
    renderPersonaBlock(input.persona, meta.lang),
    `Your goal: ${input.goal}`,
    metaParts.join('\n'),
    renderHistory(input.history.slice(-HISTORY_WINDOW)),
  ];
  if (input.repeats.length > 0) {
    sections.push(['On this exact page:', ...input.repeats.map((r) => `- ${r}`)].join('\n'));
  }
  return sections.join('\n\n');
}

export function buildRequest(input: DecideInput): JevRequest {
  const criteria: Record<string, string> = {};
  for (const option of input.options) criteria[option.id] = option.description;
  return {
    state: renderStateText(input),
    model: JEV_MODEL,
    questions: {
      next: { type: 'choice', instructions: NEXT_INSTRUCTIONS, criteria },
      goalMet: { type: 'noul', instructions: GOAL_MET_INSTRUCTIONS },
      confusion: {
        type: 'score',
        instructions: CONFUSION_INSTRUCTIONS,
        criteria: [...CONFUSION_CRITERIA],
      },
    },
  };
}

/** Total characters sent: state text plus the question block. */
export function measureChars(request: JevRequest): number {
  return request.state.length + JSON.stringify(request.questions).length;
}

/** Option kinds that point at a page element and can therefore be dropped by the size guard. */
const ELEMENT_KINDS = new Set(['element', 'type', 'select']);

/**
 * Keep the first `cap` element-ish options and every meta action.
 * Meta actions are the persona's only way off a page, so the size guard never removes them.
 */
export function capElementOptions(options: Option[], cap: number): Option[] {
  const kept: Option[] = [];
  let elements = 0;
  for (const option of options) {
    if (!ELEMENT_KINDS.has(option.kind)) {
      kept.push(option);
      continue;
    }
    if (elements < cap) {
      kept.push(option);
      elements += 1;
    }
  }
  return kept;
}

function withVisibleText(
  input: DecideInput,
  visibleText: DecideInput['state']['meta']['visibleText'],
): DecideInput {
  return { ...input, state: { ...input.state, meta: { ...input.state.meta, visibleText } } };
}

/**
 * Shrink the request until it fits. Order: the seen-earlier memory, then
 * the on-screen blocks from the bottom up, then element options past 20, then history to 5.
 * Text goes first because it is the part the persona can re-read by scrolling; an option that
 * disappears is an action they can no longer take at all.
 */
export function fitToLimit(input: DecideInput): DecideInput {
  if (measureChars(buildRequest(input)) <= STATE_CHAR_LIMIT) return input;

  const noSeen: DecideInput = { ...input, seenText: [] };
  if (measureChars(buildRequest(noSeen)) <= STATE_CHAR_LIMIT) return noSeen;

  const trimmed = [...noSeen.state.meta.visibleText];
  while (trimmed.length > 0) {
    trimmed.pop();
    const candidate = withVisibleText(noSeen, trimmed);
    if (measureChars(buildRequest(candidate)) <= STATE_CHAR_LIMIT) return candidate;
  }
  const noText = withVisibleText(noSeen, []);

  const fewerOptions: DecideInput = {
    ...noText,
    options: capElementOptions(noText.options, REDUCED_OPTION_CAP),
  };
  if (measureChars(buildRequest(fewerOptions)) <= STATE_CHAR_LIMIT) return fewerOptions;

  const shortHistory: DecideInput = {
    ...fewerOptions,
    history: fewerOptions.history.slice(-REDUCED_HISTORY),
  };
  const chars = measureChars(buildRequest(shortHistory));
  if (chars <= STATE_CHAR_LIMIT) return shortHistory;

  throw new StateTooLargeError(chars);
}

interface JevBody {
  model?: string;
  answers?: {
    next?: {
      type?: string;
      choice?: string;
      confidence?: number;
      probabilities?: Record<string, number>;
    };
    goalMet?: { type?: string; noul?: unknown };
    confusion?: { type?: string; score?: unknown; confidence?: number };
  };
  usage?: { input_tokens?: number; output_tokens?: number };
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new JevParseError(
      `Jev answer ${field} is missing or not a finite number (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Turn a Jev response into a RawDecision, keeping only ids that were actually offered.
 * Missing or non-numeric scores throw rather than silently becoming 0: a fabricated
 * `goalMet: 0` would quietly disable the stop rule for the whole journey.
 */
export function parseResponse(
  body: unknown,
  optionIds: string[],
  latencyMs: number,
  stateChars: number,
  offeredOptions: Option[],
  /** The exact text sent as `JevRequest.state`. Defaults to `''` for tests that do not care. */
  stateText = '',
): RawDecision {
  const parsed = body as JevBody;
  const next = parsed.answers?.next;
  const offered = new Set(optionIds);

  const filtered: Record<string, number> = {};
  let mass = 0;
  for (const [id, p] of Object.entries(next?.probabilities ?? {})) {
    if (!offered.has(id) || typeof p !== 'number' || !(p > 0)) continue;
    filtered[id] = p;
    mass += p;
  }

  const goalMet = clamp(requireNumber(parsed.answers?.goalMet?.noul, 'goalMet.noul'), 0, 1);
  const confusion = clamp(requireNumber(parsed.answers?.confusion?.score, 'confusion.score'), 0, 4);
  const inputTokens =
    typeof parsed.usage?.input_tokens === 'number' ? parsed.usage.input_tokens : 0;

  if (mass === 0) {
    const fallback = next?.choice;
    if (fallback && offered.has(fallback)) {
      return {
        distribution: { [fallback]: 1 },
        goalMet,
        confusion,
        latencyMs,
        stateChars,
        inputTokens,
        offeredOptions,
        stateText,
      };
    }
    throw new JevParseError('Jev returned no usable choice for the offered options');
  }

  const distribution: Record<string, number> = {};
  for (const [id, p] of Object.entries(filtered)) distribution[id] = p / mass;

  return {
    distribution,
    goalMet,
    confusion,
    latencyMs,
    stateChars,
    inputTokens,
    offeredOptions,
    stateText,
  };
}

export interface JevEngineOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Per-call overrides. Only a replay uses these; a live journey passes nothing. */
export interface DecideOptions {
  /**
   * Send this exact string as `JevRequest.state` instead of rendering the input. Used by
   * `scripts/bench-decide.ts` to replay a recorded step byte for byte. The caller owns the
   * size guard for the text it supplies: a recorded `stateText` is already post-fit.
   */
  stateText?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How much of a failed response body reaches the error message. */
export const ERROR_BODY_CHARS = 300;

/** The body of a non-2xx response, whitespace-collapsed and truncated. Never throws. */
async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_CHARS);
  } catch {
    return '';
  }
}

/**
 * The message a JevUnavailableError carries. The body is what tells an operator whether the
 * key, the quota or the request was the problem, and 401/403 names the variable to fix so the
 * fix does not need a trip through the API docs.
 */
export function errorMessageFor(status: number, body: string): string {
  const head =
    status === 401 || status === 403
      ? `Jev returned ${status}: TYPESAFE_API_KEY rejected`
      : `Jev returned ${status}`;
  return body ? `${head}: ${body}` : head;
}

export class JevEngine implements DecideEngine {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Milliseconds spent in retry backoff during the most recent decide(). */
  retryMs = 0;

  constructor(options: JevEngineOptions = {}) {
    const key = options.apiKey ?? process.env['TYPESAFE_API_KEY'];
    if (!key) throw new JevUnavailableError('TYPESAFE_API_KEY is not set');
    this.apiKey = key;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async decide(input: DecideInput, options: DecideOptions = {}): Promise<RawDecision> {
    // First statement: fitToLimit can throw StateTooLargeError, and a stale retryMs
    // from the previous step would then be attributed to this one.
    this.retryMs = 0;

    const fitted = fitToLimit(input);
    const request = buildRequest(fitted);
    // A replay sends the recorded text verbatim rather than a fresh render of it, so a
    // benchmark measures the request that was actually made and not a reconstruction that
    // merely ought to match it. `stateChars` is measured after the substitution, so it still
    // describes what went over the wire.
    if (options.stateText !== undefined) request.state = options.stateText;
    const stateChars = measureChars(request);
    const optionIds = fitted.options.map((o: Option) => o.id);

    let lastError = 'unknown error';
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const started = performance.now();
      let response: Response;
      try {
        response = await this.fetchImpl(JEV_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        lastStatus = undefined;
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) break;
        this.retryMs += delay;
        await this.sleep(delay);
        continue;
      }

      const latencyMs = Math.round(performance.now() - started);

      if (response.ok) {
        // A 200 carrying an HTML error page is a transport success with no answer in it.
        // Left bare, `response.json()` throws a SyntaxError that drive() does not recognise
        // as a Jev failure, and the unhandled rejection takes the whole journey with it.
        let body: unknown;
        try {
          body = (await response.json()) as unknown;
        } catch (err) {
          throw new JevParseError(
            `Jev returned ${response.status} with a body that is not JSON: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        return parseResponse(
          body,
          optionIds,
          latencyMs,
          stateChars,
          [...fitted.options],
          request.state,
        );
      }

      lastStatus = response.status;
      lastError = errorMessageFor(response.status, await readErrorBody(response));
      const retryable = response.status === 429 || response.status >= 500;
      const delay = RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) break;
      this.retryMs += delay;
      await this.sleep(delay);
    }

    throw new JevUnavailableError(lastError, lastStatus);
  }
}
