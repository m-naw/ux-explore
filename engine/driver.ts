// engine/driver.ts
// The per-step loop: extract -> options -> decide -> execute -> record -> stop rules.

import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type {
  DecideEngine,
  DecideInput,
  ExploreConfig,
  HistoryEntry,
  Journey,
  Option,
  OptionKind,
  PersonaProfile,
  RawDecision,
  RunIssue,
  TraceRow,
} from './types';
import { extract, extractWithRetry, isNavigationRaceError, sha1, type Extraction } from './extract';
import { normalizeUrl } from './url-normalize';
import { NAME_SHIM } from './name-shim';
import { buildOptions } from './options';
import { makeRng, toDecision } from './decide';
import { JevEngine, StateTooLargeError, JevUnavailableError, JevParseError } from './jev-engine';
import { writeDecisionRecordSafely } from './record-decisions';
import { execute, type ExecuteResult } from './execute';
import { createPageMonitor, type PageMonitor } from './page-monitor';
import { computeFlags, aggregatePerUrl } from './trace';
import { bucketStep, journeyBucket, type ToolFailure } from './attribution';
import {
  BelievesDoneTracker,
  criteriaConfigured,
  criteriaMet,
  leftInExhaustion,
  resolveOutcome,
  type GoalCriteria,
} from './goal';
import { detectLoop } from './loop-detector';
import { requiredInputsWithoutFacts } from './typed-input';
import { timer } from './timing';

const LOCALE_BY_LANGUAGE: Record<string, string> = {
  uk: 'uk-UA',
  pl: 'pl-PL',
  en: 'en-GB',
  ru: 'ru-RU',
};

/** Cap on the `Seen earlier on this page:` section. */
export const SEEN_TEXT_CHARS = 1_000;

export function browserLocaleFor(persona: PersonaProfile): string {
  return persona.browserLocale ?? LOCALE_BY_LANGUAGE[persona.languages.native] ?? 'en-GB';
}

