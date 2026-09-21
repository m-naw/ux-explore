// engine/execute.ts
// Executes one sampled option against the live page and captures the outcome.

import type { ElementHandle, Page } from 'playwright';
import type { Element as UxElement, Option, Outcome, OverlayDismissal } from './types';
import { extract, extractWithRetry, type Extraction } from './extract';
import { dismissOverlay, isOverlayOccluder, overlayDismissPlan, type Rect } from './overlay';
import { hasStateChanged } from './state-diff';
import { NAME_SHIM } from './name-shim';
import { timer } from './timing';
import type { PageMonitor } from './page-monitor';
import { CLICK_TIMEOUT_MS } from './util';

/** Fraction of the scroll container height moved per scroll action. */
export const SCROLL_FRACTION = 0.8;

/** How long to wait for scrollTop to move. */
export const SCROLL_SETTLE_MS = 500;

/** Poll interval while waiting for scrollTop to move. */
export const SCROLL_POLL_MS = 50;

/** Navigation wait after a URL change. */
export const NAV_TIMEOUT_MS = 5000;

/** Settle polling interval and cap. */
export const SETTLE_POLL_MS = 150;
export const SETTLE_MAX_MS = 1500;

/**
 * Longer cap for a click on something that navigates. A wizard that accepts the answer at
 * once and lands the next screen two or three seconds later looked, at 1,500ms, like a button
 * that did nothing, and the trace flagged the site for it. Polling stops the moment the page
 * changes, so an ordinary click still costs no more than it did.
 */
export const SETTLE_LATE_MS = 4000;

/** Roles for which a click is expected to move the page, and so earns the late settle. */
const NAVIGATING_ROLES = new Set(['link', 'button']);

/**
 * Ceiling on everything one step spends trying to touch its target: the first click, the
 * retry on a re-extracted handle, and every locator resolve and click after that. Each single
 * attempt is still capped at `CLICK_TIMEOUT_MS`; this caps how many of them a page that keeps
 * replacing its controls can draw out of one step.
 */
export const CLICK_PHASE_BUDGET_MS = 12_000;

/**
 * Extra pixels scrolled past a sticky header's own height, so the target clears its
 * bottom edge instead of landing exactly on it.
 */
export const STICKY_MARGIN_PX = 8;

/**
 * Playwright names the interceptor before the phrase: `<div class='veil'> intercepts pointer
 * events`. How it spells that element varies between versions -- 1.59 prints a closed
 * `<div></div>` -- so only the phrase is matched, and nothing reads the element in front of it.
 */
const INTERCEPT_PHRASE = /intercepts?\s+pointer\s+events/i;

/**
 * The step's target had no live handle. Thrown rather than described in a string, so
 * classification never depends on the wording of a message we write ourselves; the Playwright
 * patterns below are still matched by text, because those messages are not ours to change.
 */
export class DetachedHandleError extends Error {
  constructor(message = 'Element is not attached to the DOM (no handle for this step)') {
    super(message);
    this.name = 'DetachedHandleError';
  }
}

export function classifyExecuteError(err: unknown): string {
  if (err instanceof DetachedHandleError) return 'detached';
  const message = err instanceof Error ? err.message : String(err);
  if (INTERCEPT_PHRASE.test(message)) return 'intercepted';
  if (/not attached to the DOM|Node is detached|element is detached/i.test(message))
    return 'detached';
  if (/Execution context was destroyed|frame was detached|navigation/i.test(message))
    return 'navigation';
  if (/Timeout \d+ms exceeded/i.test(message)) return 'timeout';
  return 'unknown';
}

/**
 * Install the `__name` shim in the current document. Serialized `page.evaluate` callbacks
 * carry tsx's `__name(...)` wrappers into the browser; see engine/name-shim.ts. Evaluated as
 * a source string, so tsx cannot rewrite the shim itself. A page that is mid-navigation has
 * no context to install into, and the caller retries on the next tick.
 */
async function installShim(page: Page): Promise<void> {
  try {
    await page.evaluate(NAME_SHIM);
  } catch {
    // Navigation in flight; the next sample re-installs.
  }
}

