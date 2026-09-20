// engine/types.ts
// All shared types for the lean loop. Zero imports from any other project module.

// --- Elements and page state ---

export type Landmark = 'header' | 'nav' | 'footer' | 'main' | 'form' | 'none';

/** Attribute values used to match a persona fact to an input. */
export interface ElementMatchHints {
  autocomplete: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
  /** The control carries `required` or `aria-required="true"`. */
  required: boolean;
}

/** One `<option>` of a `<select>`. */
export interface SelectOption {
  value: string;
  label: string;
}

/** One interactive element addressed by id for the length of a single step. */
export interface Element {
  /** `el_NN`, prefixed `f1:` for same-origin iframe elements. Regenerated each step. */
  id: string;
  role: string;
  /** Accessible name, trimmed to 80 chars. Empty gives `unnamed: true` and a synthesised name. */
  name: string;
  /** Relative href with utm parameters stripped. Absent for non-links. */
  href?: string;
  inputType?: string;
  hasValue: boolean;
  /**
   * What a text-like input or `<select>` currently holds, trimmed to 40 chars. Absent when the
   * control is empty, is not text-like, or is a password field, whose contents are never read.
   * For a `<select>` it is the selected `<option>`'s value, so it compares to a `select:` option.
   */
  value?: string;
  /** Document coordinate; iframe elements are offset by the frame position. */
  y: number;
  inViewport: boolean;
  landmark: Landmark;
  /** An ancestor has `position: fixed` or `position: sticky`. */
  sticky: boolean;
  /** Inside an `aria-live` region; excluded from stateHash and from settle. */
  inAriaLive: boolean;
  overlay: boolean;
  dismissesOverlay: boolean;
  unnamed: boolean;
  /**
   * The control is `:disabled`, carries `aria-disabled="true"`, or sits inside a
   * `fieldset[disabled]`. It stays in `elements` — the persona can see it and it belongs to the
   * page signature — but it is never offered as an option, because clicking it can only time out.
   */
  disabled: boolean;
  /** BCP 47 subtag when this element is a language-switcher target. */
  langCode?: string;
  match: ElementMatchHints;
  /** Up to 10 options, present only for `<select>`. */
  selectOptions?: SelectOption[];
  /**
   * The copy next to this option. Present only for in-viewport elements: an off-screen
   * option's surroundings are not on screen either, so the persona cannot have read them.
   */
  context?: ElementContext;
}

export interface LangSwitcherTarget {
  /** BCP 47 language subtag, e.g. `uk`. */
  code: string;
  elementId: string;
  name: string;
}

/** Copy around an in-viewport option. */
export interface ElementContext {
  /** Nearest preceding heading text within the same landmark, up to 80 chars. */
  heading?: string;
  /**
   * Closest text block by vertical distance within 160 px that is not the element's own
   * name, up to 120 chars. Prices and numbers inside it are kept verbatim.
   */
  near?: string;
}

/** One block of visible page text, grouped by its nearest block ancestor. */
export interface TextBlock {
  /** `[h1] text` / `[h2] text` / `text`, whitespace collapsed, trimmed to 400 chars. */
  text: string;
  /** The landmark the block sits in; part of the driver's seen-memory key. */
  landmark: Landmark;
  /**
   * The block sits inside an `aria-live` region that is not `off`. It still reaches the model,
   * because a consent banner's body is live text the persona reads, but it is kept out of the
   * state signature so a ticker or a clock cannot churn the hash every step.
   */
  inAriaLive: boolean;
}

export interface PageMeta {
  url: string;
  title: string;
  lang: string;
  scrollY: number;
  scrollMax: number;
  viewport: { width: number; height: number };
  h1: string;
  /** First 300 chars of main text. */
  mainText: string;
  /**
   * Visible text blocks that intersect the top-level viewport, in document order.
   * Trimmed to 400 chars per block, 2,500 chars in total.
   */
  visibleText: TextBlock[];
  /**
   * Digest of the on-screen, non-live text. Taken over every in-viewport block before the
   * `visibleText` budget trims the list, so a page growing past the budget does not move the
   * state hash on its own.
   */
  visibleTextDigest: string;
  /** Visible-text characters below the fold. A count only: that text is never sent. */
  belowFoldTextChars: number;
  /**
   * True when the page laid itself out wider than the device it was opened on, which is what a
   * site with no viewport meta does on a phone: the persona is reading a desktop layout zoomed
   * out. Computed from the reported layout width against the configured viewport width.
   */
  nonResponsive: boolean;
  wizardProgress?: string;
  validationMessages: string[];
  langSwitcher: LangSwitcherTarget[];
  /** Count of interactive elements dropped by the option cap. */
  droppedElements: number;
  /** Names of up to 5 dropped below-fold elements. */
  belowFoldSample: string[];
  /** Names of up to 10 disabled controls, so the persona can be told about the gate. */
  disabledControls: string[];
  skippedFrames: number;
  closedRoots: number;
}

