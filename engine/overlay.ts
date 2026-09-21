// engine/overlay.ts
// Overlay detection and dismissal.

import type { Frame, Page } from 'playwright';
import type { OverlayDismissal, PageState } from './types';
import type { Extraction } from './extract';
import { CLICK_TIMEOUT_MS, escapeRegExp, originOf } from './util';

/**
 * Dismiss keywords, most specific first.
 * They are stems: matched at a word start, with no trailing boundary, so `zamknij`
 * matches `Zamknij` while `ok` cannot match the `ok` buried inside `cookie`.
 *
 * Accept / agree (and their translations) are consent choices, not dismissals. Clicking
 * them silently records a decision the persona never made. They live in `CONSENT_KEYWORDS`.
 */
export const DISMISS_KEYWORDS = [
  'ok',
  'close',
  'dismiss',
  'skip',
  'got it',
  'zamknij',
  'rozumiem',
  'закрити',
  'зрозуміло',
  'закрыть',
  'понятно',
  '×',
] as const;

/**
 * Consent choices. A banner that says one of these is an overlay the persona must answer;
 * none of them is a control `dismissOverlay` may click on its own.
 */
export const CONSENT_KEYWORDS = [
  'accept',
  'agree',
  'akceptuj',
  'zgadzam',
  'прийняти',
  'погоджуюсь',
  'принять',
  'согласен',
] as const;

/** Fraction of the top-level viewport a pinned ancestor must cover to be an overlay on area alone. */
export const OVERLAY_AREA_RATIO = 0.2;

const LETTER_STEMS = DISMISS_KEYWORDS.filter((k) => /\p{L}/u.test(k));
const SYMBOLS = DISMISS_KEYWORDS.filter((k) => !/\p{L}/u.test(k));

const STEM_PATTERN = `(?<!\\p{L})(?:${LETTER_STEMS.map(escapeRegExp).join('|')})`;
const CONSENT_PATTERN = `(?<!\\p{L})(?:${CONSENT_KEYWORDS.map(escapeRegExp).join('|')})`;

/** No `g` flag, so the regex carries no `lastIndex` state between calls and can be shared. */
const STEM_RE = new RegExp(STEM_PATTERN, 'iu');
const CONSENT_RE = new RegExp(CONSENT_PATTERN, 'iu');

export function isDismissName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SYMBOLS.some((s) => lower.includes(s))) return true;
  return STEM_RE.test(lower);
}

/** True when `text` names a consent choice (Accept / Agree and translations), not a close control. */
export function isConsentText(text: string): boolean {
  return CONSENT_RE.test(text.toLowerCase());
}

const REJECT_RE = /(?<![\p{L}])(?:reject|odrzuc|відхил|отклон)/iu;

/** A banner control the persona should be offered: accept, reject, or a plain close. */
export function isBannerChoiceName(name: string): boolean {
  return isConsentText(name) || isDismissName(name) || REJECT_RE.test(name);
}

/**
 * A consent layer injected after extract (typical CMP) and before the screenshot.
 * The decision was made on a page that did not yet offer closing the banner.
 */
export function lateConsentAppeared(
  before: {
    stateHash: string;
    elements: Array<{ name: string; overlay: boolean; dismissesOverlay: boolean }>;
  },
  after: {
    stateHash: string;
    elements: Array<{ name: string; overlay: boolean; dismissesOverlay: boolean }>;
  },
): boolean {
  if (before.stateHash === after.stateHash) return false;
  const known = new Set(before.elements.map((e) => e.name));
  return after.elements.some(
    (e) => !known.has(e.name) && (e.overlay || e.dismissesOverlay || isBannerChoiceName(e.name)),
  );
}

export type OverlayDismissPlan = 'control' | 'defer' | 'escape';

/**
 * What to do when a click target sits under an overlay.
 * A plain close/dismiss/skip control may be clicked. Consent choices (Accept / Reject / Manage)
 * must be left for the persona. With neither, Escape is the only remaining attempt.
 */
export function overlayDismissPlan(
  elements: Array<{ overlay: boolean; dismissesOverlay: boolean }>,
): OverlayDismissPlan {
  if (elements.some((e) => e.dismissesOverlay)) return 'control';
  if (elements.some((e) => e.overlay && !e.dismissesOverlay)) return 'defer';
  return 'escape';
}