/* c8 ignore start -- runs inside the browser */
/** In-viewport `role|name` signature. No named declarations, so tsx adds no `__name`. */
function sampleSignature(): string {
  return Array.from(
    document.querySelectorAll(
      'a[href], button, input, select, textarea, [role=button], [role=link], [role=tab]',
    ),
  )
    .filter((el) => {
      // Elements inside an aria-live region are excluded, so a ticker never blocks the settle.
      if (el.closest('[aria-live]')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.bottom > 0;
    })
    .map((el) => {
      const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0] || '';
      const tag = el.tagName.toLowerCase();
      const inputType = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
      const role =
        explicit ||
        (tag === 'a'
          ? 'link'
          : tag === 'button'
            ? 'button'
            : tag === 'select'
              ? 'combobox'
              : tag === 'textarea'
                ? 'textbox'
                : inputType === 'checkbox' || inputType === 'radio'
                  ? inputType
                  : inputType === 'submit' ||
                      inputType === 'button' ||
                      inputType === 'reset' ||
                      inputType === 'image'
                    ? 'button'
                    : tag === 'input'
                      ? 'textbox'
                      : 'generic');
      const name = (
        el.getAttribute('aria-label') ||
        el.textContent ||
        el.getAttribute('value') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      return `${role}|${name}`;
    })
    .sort()
    .join('~');
}
/* c8 ignore stop */

/**
 * Wait until the in-viewport `role|name` signature is stable across two consecutive samples.
 * Two identical empty samples also count, so a page with no controls settles at once.
 */
/**
 * Timeouts for the click phase of one step, counting from its first attempt.
 *
 * Playwright reads `timeout: 0` as "wait forever", so a budget that has run out must never be
 * handed to it: the caller gets a detached-handle error instead, which is the honest verdict
 * when there is no time left to reach the element.
 */
export function clickPhaseBudget(now: () => number = () => performance.now()): () => number {
  let startedAt: number | null = null;
  return () => {
    if (startedAt === null) {
      startedAt = now();
      return CLICK_TIMEOUT_MS;
    }
    const remaining = CLICK_PHASE_BUDGET_MS - (now() - startedAt);
    if (remaining <= 0) throw new DetachedHandleError();
    return Math.min(CLICK_TIMEOUT_MS, remaining);
  };
}

/** One signature sample, or null while the document is being replaced. */
async function sampleSignatureSafe(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(sampleSignature);
  } catch {
    await installShim(page);
    return null;
  }
}

/**
 * Keep polling a click that should have moved the page but has not, at the settle cadence,
 * until the URL or the on-screen signature moves or `SETTLE_LATE_MS` is spent in total.
 *
 * A wizard that accepts the answer immediately and renders the next screen two or three
 * seconds later is indistinguishable, at 1,500ms, from a button that does nothing; the trace
 * then flags a working control and the report blames the site for it.
 */
async function settleLate(
  page: Page,
  startUrl: string,
  baseline: string | null,
  alreadyMs: number,
): Promise<number> {
  const stop = timer();
  const budget = SETTLE_LATE_MS - alreadyMs;
  while (stop() < budget) {
    await page.waitForTimeout(Math.min(SETTLE_POLL_MS, budget - stop()));
    if (page.url() !== startUrl) break;
    const signature = await sampleSignatureSafe(page);
    if (signature !== null && signature !== baseline) break;
  }
  return alreadyMs + stop();
}

export async function settle(page: Page, maxMs: number = SETTLE_MAX_MS): Promise<number> {
  const stop = timer();
  await installShim(page);
  let previous: string | null = null;
  for (;;) {
    // The deadline is checked before every evaluate and before every sleep, and the
    // last sleep is trimmed, so settle() cannot overrun maxMs by a whole poll interval.
    if (stop() >= maxMs) break;
    let signature: string | null;
    try {
      signature = await page.evaluate(sampleSignature);
    } catch {
      // Navigation in flight: not a sample, try again on the next tick.
      signature = null;
      await installShim(page);
    }
    if (signature !== null && signature === previous) break;
    previous = signature;
    const remaining = maxMs - stop();
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(SETTLE_POLL_MS, remaining));
  }
  return stop();
}

export interface OcclusionCheck {
  clear: boolean;
  /** The topmost occluder sits inside a fixed/sticky ancestor. */
  pinned: boolean;
  pinnedHeight: number;
  /** That pinned ancestor looks like a dismissible overlay, not page furniture. */
  pinnedIsOverlay: boolean;
  /**
   * Which way to move the page to clear a pinned non-overlay: `1` scrolls down, for a bar
   * pinned to the bottom of the viewport, `-1` scrolls up, for a header pinned to the top.
   */
  rescueDirection: 1 | -1;
}

