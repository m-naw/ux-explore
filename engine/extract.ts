// engine/extract.ts
// Builds a PageState from a live page and hands back one ElementHandle per element.
// Handles live for the duration of one step; call dispose() when the step ends.

import { createHash } from 'node:crypto';
import type { ElementHandle, Frame, Page } from 'playwright';
import type { Element as UxElement, Landmark, PageState, TextBlock } from './types';
import { NAME_SHIM } from './name-shim';
import { annotateOverlays } from './overlay';
import { SELECT_OPTION_CAP } from './typed-input';
import { normalizeUrl, toRelativeHref } from './url-normalize';
import { inViewport } from './util';

/** Raw per-element data returned from the browser, in the same order as the handle array. */
interface RawDescriptor {
  role: string;
  name: string;
  href: string | null;
  inputType: string | null;
  hasValue: boolean;
  /** Trimmed current value of a text-like control; empty when there is none to report. */
  value: string;
  y: number;
  inViewport: boolean;
  landmark: string;
  sticky: boolean;
  inAriaLive: boolean;
  disabled: boolean;
  langCode: string | null;
  match: {
    autocomplete: string;
    name: string;
    id: string;
    label: string;
    placeholder: string;
    required: boolean;
  };
  selectOptions: Array<{ value: string; label: string }> | null;
  /** Present only for in-viewport elements; either field may be the empty string. */
  context?: { heading: string; near: string };
  tag: string;
  className: string;
}

interface RawMeta {
  url: string;
  title: string;
  lang: string;
  scrollY: number;
  scrollMax: number;
  viewport: { width: number; height: number };
  h1: string;
  mainText: string;
  visibleText: Array<{ text: string; landmark: string; inAriaLive: boolean }>;
  /** Every in-viewport block, before the `visibleText` budget drops any of them. */
  visibleTextAll: Array<{ text: string; landmark: string; inAriaLive: boolean }>;
  belowFoldTextChars: number;
  closedRoots: number;
  wizardProgress: string | null;
  validationMessages: string[];
}

interface FramePayload {
  descriptors: RawDescriptor[];
  meta: RawMeta;
}

/**
 * Browser-side collector. Serialized by Playwright, so it may not close over Node scope.
 * It stashes its JSON payload on `window.__uxExtract` and returns the element array, so the
 * descriptor read that follows sees exactly the elements the handles point at.
 */