/** A viewport-relative box, in the coordinates of the frame that measured it. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface OccluderJudgement {
  /** The occluder's box as its own frame measured it. */
  rect: Rect;
  /** On-screen position of that frame in the top-level viewport; `{x: 0, y: 0}` for the main frame. */
  frameOffset: { x: number; y: number };
  /** The top-level viewport, never the frame's own. */
  topViewport: { width: number; height: number };
  /** The occluder's text plus any `aria-label`s under it. */
  text: string;
}

/**
 * Is a pinned occluder an overlay? Either it covers more than
 * `OVERLAY_AREA_RATIO` of the **top-level** viewport, or it carries a dismiss keyword.
 *
 * The area is always judged against the top page, never against the frame that measured the
 * rect: a banner filling a 300x250 iframe covers 100% of that frame and 8% of a 1280x720 page,
 * and treating it as a consent veil would send the step off dismissing a sticky header.
 * `annotateOverlays` applies the same rule inside the browser, where it cannot call this.
 *
 * The keyword arm here has no "covers an interactive element" test, unlike the annotator's:
 * callers pass the element that was found covering the target's own centre, so that condition
 * is already met by construction.
 */
export function isOverlayOccluder(input: OccluderJudgement): boolean {
  const { rect, frameOffset, topViewport, text } = input;
  const topArea = topViewport.width * topViewport.height;
  if (topArea > 0) {
    const width = Math.max(
      0,
      Math.min(rect.right + frameOffset.x, topViewport.width) -
        Math.max(rect.left + frameOffset.x, 0),
    );
    const height = Math.max(
      0,
      Math.min(rect.bottom + frameOffset.y, topViewport.height) -
        Math.max(rect.top + frameOffset.y, 0),
    );
    if ((width * height) / topArea > OVERLAY_AREA_RATIO) return true;
  }
  return isDismissName(text) || isConsentText(text);
}

interface AnnotateArgs {
  stems: string;
  symbols: string[];
  consentStems: string;
  ratio: number;
  topWidth: number;
  topHeight: number;
  offsetX: number;
  offsetY: number;
}

interface AnnotateFlag {
  overlay: boolean;
  /** Centre is covered by an open overlay; the element must not be offered. */
  covered: boolean;
}

/**
 * Browser-side annotator. Serialized by Playwright, so it may not close over Node scope.
 * Returns one `{overlay, covered}` flag per element of `window.__uxExtract.elements`, in that order.
 *
 * Every rect is translated by the frame's on-screen offset and judged against the top-level
 * viewport, so a panel that fills a small iframe is not mistaken for a full-page overlay.
 *
 * `covered` is an elementFromPoint check: the topmost hit is neither the element nor a
 * descendant, and it lies in a dialog / aria-modal or in a fixed/sticky layer big enough
 * (or consent/dismiss-worded enough) to be an overlay. Page chrome under that threshold
 * stays, so a sticky header can still be scrolled clear of at click time.
 */