export interface PageState {
  elements: Element[];
  meta: PageMeta;
  stateHash: string;
  viewHash: string;
}

// --- Options and decisions ---

export type OptionId = string;

export type OptionKind =
  | 'element'
  | 'type'
  | 'select'
  | 'scroll_down'
  | 'scroll_up'
  | 'back'
  | 'switch_language'
  /** The only exit: leaving is the act a real person performs when a site defeats them. */
  | 'leave';

export interface Option {
  /** `el_14` | `type:el_07` | `select:el_09=PL` | `scroll_down` | `back` | `switch_language:uk` | `leave`. */
  id: OptionId;
  kind: OptionKind;
  /** The criteria description sent to Jev. */
  description: string;
  elementId?: string;
  /** Fill value for `type:`, option value for `select:`. */
  value?: string;
  languageCode?: string;
}

export interface HistoryEntry {
  step: number;
  viewHash: string;
  actionName: string;
  targetName?: string;
  targetHref?: string;
  /** `navigated to <url>` | `nothing changed` | `error: <class>`. */
  outcomeSummary: string;
}

export interface DecideInput {
  persona: PersonaProfile;
  goal: string;
  state: PageState;
  options: Option[];
  history: HistoryEntry[];
  /** Per-state repeat lines: `you already clicked "Dalej" here 2 times; result: nothing changed`. */
  repeats: string[];
  /**
   * Blocks seen earlier on this page that are not on screen now, most recent first,
   * already capped at 1,000 chars by the driver.
   */
  seenText: string[];
}

export interface RawDecision {
  /** Raw, sums to 1. */
  distribution: Record<OptionId, number>;
  /** P(true) that the goal is already met. */
  goalMet: number;
  /** 0..4. */
  confusion: number;
  latencyMs: number;
  stateChars: number;
  /** `usage.input_tokens` from Jev, used to measure the real chars-per-token ratio. */
  inputTokens: number;
  /** The option list Jev actually saw, after the size guard shrank it. */
  offeredOptions: Option[];
  /** The exact state text Jev was sent, after the size guard shrank it. */
  stateText: string;
}

export interface Decision extends RawDecision {
  /** After top-p and floor, renormalized. */
  pruned: Record<OptionId, number>;
  /** Seeded draw from `pruned`. */
  sampled: OptionId;
  argmax: OptionId;
  /** max(distribution). */
  confidence: number;
  /** Bits, over the raw distribution. */
  entropy: number;
  exploration: boolean;
}

export interface DecideEngine {
  decide(input: DecideInput): Promise<RawDecision>;
}

// --- Persona ---

export const FACT_KEYS = [
  'givenName',
  'familyName',
  'email',
  'phone',
  'nationality',
  'birthDate',
  'city',
  'employer',
  'arrivalDate',
  'pesel',
] as const;

export type FactKey = (typeof FACT_KEYS)[number];

/** Spec section 9 types facts as Record<string, string>; FACT_KEYS is the matcher's vocabulary. */
export type Facts = Record<string, string>;

export type ReadingLevel = 'none' | 'weak' | 'ok' | 'fluent';

export interface PersonaProfile {
  name: string;
  /** 3-6 lines: who, situation, why on this site. */
  description: string;
  languages: { native: string; reads: Record<string, ReadingLevel> };
  /** BCP 47; default derived from languages.native. */
  browserLocale?: string;
  device: 'desktop' | 'mobile';
  techLiteracy: 'low' | 'medium' | 'high';
  domainLiteracy: 'low' | 'medium' | 'high';
  /** A leave after 3 / 4 / 6 no-progress steps counts as exhaustion, not a free choice. */
  patience: 'low' | 'medium' | 'high';
  /**
   * How much the persona wants this, which is what makes `leave` plausible or absurd.
   * Rendered as a line in the persona block; never a probability the code applies.
   */
  intent: 'low' | 'medium' | 'high';
  facts: Facts;
}

// --- Execution outcome ---

export interface Outcome {
  urlChanged: boolean;
  stateChanged: boolean;
  error?: string;
  errorClass?: string;
  consoleErrors: string[];
  failedRequests: string[];
  validationMessages: string[];
  durationMs: number;
}