/** What the browser can see on its own: geometry and text, in the occluder frame coordinates. */
interface OcclusionProbe {
  clear: boolean;
  pinned: boolean;
  pinnedRect: Rect | null;
  pinnedText: string;
  /** Free space above and below the occluder inside its own frame's viewport. */
  spaceAbove: number;
  spaceBelow: number;
}

/* c8 ignore start -- runs inside the browser */
function probeOcclusion(node: Node): OcclusionProbe {
  const empty = {
    clear: false,
    pinned: false,
    pinnedRect: null,
    pinnedText: '',
    spaceAbove: 0,
    spaceBelow: 0,
  };
  const el = node as Element;
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const stack = document.elementsFromPoint(cx, cy);
  const top = stack[0] ?? null;

  // Spec: the element itself or a descendant. An ancestor is still an occlusion.
  if (top && (top === el || el.contains(top))) return { ...empty, clear: true };

  // An empty stack means the centre is off-screen or covered by nothing reachable:
  // either way it is not clickable.
  if (!top) return { ...empty };

  let pinned: Element | null = null;
  let cur: Node | null = top;
  while (cur) {
    if (cur instanceof Element) {
      const p = getComputedStyle(cur).position;
      if (p === 'fixed' || p === 'sticky') {
        pinned = cur;
        break;
      }
    }
    const parent: Node | null = cur.parentNode;
    cur = parent instanceof ShadowRoot ? parent.host : parent;
  }
  if (!pinned) return { ...empty };

  const box = pinned.getBoundingClientRect();
  const labels = [pinned, ...Array.from(pinned.querySelectorAll('[aria-label]'))]
    .map((n) => n.getAttribute('aria-label') || '')
    .join(' ');

  return {
    clear: false,
    pinned: true,
    pinnedRect: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
    pinnedText: `${pinned.textContent || ''} ${labels}`,
    spaceAbove: box.top,
    spaceBelow: window.innerHeight - box.bottom,
  };
}
/* c8 ignore stop */

/**
 * On-screen position of the frame that owns this handle, in top-level viewport coordinates.
 * The main frame needs no shift. Same pattern as `annotateOverlays`, including the fallback to
 * no shift for a frame whose box cannot be measured.
 */
async function frameOffsetOf(
  page: Page,
  handle: ElementHandle<Node>,
): Promise<{ x: number; y: number }> {
  try {
    const frame = await handle.ownerFrame();
    if (!frame || frame === page.mainFrame()) return { x: 0, y: 0 };
    const frameEl = await frame.frameElement();
    const box = await frameEl.boundingBox();
    await frameEl.dispose();
    return box ? { x: box.x, y: box.y } : { x: 0, y: 0 };
  } catch {
    return { x: 0, y: 0 };
  }
}

/**
 * Is the element's centre clickable? Spec section 6: `elementsFromPoint` must return
 * the element or a descendant. An ancestor on top, or an empty stack, is an occlusion.
 * The overlay-vs-sticky verdict is read off the actual occluder, never off some other
 * overlay elsewhere on the page, and it is judged against the top-level viewport, which is
 * why the caller supplies the frame offset.
 */
async function checkOcclusion(
  handle: ElementHandle<Node>,
  frameOffset: { x: number; y: number },
  topViewport: { width: number; height: number },
): Promise<OcclusionCheck> {
  const probe = await handle.evaluate(probeOcclusion);
  if (!probe.pinned || !probe.pinnedRect) {
    return {
      clear: probe.clear,
      pinned: false,
      pinnedHeight: 0,
      pinnedIsOverlay: false,
      rescueDirection: -1,
    };
  }
  return {
    clear: false,
    pinned: true,
    pinnedHeight: Math.ceil(probe.pinnedRect.bottom - probe.pinnedRect.top),
    pinnedIsOverlay: isOverlayOccluder({
      rect: probe.pinnedRect,
      frameOffset,
      topViewport,
      text: probe.pinnedText,
    }),
    // Which viewport edge the occluder hugs decides the way out, because that is the side with
    // no room on it. A target under a top-pinned header has to travel down the screen (scroll
    // up); one under a bottom-pinned bar has to travel up it (scroll down). Comparing the two
    // centres instead would send a target sitting near the top edge of a 120px header upwards,
    // straight off the screen.
    rescueDirection: probe.spaceAbove <= probe.spaceBelow ? -1 : 1,
  };
}