/* c8 ignore start -- runs inside the browser */
function collectInFrame(options: { yOffset: number; selectOptionCap: number }): Node[] {
  const SELECTOR = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'select',
    'textarea',
    'summary',
    '[contenteditable]',
    '[role=button]',
    '[role=link]',
    '[role=tab]',
    '[role=menuitem]',
    '[role=checkbox]',
    '[role=radio]',
    '[role=combobox]',
    '[role=option]',
    '[role=switch]',
    'label[for]',
  ].join(',');

  let closedRoots = 0;

  function queryDeep(root: Document | ShadowRoot): Element[] {
    const found: Element[] = Array.from(root.querySelectorAll(SELECTOR));
    for (const node of Array.from(root.querySelectorAll('*'))) {
      const host = node as Element;
      if (host.shadowRoot) {
        found.push(...queryDeep(host.shadowRoot));
      } else if (host.tagName.includes('-') && host.childNodes.length === 0) {
        // A custom element with a closed root reports shadowRoot === null and has no light children.
        closedRoots += 1;
      }
    }
    return found;
  }

  function text(el: Element | null): string {
    return ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
  }

  function scopeOf(el: Element): Document | ShadowRoot {
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root : document;
  }

  function nameOf(el: Element): string {
    const scope = scopeOf(el);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => scope.querySelector(`#${CSS.escape(id)}`))
        .filter((n): n is Element => !!n)
        .map(text)
        .filter((t) => t.length > 0);
      if (parts.length > 0) return parts.join(' ');
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const id = el.getAttribute('id');
    if (id) {
      const t = text(scope.querySelector(`label[for="${CSS.escape(id)}"]`));
      if (t) return t;
    }
    const wrapping = el.closest('label');
    if (wrapping) {
      const t = text(wrapping);
      if (t) return t;
    }
    const own = text(el);
    if (own) return own;

    const alt = el.querySelector('img[alt]')?.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    const svgTitle = text(el.querySelector('svg > title'));
    if (svgTitle) return svgTitle;
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();

    if (el.tagName.toLowerCase() === 'input') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        const value = el.getAttribute('value');
        if (value && value.trim()) return value.trim();
      }
    }
    return '';
  }

  /**
   * The text of the control's associated label: a `label[for=id]` or a wrapping `<label>`, the
   * same association `nameOf` honours at its "associated label" step. Empty when there is none.
   * This is the `label` fact-matching hint, deliberately NOT the accessible name: an
   * `aria-label` names a control without giving it a label the persona can read.
   */
  function associatedLabelOf(el: Element): string {
    const scope = scopeOf(el);
    const id = el.getAttribute('id');
    if (id) {
      const forLabel = text(scope.querySelector(`label[for="${CSS.escape(id)}"]`));
      if (forLabel) return forLabel;
    }
    const wrapping = el.closest('label');
    if (wrapping) return text(wrapping);
    return '';
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit && explicit.trim()) return explicit.trim().split(/\s+/)[0]!;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image')
        return 'button';
      return 'textbox';
    }
    if (el.hasAttribute('contenteditable')) return 'textbox';
    return 'generic';
  }

  function isVisible(el: Element): boolean {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isVisuallyHidden(el: Element): boolean {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    if (parseFloat(cs.opacity || '1') === 0) return true;
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)') return true;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return true;
    if (r.right < 0 || r.bottom < 0) return true;
    return false;
  }

  function ancestors(el: Element): Element[] {
    const out: Element[] = [];
    let node: Node | null = el;
    while (node) {
      if (node instanceof Element) out.push(node);
      const parent: Node | null = node.parentNode;
      node = parent instanceof ShadowRoot ? parent.host : parent;
    }
    return out;
  }

  function landmarkOf(el: Element): string {
    for (const a of ancestors(el)) {
      const tag = a.tagName.toLowerCase();
      const role = (a.getAttribute('role') || '').toLowerCase();
      if (tag === 'form' || role === 'form') return 'form';
      if (tag === 'nav' || role === 'navigation') return 'nav';
      if (tag === 'header' || role === 'banner') return 'header';
      if (tag === 'footer' || role === 'contentinfo') return 'footer';
      if (tag === 'main' || role === 'main') return 'main';
    }
    return 'none';
  }

  /**
   * The primary subtag of a BCP 47 tag, lowercased: `pl-PL` -> `pl`, `uk_UA` -> `uk`.
   * `x-default` and anything else that is not a two or three letter language code becomes
   * the empty string, so a routing hint never reaches the persona as a language they read.
   * Duplicated in engine/jev-engine.ts as `primaryLanguageSubtag`: this copy is serialized
   * into the browser and so cannot import anything.
   */
  function primaryLang(value: string | null): string {
    const code = (value || '').trim().toLowerCase().split(/[-_]/)[0] || '';
    return /^[a-z]{2,3}$/.test(code) ? code : '';
  }

  /**
   * Whether the control is refusing input: natively disabled, disabled the ARIA way, or inside
   * a disabled fieldset. A click on one can only sit there until the action times out, so the
   * option builder needs to know. Called on the proxied target for a `label[for]` proxy.
   */
  function isDisabled(el: Element): boolean {
    return (
      el.matches(':disabled') ||
      el.getAttribute('aria-disabled') === 'true' ||
      inDisabledFieldset(el)
    );
  }

  /**
   * Inside a disabled fieldset, except in its first `<legend>`: the HTML spec keeps that legend's
   * controls interactive (it is how a form offers the switch that re-enables the section), and
   * `:disabled` agrees. Walks outward, because an outer disabled fieldset still wins.
   */
  function inDisabledFieldset(el: Element): boolean {
    let node: Element | null = el;
    while (node) {
      const fieldset: Element | null = node.closest('fieldset[disabled]');
      if (!fieldset) return false;
      const legend = fieldset.querySelector(':scope > legend');
      if (!legend || !legend.contains(el)) return true;
      node = fieldset.parentElement;
    }
    return false;
  }

  /**
   * Whether a checkbox or radio is currently ticked. `.value` is a static attribute on these
   * controls ("on" by default), so it says nothing about what the persona chose; only this does.
   */
  function isChecked(el: Element): boolean {
    if (el.getAttribute('aria-checked') === 'true') return true;
    return (el as HTMLInputElement).checked === true;
  }

  function proxyTargetOf(el: Element): Element | null {
    // `querySelector('#')` throws, so an empty or missing `for` is skipped outright.
    const forId = el.getAttribute('for') || '';
    if (!forId) return null;
    const target = scopeOf(el).querySelector(`#${CSS.escape(forId)}`);
    return target && isVisuallyHidden(target) ? target : null;
  }

  /**
   * The nearest ancestor that lays out as a block, which is the unit a reader perceives as one
   * paragraph. `contents` boxes are skipped because they have no box of their own, and
   * `document.body` is never the answer: grouping by body would make the whole page one block.
   * When the walk reaches body, the outermost element below it is the block instead.
   */
  function blockAncestorOf(el: Element): Element | null {
    let node: Element | null = el;
    let last: Element = el;
    while (node && node !== document.body && node.parentElement) {
      const display = getComputedStyle(node).display;
      if (display !== 'inline' && display !== 'inline-block' && display !== 'contents') return node;
      last = node;
      node = node.parentElement;
    }
    return last === document.body ? null : last;
  }

  /** 1..3 when the block is, or sits inside, an h1..h3; 0 otherwise. */
  function headingLevelOf(block: Element): number {
    const tag = block.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') return Number(tag[1]);
    const heading = block.closest('h1, h2, h3');
    return heading ? Number(heading.tagName[1]) : 0;
  }

  /** Every root the text walk visits: the document plus every open shadow root, nested ones included. */
  function collectTextRoots(
    root: Document | ShadowRoot,
    out: Array<Document | ShadowRoot>,
  ): Array<Document | ShadowRoot> {
    out.push(root);
    for (const node of Array.from(root.querySelectorAll('*'))) {
      if (node.shadowRoot) collectTextRoots(node.shadowRoot, out);
    }
    return out;
  }

  const candidates = queryDeep(document);

  // A `label[for]` pointing at a visually hidden control (the sr-only checkbox pattern) is the
  // only clickable proxy for it, so the label is emitted and the hidden control is not. Resolved
  // up front because the label may precede or follow its target in document order.
  const proxiedTargets = new Set<Element>();
  for (const el of candidates) {
    if (el.tagName.toLowerCase() !== 'label') continue;
    const target = proxyTargetOf(el);
    if (target) proxiedTargets.add(target);
  }

  const elements: Element[] = [];
  const descriptors: RawDescriptor[] = [];

  for (const el of candidates) {
    const tag = el.tagName.toLowerCase();

    // label[for] only counts when it proxies a visually hidden control AND the label itself
    // is on screen: an unmounted wizard panel (display:none) holds labels the persona cannot
    // click, and emitting them would offer options that do not exist.
    let proxied: Element | null = null;
    if (tag === 'label') {
      proxied = proxyTargetOf(el);
      if (!proxied || !isVisible(el)) continue;
    } else if (proxiedTargets.has(el)) {
      continue;
    } else if (!isVisible(el)) {
      continue;
    }

    const rect = el.getBoundingClientRect();
    const roleSource = proxied ?? el;
    const roleTag = roleSource.tagName.toLowerCase();
    const inputType = roleSource.getAttribute('type');
    const value = (roleSource as HTMLInputElement).value;
    const role = roleOf(roleSource);
    const label = nameOf(el).slice(0, 80);
    const hrefAttr = tag === 'a' ? (el as HTMLAnchorElement).getAttribute('href') || '' : '';

    elements.push(el);
    descriptors.push({
      role,
      name: label,
      href: tag === 'a' ? (el as HTMLAnchorElement).href : null,
      inputType: inputType ? inputType.toLowerCase() : null,
      hasValue:
        role === 'checkbox' || role === 'radio'
          ? isChecked(roleSource)
          : typeof value === 'string' && value.length > 0,
      // A password is never read back: it would travel into option text and into the trace.
      value:
        (role === 'textbox' || role === 'combobox') &&
        (inputType || '').toLowerCase() !== 'password' &&
        typeof value === 'string'
          ? value.trim().slice(0, 40) // VALUE_CHARS
          : '',
      y: Math.round(rect.top + window.scrollY + options.yOffset),
      // The four-edge test of `inViewport` in engine/util.ts, inlined: this function is
      // serialized to the page and cannot import.
      inViewport:
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0,
      landmark: landmarkOf(el),
      sticky: ancestors(el).some((a) => {
        const p = getComputedStyle(a).position;
        return p === 'fixed' || p === 'sticky';
      }),
      inAriaLive: ancestors(el).some((a) => a.hasAttribute('aria-live')),
      disabled: isDisabled(roleSource),
      langCode:
        tag === 'a'
          ? primaryLang(el.getAttribute('hreflang')) ||
            (/[?&/](?:lang|locale)[=/]([a-z]{2})(?:[-_][A-Za-z]{2})?\b/.exec(hrefAttr)?.[1] ?? null)
          : null,
      match: {
        autocomplete: (roleSource.getAttribute('autocomplete') || '').toLowerCase(),
        name: (roleSource.getAttribute('name') || '').toLowerCase(),
        id: (roleSource.getAttribute('id') || '').toLowerCase(),
        label: associatedLabelOf(roleSource).slice(0, 80).toLowerCase(),
        placeholder: (roleSource.getAttribute('placeholder') || '').toLowerCase(),
        required:
          roleSource.hasAttribute('required') ||
          (roleSource.getAttribute('aria-required') || '').toLowerCase() === 'true',
      },
      selectOptions:
        roleTag === 'select'
          ? Array.from((roleSource as HTMLSelectElement).options)
              .slice(0, options.selectOptionCap)
              .map((o) => ({ value: o.value, label: (o.textContent || '').trim() }))
          : null,
      tag,
      className: (el.getAttribute('class') || '')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .join(' '),
    });
  }

  // Text already carried by an option's own name must not be repeated as page copy: the
  // persona would read the button label twice and the budget would pay for it twice.
  const optionSet = new Set<Element>(elements);

  /**
   * Whether the node sits inside an option, walking the *composed* tree: `Element#contains`
   * stops at a shadow boundary, so an option that is itself a shadow host would otherwise
   * have the copy it renders inside its root counted as page text as well as as its name.
   */
  function isInsideOption(el: Element): boolean {
    let node: Element | null = el;
    while (node) {
      if (optionSet.has(node)) return true;
      const parent: Element | null = node.parentElement;
      if (parent) {
        node = parent;
        continue;
      }
      const root = node.getRootNode();
      node = root instanceof ShadowRoot ? root.host : null;
    }
    return false;
  }

  const grouped = new Map<Element, string[]>();
  const blockOrder: Element[] = [];
  for (const root of collectTextRoots(document, [])) {
    const scope: Node | null = root === document ? document.body : root;
    if (!scope) continue;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const raw = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (!raw) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent.closest('script, style, noscript, [aria-hidden="true"]')) continue;
      if (isInsideOption(parent)) continue;
      // `isVisible` only rules out zero-sized and display:none copy. The sr-only clip-rect
      // pattern, an opacity:0 layer and a paragraph parked off the left edge all have a box,
      // and a persona reads none of them, so the stricter gate applies to text as well.
      if (!isVisible(parent) || isVisuallyHidden(parent)) continue;
      const block = blockAncestorOf(parent);
      if (!block) continue;
      let parts = grouped.get(block);
      if (!parts) {
        parts = [];
        grouped.set(block, parts);
        blockOrder.push(block);
      }
      parts.push(raw);
    }
  }

  const blocks: Array<{
    text: string;
    raw: string;
    level: number;
    landmark: string;
    inAriaLive: boolean;
    top: number;
    bottom: number;
    y: number;
    inViewport: boolean;
  }> = [];
  for (const block of blockOrder) {
    const body = (grouped.get(block) ?? []).join(' ').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const level = headingLevelOf(block);
    const rect = block.getBoundingClientRect();
    blocks.push({
      text: `${level > 0 ? `[h${level}] ` : ''}${body.slice(0, 400)}`, // TEXT_BLOCK_CHARS
      raw: body,
      level,
      landmark: landmarkOf(block),
      // `aria-live="off"` is the explicit opt-out, so it does not count as a live region.
      inAriaLive:
        (block.closest('[aria-live]')?.getAttribute('aria-live') || '').toLowerCase() !== 'off' &&
        block.closest('[aria-live]') !== null,
      top: rect.top,
      bottom: rect.bottom,
      y: Math.round(rect.top + window.scrollY + options.yOffset),
      // The same inlined four-edge test the elements use.
      inViewport:
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0,
    });
  }
  // Shadow-root blocks are walked after their host's light DOM, so the walk order is not the
  // reading order. Sorting by vertical position restores it; Array#sort is stable, so blocks
  // that start on the same line keep the order they were walked in.
  blocks.sort((a, b) => a.y - b.y);

  // Both the element rects and the block rects come from this one layout read, so their
  // viewport coordinates are directly comparable; no second measurement can drift.
  for (let i = 0; i < descriptors.length; i += 1) {
    const descriptor = descriptors[i]!;
    if (!descriptor.inViewport) continue;
    const rect = elements[i]!.getBoundingClientRect();

    let heading = '';
    for (const block of blocks) {
      // Off-screen copy is copy the persona has not read, however close to the option it sits.
      if (!block.inViewport) continue;
      if (block.level === 0) continue;
      if (block.landmark !== descriptor.landmark) continue;
      if (block.top > rect.top) continue;
      heading = block.raw.slice(0, 80); // CONTEXT_HEADING_CHARS
    }

    let near = '';
    let bestDistance = Infinity;
    for (const block of blocks) {
      if (!block.inViewport) continue;
      if (block.level > 0) continue;
      if (block.raw === descriptor.name) continue;
      const distance = Math.max(0, Math.max(block.top - rect.bottom, rect.top - block.bottom));
      if (distance > 160) continue; // CONTEXT_NEAR_PX
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      // A plain slice, so a price or a number inside the block survives verbatim.
      near = block.raw.slice(0, 120); // CONTEXT_NEAR_CHARS
    }

    if (heading || near) descriptor.context = { heading, near };
  }

  // A block that straddles the fold is sent whole, up to the 400-char per-block trim, and none
  // of it counts towards `belowFoldTextChars`. The persona has started
  // reading it, and splitting a paragraph at the fold would quote half a sentence.
  const visibleText: Array<{ text: string; landmark: string; inAriaLive: boolean }> = [];
  const visibleTextAll: Array<{ text: string; landmark: string; inAriaLive: boolean }> = [];
  let visibleChars = 0;
  let belowFoldTextChars = 0;
  for (const block of blocks) {
    if (!block.inViewport) {
      if (block.top >= window.innerHeight) belowFoldTextChars += block.raw.length;
      continue;
    }
    visibleTextAll.push({
      text: block.text,
      landmark: block.landmark,
      inAriaLive: block.inAriaLive,
    });
    const separator = visibleText.length > 0 ? 1 : 0;
    if (visibleChars + separator + block.text.length > 2500) continue; // VISIBLE_TEXT_CHARS
    visibleChars += separator + block.text.length;
    visibleText.push({
      text: block.text,
      landmark: block.landmark,
      inAriaLive: block.inAriaLive,
    });
  }

  const mainEl = (document.querySelector('main') ?? document.body) as HTMLElement;
  const bodyText = ((document.body as HTMLElement).innerText || '').replace(/\s+/g, ' ');
  const payload: FramePayload = {
    descriptors,
    meta: {
      url: location.href,
      title: document.title,
      lang: primaryLang(document.documentElement.getAttribute('lang')),
      scrollY: Math.round(window.scrollY),
      scrollMax: Math.max(
        0,
        Math.round(document.documentElement.scrollHeight - window.innerHeight),
      ),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      h1: (document.querySelector('h1')?.textContent || '').replace(/\s+/g, ' ').trim(),
      mainText: (mainEl.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      visibleText,
      visibleTextAll,
      belowFoldTextChars,
      closedRoots,
      wizardProgress:
        /(?:krok|step|крок|шаг)\s+\d+\s+(?:z|of|з|из)\s+\d+/i.exec(bodyText)?.[0] ?? null,
      validationMessages: Array.from(
        new Set(
          Array.from(
            document.querySelectorAll(
              '[role=alert], [aria-live], [class*=error], [class*=invalid]',
            ),
          )
            .concat(
              Array.from(document.querySelectorAll('[aria-invalid="true"]')).flatMap((input) => {
                const id = input.getAttribute('id');
                const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
                return lab ? [lab] : [];
              }),
            )
            .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim())
            .filter((t) => t.length > 0 && t.length <= 200),
        ),
      ),
    },
  };

  // The element array is stashed alongside the payload so a later single evaluate (the overlay
  // annotator) can walk exactly these elements, in this order, without new handles.
  (
    window as unknown as { __uxExtract: { payload: FramePayload; elements: Element[] } }
  ).__uxExtract = {
    payload,
    elements,
  };
  return elements;
}
/* c8 ignore stop */