/* c8 ignore start -- runs inside the browser */
function annotateInFrame(arg: AnnotateArgs): AnnotateFlag[] {
  const stash = (window as unknown as { __uxExtract?: { elements: Element[] } }).__uxExtract;
  const elements = stash?.elements ?? [];
  const stemRe = new RegExp(arg.stems, 'iu');
  const consentRe = new RegExp(arg.consentStems, 'iu');
  const topArea = arg.topWidth * arg.topHeight;

  function hasDismissText(value: string): boolean {
    const lower = value.toLowerCase();
    return arg.symbols.some((s) => lower.includes(s)) || stemRe.test(lower);
  }

  function hasConsentText(value: string): boolean {
    return consentRe.test(value.toLowerCase());
  }

  function layerText(node: Element): string {
    const labels = [node, ...Array.from(node.querySelectorAll('[aria-label]'))]
      .map((n) => n.getAttribute('aria-label') || '')
      .join(' ');
    return `${node.textContent || ''} ${labels}`;
  }

  // Frame-local viewport coordinates shifted into the top page's viewport coordinates.
  function boxOf(el: Element): { left: number; top: number; right: number; bottom: number } {
    const r = el.getBoundingClientRect();
    return {
      left: r.left + arg.offsetX,
      top: r.top + arg.offsetY,
      right: r.right + arg.offsetX,
      bottom: r.bottom + arg.offsetY,
    };
  }

  function pinnedAncestor(el: Element): Element | null {
    let node: Node | null = el;
    while (node) {
      if (node instanceof Element) {
        const position = getComputedStyle(node).position;
        if (position === 'fixed' || position === 'sticky') return node;
      }
      const parent: Node | null = node.parentNode;
      node = parent instanceof ShadowRoot ? parent.host : parent;
    }
    return null;
  }

  const cache = new Map<Element, boolean>();

  function isOverlay(pinned: Element): boolean {
    const cached = cache.get(pinned);
    if (cached !== undefined) return cached;

    const box = boxOf(pinned);
    const width = Math.max(0, Math.min(box.right, arg.topWidth) - Math.max(box.left, 0));
    const height = Math.max(0, Math.min(box.bottom, arg.topHeight) - Math.max(box.top, 0));
    let overlay = topArea > 0 && (width * height) / topArea > arg.ratio;

    if (!overlay) {
      const text = layerText(pinned);
      if (hasDismissText(text) || hasConsentText(text)) {
        // The "interactive element" an overlay may be covering is exactly what
        // the extractor collected for this frame: the same roles, already filtered to the visible
        // ones and already walked through open shadow roots, which querySelectorAll cannot reach.
        for (const other of elements) {
          if (pinned.contains(other)) continue;
          const b = boxOf(other);
          if (b.right <= b.left || b.bottom <= b.top) continue;
          // The same four-edge in-viewport test the extractor applies to every element.
          if (!(b.left < arg.topWidth && b.right > 0 && b.top < arg.topHeight && b.bottom > 0))
            continue;
          const cx = (b.left + b.right) / 2;
          const cy = (b.top + b.bottom) / 2;
          if (cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom) {
            overlay = true;
            break;
          }
        }
      }
    }

    cache.set(pinned, overlay);
    return overlay;
  }

  function ownsHit(el: Element, hit: Element): boolean {
    if (hit === el || el.contains(hit)) return true;
    let node: Node | null = hit;
    while (node) {
      if (node === el) return true;
      const root = node.getRootNode();
      if (root instanceof ShadowRoot) node = root.host;
      else return false;
    }
    return false;
  }

  function overlayContainerOf(node: Element): Element | null {
    let current: Node | null = node;
    while (current) {
      if (current instanceof Element) {
        const role = (current.getAttribute('role') || '').toLowerCase();
        if (
          current.tagName === 'DIALOG' ||
          role === 'dialog' ||
          role === 'alertdialog' ||
          current.getAttribute('aria-modal') === 'true'
        ) {
          return current;
        }
        const position = getComputedStyle(current).position;
        if (position === 'fixed' || position === 'sticky') {
          const box = boxOf(current);
          const width = Math.max(0, Math.min(box.right, arg.topWidth) - Math.max(box.left, 0));
          const height = Math.max(0, Math.min(box.bottom, arg.topHeight) - Math.max(box.top, 0));
          const large = topArea > 0 && (width * height) / topArea > arg.ratio;
          const text = layerText(current);
          if (large || hasDismissText(text) || hasConsentText(text)) return current;
        }
      }
      const parent: Node | null = current.parentNode;
      current = parent instanceof ShadowRoot ? parent.host : parent;
    }
    return null;
  }

  function coveredByOverlay(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cx < 0 || cy < 0 || cx >= window.innerWidth || cy >= window.innerHeight) return false;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || ownsHit(el, hit)) return false;
    return overlayContainerOf(hit) !== null;
  }

  return elements.map((el) => {
    const pinned = pinnedAncestor(el);
    return {
      overlay: pinned ? isOverlay(pinned) : false,
      covered: coveredByOverlay(el),
    };
  });
}
/* c8 ignore stop */

/**
 * Set `overlay` and `dismissesOverlay` on every element of `state`, in place.
 *
 * An element is in an overlay when its nearest fixed/sticky ancestor covers over 20% of the
 * top-level viewport, or contains a dismiss or consent keyword and covers the centre of at least
 * one in-viewport interactive element. One `evaluate` per frame annotates every element of that
 * frame, by reading the element array `extract` stashed on `window.__uxExtract`.
 *
 * Returns the ids whose centres are covered by an open overlay. `extract` drops those after
 * annotation so a small consent bar is still recognised from the control it hides.
 *
 * Only `extract()` may call this, and only within the same call that read the frames: it relies on
 * that read's `window.__uxExtract` stash and on the `NAME_SHIM` that `readFrame` installed per
 * frame, neither of which it sets up itself.
 */