export interface ExecuteContext {
  page: Page;
  extraction: Extraction;
  option: Option;
  monitor: PageMonitor;
  reExtract: () => Promise<Extraction>;
}

export interface ExecuteResult {
  outcome: Outcome;
  settleMs: number;
  stale: boolean;
  overlayBlocked: boolean;
  /**
   * How the step tried to get rid of an overlay covering its target. Absent when no overlay
   * was in the way. Without it, an `overlay-blocked` flag could not be told apart from an
   * Escape press that was never going to close a consent banner.
   */
  overlayDismissal?: OverlayDismissal;
  /**
   * The persona chose `leave`. The journey is over; the page was not touched, nothing was
   * settled and nothing was re-extracted, so `after` is the very extraction this step was
   * handed — the same object, not a fresh read. The caller must not dispose it twice.
   */
  left: boolean;
  scrollChangedY: boolean;
  /**
   * A `type:` or `select:` step left the control holding a different value than it did
   * before. Filling a form in place moves the persona forward without changing the state
   * hash, so this is the other half of the progress rule.
   */
  valueChanged: boolean;
  /** Role of the element the step acted on, so `no-change` can be limited to link/button/submit. */
  targetRole?: string;
  /** `input[type]` of the element the step acted on, for the same reason. */
  targetInputType?: string;
  /**
   * Which route reached the target: its own handle, the handle a re-extract produced, or a
   * role+name locator. Carried into the trace so a run that leans on the fallbacks says so
   * instead of looking like an ordinary one.
   */
  clickPath?: ClickPath;
  /**
   * The page changed only after the step had given up on it: every handle detached, yet the
   * URL or the signature moved. The action happened, and the step is a success that took
   * longer than the settle window.
   */
  lateTransition?: boolean;
  /**
   * Post-action extraction, which the caller owns disposing. Absent after a `leave`: the page
   * was never touched, so there is nothing new to read and the caller still holds the
   * extraction the step started from.
   */
  after?: Extraction;
}

/** Which route reached the target. See `ExecuteResult.clickPath`. */
export type ClickPath = 'handle' | 'retry' | 'locator';

/**
 * What the pre-click phase learned, recorded as it happens rather than returned.
 * A click on a covered target throws, and the throw must not take the reason with it:
 * `overlayBlocked` is precisely the diagnosis of a step whose click then failed, and a
 * scratch extraction nobody hears about would leak its handles.
 */
interface ClickState {
  overlayBlocked: boolean;
  /** The last dismissal this step attempted, recorded whether or not it worked. */
  overlayDismissal?: OverlayDismissal;
  /**
   * The overlay has its own choices and no plain close control. The click was not attempted
   * and consent was not accepted; the next extraction offers those choices.
   */
  overlayDeferred: boolean;
  /** Re-extractions taken while clearing an overlay. The caller disposes them. */
  scratches: Extraction[];
}