/**
 * How much of a control's current value is kept.
 * `collectInFrame` is serialized into the browser and cannot close over Node scope, so it
 * repeats the number as a literal; this is the name the rest of the project refers to.
 */
export const VALUE_CHARS = 40;

/** Per-block trim. Repeated as a literal inside `collectInFrame`, which cannot import. */
export const TEXT_BLOCK_CHARS = 400;

/**
 * Total cap on `meta.visibleText`, measured over `blocks.map((b) => b.text).join('\n')`, so
 * the separators count. Repeated as a literal inside `collectInFrame`.
 */
export const VISIBLE_TEXT_CHARS = 2_500;

/** Nearest preceding heading, trimmed. Repeated as a literal inside `collectInFrame`. */
export const CONTEXT_HEADING_CHARS = 80;

/** Closest text block, trimmed. Repeated as a literal inside `collectInFrame`. */
export const CONTEXT_NEAR_CHARS = 120;

/** How far, vertically, a block may sit from an option and still be its context. */
export const CONTEXT_NEAR_PX = 160;

/** How many disabled control names reach `meta.disabledControls`. */
export const DISABLED_CONTROL_SAMPLE = 10;

export interface Extraction {
  state: PageState;
  handles: Map<string, ElementHandle<Node>>;
  dispose(): Promise<void>;
}