export async function annotateOverlays(page: Page, state: PageState): Promise<string[]> {
  const coveredIds: string[] = [];
  const top = state.meta.viewport;
  if (top.width <= 0 || top.height <= 0) return coveredIds;

  const byFrame = new Map<string, string[]>();
  for (const el of state.elements) {
    const prefix = el.id.includes(':') ? `${el.id.split(':')[0]}:` : '';
    const ids = byFrame.get(prefix);
    if (ids) ids.push(el.id);
    else byFrame.set(prefix, [el.id]);
  }
  const byId = new Map(state.elements.map((el) => [el.id, el]));

  // extract() numbers `fN:` over the SAME-ORIGIN child frames only, skipping cross-origin
  // ones, so the lookup here must filter identically or the ids would point at the wrong frame.
  const pageOrigin = originOf(page.url());
  const sameOriginFrames = page
    .frames()
    .filter(
      (f) =>
        f !== page.mainFrame() && originOf(f.url()) !== 'null' && originOf(f.url()) === pageOrigin,
    );

  for (const [prefix, ids] of byFrame) {
    const isMain = prefix === '';
    const frame: Frame | undefined = isMain
      ? page.mainFrame()
      : sameOriginFrames[Number.parseInt(prefix.slice(1, -1), 10) - 1];
    if (!frame) continue;

    // A frame measures rects against its own window; the frame element's on-screen box turns
    // them into top-level viewport coordinates. An unmeasurable box falls back to no shift,
    // which is what extract() does for the same frame's y offset.
    let offsetX = 0;
    let offsetY = 0;
    if (!isMain) {
      try {
        const frameEl = await frame.frameElement();
        const box = await frameEl.boundingBox();
        await frameEl.dispose();
        if (box) {
          offsetX = box.x;
          offsetY = box.y;
        }
      } catch {
        // keep the zero offset
      }
    }

    let flags: AnnotateFlag[];
    try {
      flags = await frame.evaluate(annotateInFrame, {
        stems: STEM_PATTERN,
        symbols: [...SYMBOLS],
        consentStems: CONSENT_PATTERN,
        ratio: OVERLAY_AREA_RATIO,
        topWidth: top.width,
        topHeight: top.height,
        offsetX,
        offsetY,
      });
    } catch {
      // A frame that navigated or detached since the read cannot be annotated.
      continue;
    }

    // `flags` is in the order the collector saw the elements, which is the order readFrame
    // assigned the `el_NN` ordinals in. Keying off the ordinal rather than the position in
    // `ids` keeps the mapping right when state.elements has been filtered since extraction.
    for (const id of ids) {
      const el = byId.get(id);
      if (!el) continue;
      const ordinal = Number.parseInt(id.slice(prefix.length).replace('el_', ''), 10);
      const flag = flags[ordinal - 1];
      if (flag === undefined) {
        throw new Error(
          `annotateOverlays: frame "${prefix || 'main'}" returned ${flags.length} flags, ` +
            `but element ${id} needs index ${ordinal - 1}`,
        );
      }
      el.overlay = flag.overlay;
      el.dismissesOverlay = flag.overlay && isDismissName(el.name);
      if (flag.covered) coveredIds.push(id);
    }
  }
  return coveredIds;
}

/**
 * Dismiss the current overlay: click its dismiss control, else press Escape.
 *
 * `dismissed` means a dismissal was carried out, not that the overlay is provably gone — neither
 * a click nor a key press proves that on its own, so the caller re-extracts and re-checks
 *. `dismissed: false` means nothing could even be attempted.
 */
export async function dismissOverlay(page: Page, ex: Extraction): Promise<OverlayDismissal> {
  const control = ex.state.elements.find((e) => e.dismissesOverlay);
  if (control) {
    const handle = ex.handles.get(control.id);
    if (handle) {
      try {
        await handle.click({ timeout: CLICK_TIMEOUT_MS });
        return { dismissed: true, method: 'control' };
      } catch {
        // The control may itself be covered or gone; fall through to Escape.
      }
    }
  }
  try {
    await page.keyboard.press('Escape');
    return { dismissed: true, method: 'escape' };
  } catch {
    return { dismissed: false, method: 'none' };
  }
}