/** Click one handle, handling a sticky occluder and an overlay once each. */
async function clickWithPreChecks(
  ctx: ExecuteContext,
  handle: ElementHandle<Node>,
  state: ClickState,
  nextTimeout: () => number,
): Promise<void> {
  // Each attempt starts from a clean sheet: a retry on a fresh handle must not inherit the
  // verdict of the attempt on the stale one.
  state.overlayBlocked = false;
  state.overlayDeferred = false;
  delete state.overlayDismissal;

  await handle.scrollIntoViewIfNeeded({ timeout: nextTimeout() });

  const topViewport = ctx.extraction.state.meta.viewport;
  const frameOffset = await frameOffsetOf(ctx.page, handle);
  const occlusion = await checkOcclusion(handle, frameOffset, topViewport);

  if (!occlusion.clear && occlusion.pinned) {
    if (occlusion.pinnedIsOverlay) {
      const plan = overlayDismissPlan(ctx.extraction.state.elements);
      if (plan === 'defer') {
        state.overlayBlocked = true;
        state.overlayDeferred = true;
        return;
      }
      // dismissOverlay() counts Escape as a dismissal, so it is only ever called once an
      // overlay was actually detected on the occluder, and the re-check is what decides.
      // `defer` already returned: a consent dialog with no close control is not Escaped away.
      state.overlayDismissal = await dismissOverlay(ctx.page, ctx.extraction);
      // Dismissing an overlay usually unlocks the page, and unlocking it can resize the
      // viewport (a scroll bar comes back). The re-check measures against the viewport the
      // fresh extraction reports rather than the one taken before the dismissal.
      const refreshed = await ctx.reExtract();
      state.scratches.push(refreshed);
      const after = await checkOcclusion(handle, frameOffset, refreshed.state.meta.viewport);
      state.overlayBlocked = !after.clear;
    } else {
      // A pinned header or bar: scroll the element out from under it, in the element's own
      // window — scrolling the top page would carry an iframe and its sticky header together
      // and leave the target exactly as covered as it was.
      const dy = occlusion.rescueDirection * (occlusion.pinnedHeight + STICKY_MARGIN_PX);
      await handle.evaluate((_node, delta: number) => window.scrollBy(0, delta), dy);
      // No second check here: if the rescue did not free the target, Playwright's own
      // hit-target check is the authority and its failure is reported as `intercepted`.
    }
  }

  await handle.click({ timeout: nextTimeout() });
}

/**
 * The ARIA roles `page.getByRole` accepts. An extractor role that is not one of them — a
 * custom `role="carousel-slide"`, say — would make the locator throw a usage error that reads
 * nothing like the missing element it actually describes.
 */
const ARIA_ROLES = new Set([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'meter',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
]);

/**
 * Accessible names are trimmed by the extractor, so a long one is a prefix of what the page
 * really renders and an exact match would never find it.
 */
const EXACT_NAME_MAX = 80;

/**
 * Resolve the target through a role+name locator rather than through a handle.
 *
 * A handle points at one node, so a component that re-renders on a timer detaches every handle
 * taken from it, including the one a re-extract just produced. A locator is re-resolved on each
 * attempt, which is what lets the step reach the button a person can still plainly see. `nth`
 * keeps the one the extraction sampled when a page carries several with the same role and name.
 *
 * A handle comes back rather than a click, so the caller can put it through the same occlusion,
 * sticky-header and overlay pre-checks every other click gets: a fallback that skipped them
 * would report a covered button as a bare timeout.
 */
async function handleByRoleAndName(
  page: Page,
  target: UxElement | undefined,
  extraction: Extraction,
  timeoutMs: number,
): Promise<ElementHandle<Node>> {
  // A framed id (`f1:el_04`) is not reachable from the top-level page's locators, and guessing
  // which frame to search would be a second, divergable answer to a question the handle
  // already answered.
  if (!target || !target.name || target.id.includes(':') || !ARIA_ROLES.has(target.role)) {
    throw new DetachedHandleError();
  }
  const sameRoleAndName = extraction.state.elements.filter(
    (e) => e.role === target.role && e.name === target.name,
  );
  const index = sameRoleAndName.findIndex((e) => e.id === target.id);
  // The extraction the index came from no longer contains the target, so `nth(0)` would be a
  // guess at which of several identically named controls the persona chose. Refuse instead.
  if (index === -1) throw new DetachedHandleError();

  let handle: ElementHandle<Node> | null;
  try {
    handle = await page
      .getByRole(target.role as Parameters<Page['getByRole']>[0], {
        name: target.name,
        exact: target.name.length < EXACT_NAME_MAX,
      })
      .nth(index)
      .elementHandle({ timeout: timeoutMs });
  } catch (err) {
    // Only a timeout means "not on the page under that name", which is the stale verdict.
    // Anything else — an interception, a navigation mid-resolve — is the step's real error
    // and must reach `classifyExecuteError` as itself rather than disguised as a detachment.
    if (classifyExecuteError(err) !== 'timeout') throw err;
    throw new DetachedHandleError();
  }
  // A locator that matches nothing can also resolve to null rather than throwing.
  if (!handle) throw new DetachedHandleError();
  return handle;
}

/**
 * The `value` of a form control, or null when it cannot be read — a control with no `value`
 * property, or a handle whose document has gone. Null on either side means "unknown", which
 * never counts as a change.
 */