/**
 * The element's current condition, as an opaque token for the signature: `d` when disabled,
 * `v` when it holds a value the persona can see, empty otherwise. Without it, answering a wizard
 * question would not move the state hash and a real step forward would read as `nothing changed`.
 */
function stateToken(element: UxElement): string {
  if (element.disabled) return 'd';
  return element.hasValue ? 'v' : '';
}

/**
 * An element inside an `aria-live` region that still belongs in the signature. Consent banners
 * wrap their body in `aria-live="polite"`, so excluding their controls would let accepting the
 * banner leave the state hash untouched and the report blame the site for a tap that did work.
 */
function isOverlayControl(element: Pick<UxElement, 'overlay' | 'dismissesOverlay'>): boolean {
  return element.overlay || element.dismissesOverlay;
}

/**
 * Digest of the copy that is on screen, as one signature entry.
 *
 * A wizard step can offer controls named exactly like the previous step's — the same
 * `Tak`/`Nie`/`Dalej` under a new question — so a signature built from controls alone cannot
 * tell the two apart, and answering the question reads as going nowhere.
 *
 * Live-region blocks and numeric-only blocks are dropped, for the same reason live and
 * numeric-named elements are dropped from the control half: a ticker, a cart count or a clock
 * would otherwise move the hash on every step and make a stuck persona look busy.
 */