/**
 * What the step did about an overlay covering its target. `method` is how the dismissal was
 * attempted: `control` clicked a dismiss control, `escape` fell back to the Escape key, and
 * `none` means nothing could even be attempted. Escape closes nothing on most consent
 * banners, so an overlay that survives it is a harness limitation, not a site defect — which
 * is why the method has to be on the record.
 */
export interface OverlayDismissal {
  dismissed: boolean;
  method: 'control' | 'escape' | 'none';
}

export interface StepTiming {
  extractMs: number;
  decideMs: number;
  decideRetryMs: number;
  executeMs: number;
  settleMs: number;
}

// --- Trace ---

export const ALL_FLAGS = [
  'high-entropy',
  'low-confidence',
  'confused',
  'failed-action',
  'no-change',
  'validation-error',
  'backtrack',
  'overlay-blocked',
  'overlay-undismissed',
  'unlabeled-control',
  'missing-fact',
  'lost',
  /** The persona left on step 1: a bounce, not a journey. */
  'bounce-on-entry',
  /**
   * The persona left on this step. Deliberately NOT a ux flag: it changes no bucket, it only
   * makes an abandonment mid-journey survive the report's flagged-row filter.
   */
  'left',
  /** A phone persona is reading a desktop layout zoomed out (`meta.nonResponsive`). */
  'non-responsive',
  /**
   * The page moved only after the step had run out of ways to touch it: the action landed and
   * the transition took longer than the settle window. Deliberately NOT a ux flag — it says
   * the harness nearly lost a step, not that the site did anything wrong — but it is worth
   * seeing in a trace, because a run full of them means the settle budget is too short.
   */
  'late-transition',
] as const;

export type Flag = (typeof ALL_FLAGS)[number];

export const ALL_BUCKETS = ['tool', 'stale', 'product', 'ux', 'persona', 'bounce', 'none'] as const;

export type Bucket = (typeof ALL_BUCKETS)[number];

export function isFlag(value: unknown): value is Flag {
  return typeof value === 'string' && (ALL_FLAGS as readonly string[]).includes(value);
}

export function isBucket(value: unknown): value is Bucket {
  return typeof value === 'string' && (ALL_BUCKETS as readonly string[]).includes(value);
}

export interface TraceRow {
  step: number;
  timestamp: number;
  url: string;
  stateHash: string;
  viewHash: string;
  viewport: { width: number; height: number };
  screenshotPath?: string;
  elementsCount: number;
  droppedElements: number;
  /** The options Jev actually saw this step. */
  options: Option[];
  distribution: Record<OptionId, number>;
  pruned: Record<OptionId, number>;
  sampled: OptionId;
  /** Accessible name of the sampled target, or the meta action id. */
  sampledName: string;
  /** Href of the sampled target, when it had one. */
  sampledHref?: string;
  argmax: OptionId;
  exploration: boolean;
  confidence: number;
  entropy: number;
  goalMet: number;
  confusion: number;
  outcome: Outcome;
  timing: StepTiming;
  flags: Flag[];
  bucket: Bucket;
  stateChars: number;
  /** `usage.input_tokens` reported by Jev for this step. */
  inputTokens: number;
  /** Characters of on-screen text sent this step. */
  visibleTextChars: number;
  /** Characters of `Seen earlier on this page:` text sent this step. */
  seenTextChars: number;
  /** True for `scroll_down` / `scroll_up` steps; they do not count as URL visits in perUrl. */
  scrollOnly: boolean;
  /** URL after the action. Absent on a step that never got to act. */
  nextUrl?: string;
  /** How the step tried to get rid of an overlay. Absent when no overlay was in the way. */
  overlayDismissal?: OverlayDismissal;
  /** Label of an input the persona had no fact for, when the step was bucketed `persona`. */
  missingFactLabel?: string;
  /**
   * Which route reached the target: its own handle, a re-extracted one, or a role+name
   * locator. Present on steps that acted on an element, so a run leaning on the fallbacks
   * is visible rather than looking like an ordinary one.
   */
  clickPath?: ClickPath;
}

/** How a step reached the element it acted on. */
export type ClickPath = 'handle' | 'retry' | 'locator';

export interface PerUrlRow {
  url: string;
  visits: number;
  meanEntropy: number;
  meanConfusion: number;
  /** Journeys whose last URL this is. */
  exits: number;
  /** Share of the journeys that ended here which ended by leaving. Matomo's exit rate. */
  leaveRate: number;
  backtracks: number;
  topSampled: Array<{ name: string; meanProbability: number }>;
}