async function controlValue(handle: ElementHandle<Node>): Promise<string | null> {
  try {
    return await handle.evaluate((node) => {
      const value = (node as HTMLInputElement).value;
      return typeof value === 'string' ? value : null;
    });
  } catch {
    return null;
  }
}

interface ScrollTargetWindow extends Window {
  __uxScrollTarget?: Element | null;
}

/**
 * Scroll the largest scrollable ancestor under the viewport center by `0.8 * clientHeight`
 *, then report whether its scrollTop actually moved. The container is
 * stashed on `window` so the poll reads the same element the scroll acted on; a widget
 * that scrolls internally would otherwise look frozen next to an unchanged `window.scrollY`.
 */
async function scrollViewport(page: Page, direction: 1 | -1): Promise<boolean> {
  const start = await page.evaluate(
    ({ dir, fraction }: { dir: number; fraction: number }) => {
      let best: Element | null = null;
      let bestArea = 0;
      let node: Element | null = document.elementFromPoint(
        window.innerWidth / 2,
        window.innerHeight / 2,
      );
      while (node) {
        const style = getComputedStyle(node);
        const scrollable =
          node.scrollHeight > node.clientHeight &&
          (style.overflowY === 'auto' || style.overflowY === 'scroll');
        // The LARGEST scrollable ancestor, not the nearest: a small scrollable widget under
        // the center must not swallow a scroll meant for the region around it.
        if (scrollable && node.clientWidth * node.clientHeight >= bestArea) {
          best = node;
          bestArea = node.clientWidth * node.clientHeight;
        }
        node = node.parentElement;
      }
      (window as ScrollTargetWindow).__uxScrollTarget = best;
      const from = best ? best.scrollTop : window.scrollY;
      if (best) best.scrollBy(0, dir * fraction * best.clientHeight);
      else window.scrollBy(0, dir * fraction * window.innerHeight);
      return Math.round(from);
    },
    { dir: direction, fraction: SCROLL_FRACTION },
  );

  // A scroll can set a navigation going (an infinite scroller that redirects, a click that
  // landed first). The reads below then lose their context; that is not a scroll failure and
  // must not surface as the step's error, so the poll simply stops.
  const readTop = async (): Promise<number | null> => {
    try {
      return await page.evaluate(() => {
        const target = (window as ScrollTargetWindow).__uxScrollTarget;
        return Math.round(target ? target.scrollTop : window.scrollY);
      });
    } catch {
      return null;
    }
  };

  let moved = false;
  const deadline = Date.now() + SCROLL_SETTLE_MS;
  for (;;) {
    const top = await readTop();
    if (top === null) break;
    if (top !== start) {
      moved = true;
      break;
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(SCROLL_POLL_MS);
  }
  // Do not keep a reference to a node the next step may have replaced.
  try {
    await page.evaluate(() => {
      (window as ScrollTargetWindow).__uxScrollTarget = null;
    });
  } catch {
    // The document that held the reference is gone, which releases it anyway.
  }
  return moved;
}

export async function execute(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { page, extraction, option, monitor } = ctx;
  const before = extraction.state;
  const stop = timer();

  let clickPath: ClickPath = 'handle';
  const nextClickTimeout = clickPhaseBudget();
  let error: string | undefined;
  let errorClass: string | undefined;
  let stale = false;
  let scrollChangedY = false;
  let valueChanged = false;
  // Filled in as the click progresses, so a throw cannot erase what the pre-checks found.
  const clickState: ClickState = { overlayBlocked: false, overlayDeferred: false, scratches: [] };

  const scrollYBefore = before.meta.scrollY;
  const targetId = option.elementId ?? option.id;
  const target = before.elements.find((e) => e.id === targetId);

  // Leaving touches nothing: no shim, no click, no settle and no re-extract. Re-reading the
  // page here could only lose an already-finished journey to a navigation race, so no `after`
  // comes back and the caller keeps reading the extraction it already has.
  if (option.kind === 'leave') {
    return {
      outcome: {
        urlChanged: false,
        stateChanged: false,
        consoleErrors: [],
        failedRequests: [],
        validationMessages: before.meta.validationMessages,
        durationMs: stop(),
      },
      settleMs: 0,
      stale: false,
      overlayBlocked: false,
      left: true,
      scrollChangedY: false,
      valueChanged: false,
    };
  }

  await installShim(page);
  // Sampled before the action so the late-settle poll can tell "nothing has happened yet"
  // from "it happened and the page is now steady". One evaluate, the same one settle uses.
  const signatureBefore = await sampleSignatureSafe(page);

  try {
    switch (option.kind) {
      case 'back': {
        await page.goBack({ timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
        break;
      }
      case 'scroll_down':
      case 'scroll_up': {
        scrollChangedY = await scrollViewport(page, option.kind === 'scroll_down' ? 1 : -1);
        break;
      }
      case 'type': {
        const handle = extraction.handles.get(targetId);
        if (!handle) throw new DetachedHandleError();
        const valueBefore = await controlValue(handle);
        // A `<select>` also reports role `combobox`; only the option-less kind is typed into.
        const isCombobox = target?.role === 'combobox' && !target.selectOptions;
        // The focusing click gets the same pre-checks an element click gets, so a sticky header
        // is scrolled out of the way and an overlay that survives dismissal is reported as
        // `overlayBlocked` rather than as a bare timeout.
        await clickWithPreChecks(ctx, handle, clickState, nextClickTimeout);
        if (clickState.overlayDeferred) break;
        if (isCombobox) {
          // A combobox needs real keystrokes to open its suggestion list; fill() would not.
          await handle.fill('', { timeout: nextClickTimeout() });
          await page.keyboard.type(option.value ?? '', { delay: 20 });
          await page.keyboard.press('ArrowDown');
          await page.keyboard.press('Enter');
        } else {
          // fill() writes an ISO string straight into input[type=date], which is why
          // birthDate and arrivalDate are stored as ISO in the persona YAML.
          await handle.fill(option.value ?? '', { timeout: nextClickTimeout() });
        }
        await page.keyboard.press('Tab');
        valueChanged = valueBefore !== null && (await controlValue(handle)) !== valueBefore;
        break;
      }
      case 'select': {
        const handle = extraction.handles.get(targetId);
        if (!handle) throw new DetachedHandleError();
        const valueBefore = await controlValue(handle);
        await handle.scrollIntoViewIfNeeded({ timeout: nextClickTimeout() });
        await handle.selectOption({ value: option.value ?? '' }, { timeout: nextClickTimeout() });
        valueChanged = valueBefore !== null && (await controlValue(handle)) !== valueBefore;
        break;
      }
      case 'switch_language':
      case 'element': {
        const handle = extraction.handles.get(targetId);
        if (!handle) throw new DetachedHandleError();
        try {
          await clickWithPreChecks(ctx, handle, clickState, nextClickTimeout);
        } catch (err) {
          if (classifyExecuteError(err) !== 'detached') throw err;

          // One re-extract and one retry, matched by role|name|href.
          const retry = await ctx.reExtract();
          clickState.scratches.push(retry);
          const match = target
            ? retry.state.elements.find(
                (e) => e.role === target.role && e.name === target.name && e.href === target.href,
              )
            : undefined;
          const retryHandle = match ? retry.handles.get(match.id) : undefined;
          if (retryHandle) {
            try {
              clickPath = 'retry';
              await clickWithPreChecks(
                { ...ctx, extraction: retry },
                retryHandle,
                clickState,
                nextClickTimeout,
              );
              break;
            } catch (retryErr) {
              if (classifyExecuteError(retryErr) !== 'detached') throw retryErr;
            }
          }
          // Both handles died to the same re-render. Now try by role and name, which no
          // re-render can invalidate.
          clickPath = 'locator';
          const freshest = retry.state.elements.some((e) => e.id === (match?.id ?? targetId))
            ? retry
            : extraction;
          // Resolving a locator yields a handle, and on a page that re-renders every frame
          // that handle can die between being handed over and being clicked — the very
          // problem the fallback exists for. So the resolve and the click are retried
          // together, each attempt capped at CLICK_TIMEOUT_MS and the whole sequence at
          // CLICK_PHASE_BUDGET_MS counted from this step's first click. `nextClickTimeout`
          // throws rather than ever handing Playwright a zero, which it reads as "no timeout".
          for (;;) {
            const located = await handleByRoleAndName(
              page,
              match ?? target,
              freshest,
              nextClickTimeout(),
            );
            try {
              await clickWithPreChecks(
                { ...ctx, extraction: freshest },
                located,
                clickState,
                nextClickTimeout,
              );
              break;
            } catch (locatorErr) {
              const locatorClass = classifyExecuteError(locatorErr);
              // A detached node is the race this loop exists for. A timeout is the same race
              // seen from the other side: Playwright kept waiting for a control that keeps
              // being replaced. Anything else — an interception, a navigation — is the step's
              // real error and goes up as itself. A budget that has run out arrives here as
              // DetachedHandleError and ends the loop on the next `nextClickTimeout()`.
              if (locatorClass !== 'detached' && locatorClass !== 'timeout') throw locatorErr;
            } finally {
              await located.dispose().catch(() => undefined);
            }
          }
        }
        break;
      }
      default: {
        throw new Error(`Unsupported option kind: ${option.kind}`);
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    errorClass = classifyExecuteError(err);
    if (errorClass === 'detached') stale = true;
  }

  for (const scratch of clickState.scratches) {
    // Releasing handles is cleanup: if the action navigated away from the document that owned
    // them, they are gone already, and that must not become the step's reported error.
    try {
      await scratch.dispose();
    } catch {
      // Context destroyed; the handles died with it.
    }
  }

  // Only a decision about whether to wait: a document swap already in flight is worth waiting
  // for. It is NOT the outcome, because a client-side route change (history.pushState plus a
  // DOM swap) commits while settle runs, and sampling here would report `urlChanged: false`
  // for a step that did navigate.
  const navigatingAlready = page.url() !== before.meta.url;
  if (navigatingAlready) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS });
    } catch {
      // A slow document still gives us whatever is rendered; settle handles the rest.
    }
  }

  let settleMs = await settle(page);
  // A click on something that is supposed to move the page, which has not moved it yet: wait
  // out the longer window rather than calling a slow transition a dead control.
  const expectsMovement =
    (option.kind === 'element' || option.kind === 'switch_language') &&
    (NAVIGATING_ROLES.has(target?.role ?? '') || target?.inputType === 'submit');
  if (expectsMovement && page.url() === before.meta.url) {
    const settled = await sampleSignatureSafe(page);
    if (settled === null || settled === signatureBefore) {
      settleMs = await settleLate(page, before.meta.url, signatureBefore, settleMs);
    }
  }
  // A click that schedules a redirect can replace the document while this read runs; one
  // retry after the next DOMContentLoaded is enough, and a second failure reaches drive(),
  // which records it as a tool step rather than losing the journey.
  const after = await extractWithRetry(page);
  const drained = monitor.drain();

  // Every handle the step could reach was detached, yet the page moved: the action landed and
  // the re-renders were the transition itself. Reporting that as `stale` throws away a step
  // the persona completed, and hides a slow wizard behind a tool problem.
  let lateTransition = false;
  if (stale && (after.state.meta.url !== before.meta.url || hasStateChanged(before, after.state))) {
    lateTransition = true;
    stale = false;
    error = undefined;
    errorClass = undefined;
  }

  if (!scrollChangedY && (option.kind === 'scroll_down' || option.kind === 'scroll_up')) {
    scrollChangedY = after.state.meta.scrollY !== scrollYBefore;
  }

  const outcome: Outcome = {
    // Sampled after settle and the re-extract, off the state the rest of the row is built from.
    // Bounded by SETTLE_MAX_MS: a client-side route change that commits later than that still
    // reads as unchanged here, because the re-extraction happened before it landed.
    urlChanged: after.state.meta.url !== before.meta.url,
    stateChanged: hasStateChanged(before, after.state),
    ...(error ? { error } : {}),
    ...(errorClass ? { errorClass } : {}),
    consoleErrors: drained.consoleErrors,
    failedRequests: drained.failedRequests,
    validationMessages: after.state.meta.validationMessages,
    durationMs: stop(),
  };

  return {
    outcome,
    settleMs,
    stale,
    overlayBlocked: clickState.overlayBlocked,
    ...(clickState.overlayDismissal ? { overlayDismissal: clickState.overlayDismissal } : {}),
    // Only the early return above ever leaves; every other kind acted on the page.
    left: false,
    scrollChangedY,
    valueChanged,
    ...(target ? { targetRole: target.role } : {}),
    ...(target?.inputType ? { targetInputType: target.inputType } : {}),
    clickPath,
    ...(lateTransition ? { lateTransition } : {}),
    after,
  };
}