export function textBlocksDigest(blocks: TextBlock[]): string {
  return sha1(
    blocks
      .filter((block) => !block.inAriaLive && !/^\d+(\.\d+)?$/.test(block.text.trim()))
      .map((block) => block.text)
      .join('\n'),
  );
}

/**
 * Sorted `role|name|href|state` of in-viewport elements, followed by the visible-text digest.
 * Elements inside `aria-live` regions and elements whose name is numeric only are excluded,
 * so a live counter or a pager digit never changes the state hash — except for overlay
 * controls, which count (see `isOverlayControl`). Consumers
 * (`hasStateChanged`, `jaccardDistance`) compare whole entries and never parse them.
 */
export function viewportSignature(state: PageState): string[] {
  const controls = state.elements
    .filter(
      (e) =>
        e.inViewport &&
        (!e.inAriaLive || isOverlayControl(e)) &&
        !/^\d+(\.\d+)?$/.test(e.name.trim()),
    )
    .map((e) => `${e.role}|${e.name}|${e.href ?? ''}|${stateToken(e)}`)
    .sort();
  return [...controls, `text|${state.meta.visibleTextDigest}`];
}

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

interface FrameRead {
  elements: UxElement[];
  handles: Map<string, ElementHandle<Node>>;
  meta: RawMeta;
}