export interface JourneySummary {
  /** Timestamp plus short random suffix. */
  runId: string;
  persona: { name: string };
  browserLocale: string;
  device: 'desktop' | 'mobile';
  seed: number;
  outcome: {
    needMet: boolean | null;
    /** The persona left while confused or stuck: the same act as `left`, read as exhaustion. */
    gaveUp: boolean;
    /** The persona chose `leave`. Distinct from `gaveUp`, which is exhaustion. */
    left: boolean;
    /**
     * The believes-done tracker fired on the step that ended the journey. Kept apart from the
     * verdict, because a persona who believed they were done and then left is a bounce, not a
     * `false-completion`.
     */
    believedDone: boolean;
    reason: string;
    bucket: Bucket;
    totalSteps: number;
    totalDurationMs: number;
    /** Outcome findings: `false-completion`, `unrecognized-success`. */
    outcomeFindings: string[];
  };
  perUrl: PerUrlRow[];
}

export interface Journey {
  summary: JourneySummary;
  rows: TraceRow[];
  /**
   * Rows bucketed `tool` or `stale`. Sent to the report LLM in a separate labeled
   * section that it must not turn into findings.
   */
  toolIssues: TraceRow[];
  /**
   * Run-level failures raised outside the trace rows, such as a decision record that could
   * not be written. Optional so existing journeys built without this field (tests, older
   * fixtures) still satisfy the type; `explore()` treats a missing array as empty.
   */
  runIssues?: RunIssue[];
}

// --- Config and result ---

export interface ExploreConfig {
  url: string;
  need: string;
  persona: PersonaProfile;
  maxSteps: number;
  seed: number;
  engine: 'jev';
  successUrl?: RegExp;
  successText?: string;
  output: string;
  format: 'yaml' | 'json';
  verbose: boolean;
  screenshots: boolean;
  /** Write `decisions/step-NN.json` per step, for `scripts/bench-decide.ts`. */
  recordDecisions: boolean;
  /**
   * Make the single report call at the end of the journey. `false` gives the journey, its
   * metrics and its tool issues and skips the one Sonnet call, which is where almost all of a
   * live run's cost sits.
   */
  report: boolean;
}

// --- Findings ---

export interface Finding {
  findingId: string;
  category: string;
  severity: 'low' | 'medium' | 'high';
  confidence: 'low' | 'medium' | 'high';
  bucket: 'product' | 'ux' | 'persona';
  issue: string;
  evidence: string;
  evidenceSteps: number[];
  recommendation: string;
  analyticsCheck: string;
}

// --- Metrics ---

export interface MetricsReport {
  runIds: string[];
  /**
   * Mean cross-persona L1 divided by mean same-persona seed-repeat L1.
   * Null for a single journey; only `scripts/metrics.ts` over a run set produces a number.
   */
  divergenceRatio: number | null;
  explorationRate: number;
  /** Completion rates in 0..1, split by whether the journey ever explored off the argmax. */
  completionRateByExploration: { explored: number | null; exploited: number | null };
  perUrl: PerUrlRow[];
  /** Share of each persona's journeys that ended with `left: true`. */
  leaveRateByPersona: Record<string, number>;
  ordinalCheck?: { expected: string[]; actual: string[]; ordered: boolean };
  /** Measured chars per Jev input token, averaged over the run set. */
  charsPerToken: number;
}

/**
 * A failure outside the step loop. It travels with the result rather than throwing, so the
 * journey the run already paid for still reaches disk.
 */
export interface RunIssue {
  kind: 'report-failed' | 'record-failed';
  message: string;
  /** Present only for `record-failed`: the step whose decision record could not be written. */
  step?: number;
}

/**
 * What the post-parse evidence check did to the report model's findings. Both counts being
 * zero is the good case: the model cited steps that exist and bucketed `product` only on rows
 * that show a product signal.
 */
export interface ReportValidation {
  /** Findings dropped for citing steps that are not in the trace. */
  droppedFindings: number;
  /** `product` findings re-bucketed `ux` with low confidence for want of a product signal. */
  downgradedFindings: number;
}

export interface ExploreResult {
  journey: Journey;
  /** Empty when the report call failed; `runIssues` says why. */
  narrative: string;
  findings: Finding[];
  metrics: MetricsReport;
  outcome: JourneySummary['outcome'];
  /** Screenshots that could not be copied into the report directory; surfaced as tool issues. */
  screenshotErrors: string[];
  /** Run-level failures, written into tool-issues.json next to the journey's tool rows. */
  runIssues: RunIssue[];
  /** Wall-clock milliseconds the single report call took; 0 when it never returned. */
  reportMs: number;
  /** Written into metrics.json under `reportValidation`; zeros when the report call failed. */
  reportValidation: ReportValidation;
}