export function makeRunId(now: Date = new Date(), random: () => number = Math.random): string {
  const stamp = now.toISOString().replace(/:/g, '-').replace(/\..*$/, '');
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${stamp}-${suffix}`;
}

/**
 * A scroll that moved the page also frees the opposite direction: hitting the bottom blocks
 * `scroll_down`, and the scroll back up is precisely what makes scrolling down possible again.
 * Any other action can replace the page under us, so it drops both blocks.
 */
export function updateScrollBlocked(
  blocked: { down: boolean; up: boolean },
  kind: OptionKind,
  scrollChangedY: boolean,
): { down: boolean; up: boolean } {
  if (kind === 'scroll_down')
    return { down: !scrollChangedY, up: scrollChangedY ? false : blocked.up };
  if (kind === 'scroll_up')
    return { up: !scrollChangedY, down: scrollChangedY ? false : blocked.down };
  return { down: false, up: false };
}

/**
 * Progress is a new stateHash, OR a successful `type:`/`select:` step that actually changed
 * the control's value. Filling a wizard in place produces no new state hash, and without the
 * second clause four filled fields in a row read as a persona who is lost.
 */
export function madeProgress(ctx: {
  newStateHash: boolean;
  kind: OptionKind;
  failed: boolean;
  valueChanged: boolean;
}): boolean {
  if (ctx.newStateHash) return true;
  return (ctx.kind === 'type' || ctx.kind === 'select') && !ctx.failed && ctx.valueChanged;
}

export interface DriverDeps {
  browser: Browser;
  engine: DecideEngine;
  onStep?: (row: TraceRow) => void;
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch();
}

/**
 * Playwright's `locale` also sets Accept-Language, so no extra header is needed.
 * devices['Pixel 5'] is 393x727 in Playwright 1.59.1; the spec mandates 390x844, so the
 * descriptor supplies touch and the mobile UA and the size is overridden explicitly.
 */
async function newContext(browser: Browser, persona: PersonaProfile): Promise<BrowserContext> {
  const locale = browserLocaleFor(persona);
  const context =
    persona.device === 'mobile'
      ? await browser.newContext({
          ...devices['Pixel 5'],
          viewport: { width: 390, height: 844 },
          screen: { width: 390, height: 844 },
          locale,
        })
      : await browser.newContext({ viewport: { width: 1280, height: 720 }, locale });
  // The extractor installs the shim per frame itself; this covers every other evaluate the
  // driver makes on this page (the visible-text read behind the success criteria).
  // See engine/name-shim.ts for why a serialized callback needs `__name` to exist.
  await context.addInitScript(NAME_SHIM);
  return context;
}

function summarizeOutcome(outcome: TraceRow['outcome'], nextUrl: string): string {
  if (outcome.errorClass) return `error: ${outcome.errorClass}`;
  if (outcome.urlChanged) return `navigated to ${nextUrl}`;
  if (outcome.stateChanged) return 'the page changed';
  return 'nothing changed';
}

async function visibleText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => document.body.innerText ?? '');
  } catch {
    return '';
  }
}

/** Drive one journey to completion. The caller owns the browser. */
export async function drive(config: ExploreConfig, deps: DriverDeps): Promise<Journey> {
  const runId = makeRunId();
  const criteria: GoalCriteria = {
    ...(config.successUrl ? { successUrl: config.successUrl } : {}),
    ...(config.successText ? { successText: config.successText } : {}),
  };

  const rng = makeRng(config.seed);
  const believes = new BelievesDoneTracker();

  const rows: TraceRow[] = [];
  const runIssues: RunIssue[] = [];
  const history: HistoryEntry[] = [];
  const seenStateHashes = new Set<string>();
  // Per page (normalized URL): blockKey -> block text, in recency order. Re-inserting a key
  // moves it to the end, so iterating in reverse gives "most recent first" for free.
  const seenBlocks = new Map<string, string>();
  // Normalized URLs already reported as non-responsive. The desktop layout is a property of
  // the page, so it is worth saying once per page rather than on every step spent on it.
  const seenNonResponsive = new Set<string>();
  let seenUrlKey = '';
  const journeyStart = Date.now();

  let noProgressSteps = 0;
  let lastConfusion = 0;
  let scrollBlocked = { down: false, up: false };
  let gaveUp = false;
  let left = false;
  let believesFiredNow = false;
  let criteriaMatched = false;
  let looped = false;
  let maxStepsReached = false;
  let fatalToolFailure: ToolFailure | undefined;
  let screenshotDir = '';
  let decisionDir = '';

  // JevEngine resets retryMs at the start of each decide and the value survives the throw,
  // so a failed step reports its own backoff rather than the previous step's.
  const retryMsOf = (): number => (deps.engine instanceof JevEngine ? deps.engine.retryMs : 0);

  // The context is created outside the try only so `finally` can close it. Everything that
  // can fail — the first page, the monitor, the screenshot directory, the opening navigation —
  // happens inside, so an unreachable URL cannot leak a context and its four listeners.
  const context = await newContext(deps.browser, config.persona);
  let monitor: PageMonitor | undefined;

  try {
    const page = await context.newPage();
    // Created before the first navigation, so load-time console noise becomes the baseline.
    const pageMonitor = createPageMonitor(page);
    monitor = pageMonitor;

    if (config.screenshots) {
      screenshotDir = path.join(config.output, runId, 'screenshots');
      await mkdir(screenshotDir, { recursive: true });
    }

    if (config.recordDecisions) {
      decisionDir = path.join(config.output, runId, 'decisions');
      await mkdir(decisionDir, { recursive: true });
    }

    await page.goto(config.url, { waitUntil: 'domcontentloaded' });
    pageMonitor.mark();

    for (let step = 1; step <= config.maxSteps; step += 1) {
      const extractTimer = timer();
      let extraction: Extraction;
      try {
        extraction = await extractWithRetry(page);
      } catch (err) {
        // The document was replaced twice while the extractor read it. There is nothing for
        // the persona to act on this step, but the journey is not over: the next step reads
        // the page again. An unreadable step is a tool problem, not a site defect.
        if (!isNavigationRaceError(err)) throw err;
        const failedRow = toolFailureRow(
          step,
          unreadableSnapshot(page, rows),
          [],
          'extract-failed',
          0,
          0,
        );
        rows.push(failedRow);
        deps.onStep?.(failedRow);
        continue;
      }
      const extractMs = extractTimer();

      // The memory belongs to the page, not to the journey: a new normalized URL is a new
      // page, and the history line already records where the persona has been.
      const urlKey = normalizeUrl(extraction.state.meta.url);
      if (urlKey !== seenUrlKey) {
        seenBlocks.clear();
        seenUrlKey = urlKey;
      }
      const onScreenKeys = new Set<string>();
      for (const block of extraction.state.meta.visibleText) {
        const key = sha1(`${block.landmark}\n${block.text}`);
        onScreenKeys.add(key);
        seenBlocks.delete(key);
        seenBlocks.set(key, block.text);
      }
      // Same accounting as the extractor's cap: the joined length, separators included.
      const visibleTextChars = extraction.state.meta.visibleText
        .map((b) => b.text)
        .join('\n').length;
      // The budget is the joined length `renderStateText` will send, separators included,
      // measured exactly the way `meta.visibleText` is measured in the extractor.
      const seenText: string[] = [];
      let seenTextChars = 0;
      for (const [key, text] of [...seenBlocks.entries()].reverse()) {
        if (onScreenKeys.has(key)) continue;
        const separator = seenText.length > 0 ? 1 : 0;
        if (seenTextChars + separator + text.length > SEEN_TEXT_CHARS) break;
        seenText.push(text);
        seenTextChars += separator + text.length;
      }

      // Spec section 8: zero elements on a page with body text is a tool problem,
      // but the persona can still scroll or go back, so the journey continues.
      let stepToolFailure: ToolFailure | undefined =
        extraction.state.elements.length === 0 && extraction.state.meta.mainText.length > 0
          ? 'zero-elements'
          : undefined;

      const optionSet = buildOptions({
        state: extraction.state,
        persona: config.persona,
        scrollBlocked,
        canGoBack: rows.some((r) => r.outcome.urlChanged),
      });
      extraction.state.meta.droppedElements = optionSet.droppedElements;
      extraction.state.meta.belowFoldSample = optionSet.belowFoldSample;

      // `leave` is offered on every step, so the option list is never empty. A page that gave
      // the harness nothing else to act on is recorded as a step-level tool failure, but the
      // persona still has one real move left. They almost always take it, and the run ends
      // `bounce` — a verdict the report can use — instead of `tool`, which it is forbidden
      // to write findings about.
      if (optionSet.options.every((option) => option.kind === 'leave')) {
        stepToolFailure ??= 'zero-elements';
      }

      const repeats = rows
        .filter((r) => r.stateHash === extraction.state.stateHash)
        .reduce<Map<string, { count: number; last: string }>>((acc, r) => {
          const entry = acc.get(r.sampledName) ?? { count: 0, last: '' };
          entry.count += 1;
          entry.last = summarizeOutcome(r.outcome, r.nextUrl ?? r.url);
          acc.set(r.sampledName, entry);
          return acc;
        }, new Map());

      const decideInput: DecideInput = {
        persona: config.persona,
        goal: config.need,
        state: extraction.state,
        options: optionSet.options,
        history,
        repeats: [...repeats.entries()].map(
          ([name, info]) =>
            `you already clicked "${name}" here ${info.count} times; result: ${info.last}`,
        ),
        seenText,
      };

      const decideTimer = timer();
      let raw: RawDecision;
      try {
        raw = await deps.engine.decide(decideInput);
      } catch (err) {
        // Spec section 5.3: a final Jev failure ends the journey. A body we cannot parse is
        // one of those failures — the transport worked but there is no answer to act on —
        // so it must not escape drive() as an unhandled rejection.
        const jevFailed = err instanceof JevUnavailableError || err instanceof JevParseError;
        if (!(err instanceof StateTooLargeError) && !jevFailed) throw err;
        fatalToolFailure = err instanceof StateTooLargeError ? 'state-too-large' : 'jev-failure';
        rows.push(
          toolFailureRow(
            step,
            snapshotOf(extraction),
            optionSet.options,
            fatalToolFailure,
            decideTimer(),
            retryMsOf(),
          ),
        );
        deps.onStep?.(rows[rows.length - 1]!);
        await extraction.dispose();
        break;
      }
      const decideMs = decideTimer();
      const decideRetryMs = retryMsOf();
      const decision = toDecision(raw, rng);

      if (config.recordDecisions) {
        // Written after the decision so the live Jev distribution travels with the input the
        // bench will replay, and `stateText` comes from the engine's own answer (`raw.stateText`)
        // rather than a fresh `renderStateText(decideInput)` call, so it is provably the text
        // Jev was actually sent -- after the size guard, not before it. A write failure must
        // not cost the step it paid for; it becomes a `record-failed` run issue instead.
        const issue = await writeDecisionRecordSafely(decisionDir, {
          runId,
          step,
          persona: config.persona,
          goal: config.need,
          state: extraction.state,
          options: raw.offeredOptions,
          history: [...history],
          repeats: decideInput.repeats,
          seenText,
          stateText: raw.stateText,
          jevDistribution: raw.distribution,
        });
        if (issue) runIssues.push(issue);
      }

      const sampledOption =
        raw.offeredOptions.find((o) => o.id === decision.sampled) ?? raw.offeredOptions[0]!;
      const sampledElement = sampledOption.elementId
        ? extraction.state.elements.find((e) => e.id === sampledOption.elementId)
        : undefined;

      let screenshotPath: string | undefined;
      if (config.screenshots) {
        screenshotPath = path.join(screenshotDir, `step-${String(step).padStart(2, '0')}.jpg`);
        try {
          await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 70 });
        } catch {
          screenshotPath = undefined;
        }
      }

      pageMonitor.mark();
      const executeTimer = timer();
      let result: ExecuteResult;
      try {
        result = await execute({
          page,
          extraction,
          option: sampledOption,
          monitor: pageMonitor,
          reExtract: () => extract(page),
        });
      } catch (err) {
        // The action landed, but reading the page it produced lost its context twice. The
        // step is unreportable; the journey carries on from whatever the next read sees.
        if (!isNavigationRaceError(err)) throw err;
        const failedRow = toolFailureRow(
          step,
          snapshotOf(extraction),
          optionSet.options,
          'extract-failed',
          decideMs,
          decideRetryMs,
        );
        rows.push(failedRow);
        deps.onStep?.(failedRow);
        await extraction.dispose();
        // A leave never touches the page, so it cannot lose a context and should never reach
        // here; if it somehow does, the journey is still over. `continue` would put a persona
        // who had already walked away back on the site for another step.
        if (sampledOption.kind === 'leave') {
          left = true;
          break;
        }
        continue;
      }
      const executeMs = executeTimer();
      // A `leave` reads nothing back, because it touched nothing: the page the step started
      // on is still the page the persona is looking at.
      const after = result.after ?? extraction;

      // The page we acted on counts as seen BEFORE we judge whether the result is new,
      // otherwise step 1 always looks like progress and the counter lags by one step.
      seenStateHashes.add(extraction.state.stateHash);
      const progressed = madeProgress({
        newStateHash: !seenStateHashes.has(after.state.stateHash),
        kind: sampledOption.kind,
        failed: result.outcome.error !== undefined,
        valueChanged: result.valueChanged,
      });
      seenStateHashes.add(after.state.stateHash);
      noProgressSteps = progressed ? 0 : noProgressSteps + 1;

      scrollBlocked = updateScrollBlocked(scrollBlocked, sampledOption.kind, result.scrollChangedY);

      // The role and the input type come from the execute result, which reports what it
      // actually acted on; recomputing them here would be a second, divergable source.
      const wasSubmit =
        result.targetInputType === 'submit' ||
        (result.targetRole === 'button' && sampledElement?.landmark === 'form');

      // A submit the site rejected, on a form the persona cannot fill, is a persona gap,
      // not a site defect, so it is reported as `missing-fact:<label>`.
      const unfillable =
        wasSubmit && result.outcome.validationMessages.length > 0
          ? requiredInputsWithoutFacts(extraction.state, config.persona.facts)
          : [];
      const missingFactLabel = unfillable[0];

      const flags = computeFlags({
        optionCount: raw.offeredOptions.length,
        entropy: decision.entropy,
        confidence: decision.confidence,
        confusion: decision.confusion,
        outcome: result.outcome,
        sampledOption,
        ...(result.targetRole ? { sampledRole: result.targetRole } : {}),
        ...(result.targetInputType ? { sampledInputType: result.targetInputType } : {}),
        sampledUnnamed: sampledElement?.unnamed ?? false,
        overlayBlocked: result.overlayBlocked,
        ...(result.overlayDismissal
          ? { overlayDismissMethod: result.overlayDismissal.method }
          : {}),
        stateHash: extraction.state.stateHash,
        recentStateHashes: rows.map((r) => r.stateHash),
        wasSubmit: wasSubmit === true,
        missingFact: missingFactLabel !== undefined,
        noProgressSteps,
        firstRow: rows.length === 0,
        device: config.persona.device,
        nonResponsive: extraction.state.meta.nonResponsive && !seenNonResponsive.has(urlKey),
        lateTransition: result.lateTransition === true,
      });
      if (extraction.state.meta.nonResponsive) seenNonResponsive.add(urlKey);

      // A timeout on a target that was visible and unobstructed is our problem, not the
      // site's; it buckets the step `tool` and the journey carries on.
      if (
        result.outcome.errorClass === 'timeout' &&
        (sampledElement?.inViewport ?? false) &&
        !result.overlayBlocked
      ) {
        stepToolFailure = 'playwright-timeout';
      }

      const afterUrl = after.state.meta.url;
      const row: TraceRow = {
        step,
        timestamp: Date.now(),
        url: extraction.state.meta.url,
        stateHash: extraction.state.stateHash,
        viewHash: extraction.state.viewHash,
        viewport: extraction.state.meta.viewport,
        ...(screenshotPath ? { screenshotPath } : {}),
        elementsCount: extraction.state.elements.length,
        droppedElements: optionSet.droppedElements,
        options: raw.offeredOptions,
        distribution: decision.distribution,
        pruned: decision.pruned,
        sampled: decision.sampled,
        sampledName: sampledElement ? sampledElement.name : sampledOption.id,
        ...(sampledElement?.href ? { sampledHref: sampledElement.href } : {}),
        argmax: decision.argmax,
        exploration: decision.exploration,
        confidence: decision.confidence,
        entropy: decision.entropy,
        goalMet: decision.goalMet,
        confusion: decision.confusion,
        outcome: result.outcome,
        timing: { extractMs, decideMs, decideRetryMs, executeMs, settleMs: result.settleMs },
        flags,
        bucket: bucketStep({
          flags,
          outcome: result.outcome,
          stale: result.stale,
          ...(stepToolFailure ? { toolFailure: stepToolFailure } : {}),
          falseCompletion: false,
          href404: result.outcome.failedRequests.some((r) => /\(4\d\d\)$/.test(r)),
        }),
        stateChars: decision.stateChars,
        inputTokens: decision.inputTokens,
        visibleTextChars,
        seenTextChars,
        scrollOnly: sampledOption.kind === 'scroll_down' || sampledOption.kind === 'scroll_up',
        ...(missingFactLabel !== undefined ? { missingFactLabel } : {}),
        // Where the action actually landed, so a later repeat hint can say so.
        nextUrl: afterUrl,
        ...(result.clickPath ? { clickPath: result.clickPath } : {}),
        ...(result.overlayDismissal ? { overlayDismissal: result.overlayDismissal } : {}),
      };
      rows.push(row);
      deps.onStep?.(row);

      history.push({
        step,
        viewHash: extraction.state.viewHash,
        actionName: sampledOption.kind === 'element' ? 'clicked' : sampledOption.kind,
        ...(sampledElement ? { targetName: sampledElement.name } : {}),
        ...(sampledElement?.href ? { targetHref: sampledElement.href } : {}),
        outcomeSummary: summarizeOutcome(result.outcome, afterUrl),
      });

      lastConfusion = decision.confusion;
      left = result.left;
      gaveUp = leftInExhaustion({
        left,
        confusion: decision.confusion,
        noProgressSteps,
        patience: config.persona.patience,
      });

      await extraction.dispose();
      await result.after?.dispose();

      // Both end-of-step signals are snapshot for THIS step before the stop check, so a step
      // that both matches the criteria and fires the belief resolves as `criteria matched`.
      criteriaMatched = criteriaMet(
        criteria,
        afterUrl,
        criteriaConfigured(criteria) ? await visibleText(page) : '',
      );
      believesFiredNow = believes.push(decision.goalMet);
      looped = detectLoop(rows).looped;

      if (criteriaMatched || believesFiredNow || gaveUp || left || looped) break;
      if (step === config.maxSteps) maxStepsReached = true;
    }
  } finally {
    monitor?.dispose();
    await context.close();
  }

  const resolved = resolveOutcome({
    criteria,
    criteriaMatched,
    believesDoneFired: believesFiredNow,
    gaveUp,
    left,
    lastGoalMet: rows[rows.length - 1]?.goalMet ?? 0,
    maxStepsReached,
    looped,
  });

  const toolIssues = rows.filter((r) => r.bucket === 'tool' || r.bucket === 'stale');
  const reportable = rows.filter((r) => r.bucket !== 'tool' && r.bucket !== 'stale');

  const journey: Journey = {
    summary: {
      runId,
      persona: { name: config.persona.name },
      browserLocale: browserLocaleFor(config.persona),
      device: config.persona.device,
      seed: config.seed,
      outcome: {
        needMet: fatalToolFailure ? false : resolved.needMet,
        gaveUp,
        left,
        believedDone: believesFiredNow,
        reason: fatalToolFailure ? `tool failure: ${fatalToolFailure}` : resolved.reason,
        bucket: fatalToolFailure ? 'tool' : (resolved.bucketHint ?? journeyBucket(rows)),
        totalSteps: rows.length,
        totalDurationMs: Date.now() - journeyStart,
        outcomeFindings: fatalToolFailure ? [] : resolved.findings,
      },
      perUrl: [],
    },
    rows,
    toolIssues,
    runIssues,
  };
  journey.summary.perUrl = aggregatePerUrl([{ ...journey, rows: reportable }]);
  return journey;
}

/** What a tool-failure row can still say about the page the step was on. */
interface RowSnapshot {
  url: string;
  stateHash: string;
  viewHash: string;
  viewport: { width: number; height: number };
  elementsCount: number;
  droppedElements: number;
}

function snapshotOf(extraction: Extraction): RowSnapshot {
  return {
    url: extraction.state.meta.url,
    stateHash: extraction.state.stateHash,
    viewHash: extraction.state.viewHash,
    viewport: extraction.state.meta.viewport,
    elementsCount: extraction.state.elements.length,
    droppedElements: extraction.state.meta.droppedElements,
  };
}

/**
 * The page could not be read at all, so only its URL is known. The hashes stay empty rather
 * than invented: an empty hash matches no real state, so it cannot fake a backtrack or a
 * repeat for the steps that follow. The viewport is the last one actually measured.
 */
function unreadableSnapshot(page: Page, rows: TraceRow[]): RowSnapshot {
  return {
    url: page.url(),
    stateHash: '',
    viewHash: '',
    viewport: rows[rows.length - 1]?.viewport ?? { width: 0, height: 0 },
    elementsCount: 0,
    droppedElements: 0,
  };
}

/** A row for a step the tool could not carry out: no decision, or no readable page. */
function toolFailureRow(
  step: number,
  snapshot: RowSnapshot,
  options: Option[],
  failure: ToolFailure,
  decideMs: number,
  decideRetryMs: number,
): TraceRow {
  return {
    step,
    timestamp: Date.now(),
    url: snapshot.url,
    stateHash: snapshot.stateHash,
    viewHash: snapshot.viewHash,
    viewport: snapshot.viewport,
    elementsCount: snapshot.elementsCount,
    droppedElements: snapshot.droppedElements,
    options,
    distribution: {},
    pruned: {},
    sampled: '',
    sampledName: `(${failure})`,
    argmax: '',
    exploration: false,
    confidence: 0,
    entropy: 0,
    goalMet: 0,
    confusion: 0,
    outcome: {
      urlChanged: false,
      stateChanged: false,
      error: failure,
      errorClass: failure,
      consoleErrors: [],
      failedRequests: [],
      validationMessages: [],
      durationMs: 0,
    },
    timing: { extractMs: 0, decideMs, decideRetryMs, executeMs: 0, settleMs: 0 },
    flags: ['failed-action'],
    bucket: 'tool',
    stateChars: 0,
    inputTokens: 0,
    visibleTextChars: 0,
    seenTextChars: 0,
    scrollOnly: false,
  };
}