/** Read one frame: handles plus descriptors, taken from the same DOM snapshot. */
async function readFrame(frame: Frame, yOffset: number, idPrefix: string): Promise<FrameRead> {
  // `collectInFrame` is serialized to source, and tsx wraps every declaration it contains in
  // `__name(...)`. Define the shim in this frame first so the extractor works on any page, not
  // only on a context whose init script the test harness set up. Evaluated as a source string,
  // so tsx cannot rewrite the shim itself.
  await frame.evaluate(NAME_SHIM);

  const arrayHandle = await frame.evaluateHandle(collectInFrame, {
    yOffset,
    selectOptionCap: SELECT_OPTION_CAP,
  });
  const payload = (await frame.evaluate(
    () => (window as unknown as { __uxExtract: { payload: FramePayload } }).__uxExtract.payload,
  )) as FramePayload;

  const props = await arrayHandle.getProperties();
  const elements: UxElement[] = [];
  const handles = new Map<string, ElementHandle<Node>>();

  for (let i = 0; i < payload.descriptors.length; i += 1) {
    const d = payload.descriptors[i]!;
    const prop = props.get(String(i));
    const handle = (prop?.asElement() as ElementHandle<Node> | null) ?? null;
    if (!handle) {
      await prop?.dispose();
      continue;
    }
    const id = `${idPrefix}el_${String(elements.length + 1).padStart(2, '0')}`;
    elements.push({
      id,
      role: d.role,
      name:
        d.name ||
        `[unnamed ${d.role}${d.className ? `, class "${d.className}"` : ''}]`.slice(0, 80),
      ...(d.href ? { href: toRelativeHref(d.href, payload.meta.url) } : {}),
      ...(d.inputType ? { inputType: d.inputType } : {}),
      hasValue: d.hasValue,
      ...(d.value ? { value: d.value } : {}),
      y: d.y,
      inViewport: d.inViewport,
      landmark: d.landmark as Landmark,
      sticky: d.sticky,
      inAriaLive: d.inAriaLive,
      overlay: false,
      dismissesOverlay: false,
      unnamed: d.name.length === 0,
      disabled: d.disabled,
      ...(d.langCode ? { langCode: d.langCode } : {}),
      match: d.match,
      ...(d.selectOptions ? { selectOptions: d.selectOptions } : {}),
      ...(d.context && (d.context.heading || d.context.near)
        ? {
            context: {
              ...(d.context.heading ? { heading: d.context.heading } : {}),
              ...(d.context.near ? { near: d.context.near } : {}),
            },
          }
        : {}),
    });
    handles.set(id, handle);
  }

  for (const [key, prop] of props) {
    if (!/^\d+$/.test(key)) await prop.dispose();
  }
  await arrayHandle.dispose();

  return { elements, handles, meta: payload.meta };
}

/** Build a PageState plus live handles across the main frame and same-origin iframes. */
export async function extract(page: Page): Promise<Extraction> {
  const main = await readFrame(page.mainFrame(), 0, '');
  const elements = [...main.elements];
  const handles = new Map(main.handles);
  const validationMessages = [...main.meta.validationMessages];
  let skippedFrames = 0;
  let closedRoots = main.meta.closedRoots;

  let pageOrigin: string;
  try {
    pageOrigin = new URL(page.url()).origin;
  } catch {
    pageOrigin = 'null';
  }

  let frameIndex = 0;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    let frameOrigin: string;
    try {
      frameOrigin = new URL(frame.url()).origin;
    } catch {
      frameOrigin = 'null';
    }
    // `about:blank` and `data:` frames report origin `null`; they carry no page content worth
    // walking, so they are counted with the cross-origin ones rather than read.
    if (frameOrigin === 'null' || frameOrigin !== pageOrigin) {
      skippedFrames += 1;
      continue;
    }
    frameIndex += 1;
    let yOffset = 0;
    // A frame computes inViewport against its own window, so a control at the top of an iframe
    // that is itself below the fold would look visible. It counts as in viewport only when the
    // frame's own box also intersects the top-level viewport. Unknown box: trust the frame.
    let frameVisible = true;
    try {
      const frameEl = await frame.frameElement();
      const box = await frameEl.boundingBox();
      // boundingBox() is viewport-relative, so the top page's scroll turns it into document coords.
      yOffset = box ? Math.round(box.y + main.meta.scrollY) : 0;
      frameVisible = box
        ? inViewport(
            { top: box.y, bottom: box.y + box.height, left: box.x, right: box.x + box.width },
            main.meta.viewport,
          )
        : true;
      await frameEl.dispose();
    } catch {
      yOffset = 0;
    }
    try {
      const child = await readFrame(frame, yOffset, `f${frameIndex}:`);
      elements.push(
        ...child.elements.map((e) => {
          if (frameVisible && e.inViewport) return e;
          // A frame computes its context against its own viewport, so the copy it quotes may
          // never have been on the top-level screen at all. Anything the top page does not
          // show is stripped of its context rather than sent on trust.
          const { context: _unread, ...rest } = e;
          return { ...rest, inViewport: false };
        }),
      );
      for (const [id, handle] of child.handles) handles.set(id, handle);
      closedRoots += child.meta.closedRoots;
      validationMessages.push(...child.meta.validationMessages);
    } catch {
      // A frame that navigated or detached mid-read is unreadable, so it counts as skipped.
      skippedFrames += 1;
    }
  }

  // A page with no viewport meta makes Chromium lay out at ~980px and scale down, so the layout
  // width the frame reports is wider than the device. `viewportSize()` is null when the page runs
  // headful at window size, and an unknown device width cannot prove anything, so it stays false.
  const configuredWidth = page.viewportSize()?.width ?? null;
  const nonResponsive = configuredWidth !== null && main.meta.viewport.width > configuredWidth;

  const state: PageState = {
    elements,
    meta: {
      url: main.meta.url,
      title: main.meta.title,
      lang: main.meta.lang,
      scrollY: main.meta.scrollY,
      scrollMax: main.meta.scrollMax,
      viewport: main.meta.viewport,
      h1: main.meta.h1,
      mainText: main.meta.mainText,
      visibleText: main.meta.visibleText.map((b) => ({
        text: b.text,
        landmark: b.landmark as Landmark,
        inAriaLive: b.inAriaLive,
      })),
      visibleTextDigest: textBlocksDigest(
        main.meta.visibleTextAll.map((b) => ({
          text: b.text,
          landmark: b.landmark as Landmark,
          inAriaLive: b.inAriaLive,
        })),
      ),
      belowFoldTextChars: main.meta.belowFoldTextChars,
      nonResponsive,
      ...(main.meta.wizardProgress ? { wizardProgress: main.meta.wizardProgress } : {}),
      validationMessages: [...new Set(validationMessages)],
      langSwitcher: elements
        // A disabled link is no route to another language: the site is almost always marking
        // the language the persona is already reading.
        .filter((e) => e.langCode && !e.disabled)
        .map((e) => ({ code: e.langCode!, elementId: e.id, name: e.name })),
      droppedElements: 0,
      belowFoldSample: [],
      disabledControls: [...new Set(elements.filter((e) => e.disabled).map((e) => e.name))].slice(
        0,
        DISABLED_CONTROL_SAMPLE,
      ),
      skippedFrames,
      closedRoots,
    },
    stateHash: '',
    viewHash: '',
  };

  await annotateOverlays(page, state);

  state.stateHash = sha1(`${normalizeUrl(state.meta.url)}\n${viewportSignature(state).join('\n')}`);
  state.viewHash = sha1(
    `${state.stateHash}:${Math.floor(state.meta.scrollY / Math.max(1, 0.5 * state.meta.viewport.height))}`,
  );

  return {
    state,
    handles,
    async dispose(): Promise<void> {
      await Promise.all([...handles.values()].map((h) => h.dispose()));
      handles.clear();
    },
  };
}

/** How long the retry waits for the document that replaced ours to reach DOMContentLoaded. */
export const EXTRACT_RETRY_LOAD_MS = 5000;

/**
 * Whether an error is the page navigating out from under a read, rather than a real fault.
 * Playwright words this several ways depending on which call lost its context.
 *
 * Deliberately NOT "Target page, context or browser has been closed": a closed page is gone
 * for good, and retrying it would spend the rest of the step budget on `extract-failed` rows
 * instead of surfacing the failure. Only `Target closed`, the mid-navigation wording, counts.
 */
export function isNavigationRaceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|frame was detached|\bTarget closed\b|navigating and changing the content/i.test(
    message,
  );
}

/**
 * `extract(page)`, retried once when the document is replaced mid-read.
 *
 * A click that schedules a redirect leaves a window in which the extractor's evaluates run
 * against a context the browser is tearing down. That is a tool problem, not a finding about
 * the site, and one wait for the next document is enough to get a clean read; a second failure
 * is the caller's to report.
 */
export async function extractWithRetry(page: Page): Promise<Extraction> {
  try {
    return await extract(page);
  } catch (err) {
    if (!isNavigationRaceError(err)) throw err;
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: EXTRACT_RETRY_LOAD_MS });
    } catch {
      // Whatever is rendered by now is what the retry reads; its own failure is the verdict.
    }
    return await extract(page);
  }
}

export { sha1 };
