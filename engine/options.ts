// engine/options.ts
// Turns a PageState into the option list Jev chooses from.

import type { Element as UxElement, Option, PageState, PersonaProfile } from './types';
import { buildTypedOptions, isTextInput, matchFact } from './typed-input';

/** Cap on element options. */
export const OPTION_CAP = 30;

/** Cap on reserved footer links. */
export const FOOTER_LINK_CAP = 6;

/** Footer link names worth reserving, per language: legal, contact, pricing, help, login, register. */
const FOOTER_KEYWORDS: Record<string, string[]> = {
  en: [
    'terms',
    'privacy',
    'legal',
    'contact',
    'pricing',
    'price',
    'help',
    'support',
    'log in',
    'login',
    'sign in',
    'register',
    'sign up',
  ],
  pl: [
    'regulamin',
    'prywatn',
    'kontakt',
    'cennik',
    'cena',
    'pomoc',
    'zaloguj',
    'logowanie',
    'rejestr',
  ],
  uk: ['умови', 'конфіденц', 'контакт', 'ціни', 'вартість', 'допомог', 'увійти', 'вхід', 'реєстр'],
  ru: [
    'условия',
    'конфиденц',
    'контакт',
    'цены',
    'стоимость',
    'помощь',
    'войти',
    'вход',
    'регистр',
  ],
};

const SOCIAL_HOSTS = [
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'youtube.com',
  'tiktok.com',
  'github.com',
  't.me',
];
const SOCIAL_NAMES = [
  'twitter',
  'facebook',
  'instagram',
  'linkedin',
  'youtube',
  'tiktok',
  'telegram',
  'github',
];

export interface OptionContext {
  state: PageState;
  persona: PersonaProfile;
  /** A direction is blocked when the previous scroll that way did not move the page. */
  scrollBlocked: { down: boolean; up: boolean };
  canGoBack: boolean;
}

export interface OptionSet {
  options: Option[];
  droppedElements: number;
  belowFoldSample: string[];
}

/** How much of a control's current value is shown in its option text. */
export const FILLED_VALUE_CHARS = 20;

/** Criteria text for one element, as sent to Jev. */
export function describeOption(el: UxElement, withContext = true): string {
  const href = el.href ? ` -> ${el.href}` : '';
  const where: string[] = [el.inViewport ? 'visible' : 'below fold'];
  // An off-screen option's surroundings are off screen too, so they are never described.
  if (withContext && el.inViewport && el.context) {
    if (el.context.heading) where.push(`under "${el.context.heading}"`);
    if (el.context.near) where.push(`near "${el.context.near}"`);
  }
  const overlay = el.overlay ? ' [inside a dialog covering the page]' : '';
  // What the field already holds, so the persona can see the work is done rather than redo it.
  const filled = el.value
    ? ` (filled: "${el.value.slice(0, FILLED_VALUE_CHARS)}${el.value.length > FILLED_VALUE_CHARS ? '…' : ''}")`
    : '';
  return `${el.role} "${el.name}"${href} (${where.join('; ')})${filled}${overlay}`;
}

/** Cap on the total criteria text sent for all options. */
export const CRITERIA_CHAR_CAP = 6_000;

/**
 * Bring the total criteria text under the cap by dropping per-option context, starting with
 * the option lowest on the page: what sits furthest from the persona's eye is what they are
 * least likely to have read. Names, hrefs and the visible/below-fold marker are never touched,
 * so an option can lose its persuasion but never its identity.
 */
export function capCriteriaText(options: Option[], elements: UxElement[]): Option[] {
  let total = options.reduce((sum, option) => sum + option.description.length, 0);
  if (total <= CRITERIA_CHAR_CAP) return options;

  const byId = new Map(elements.map((el) => [el.id, el]));
  const out = options.map((option) => ({ ...option }));
  const droppable = out
    // Element options only: a `type:`, `select:` or `switch_language` option carries the same
    // `elementId`, but its text is an instruction rather than a description of the element, so
    // rewriting it from `describeOption` would destroy the action instead of shortening it.
    .map((option, index) => ({
      index,
      el: option.kind === 'element' && option.elementId ? byId.get(option.elementId) : undefined,
    }))
    .filter((entry): entry is { index: number; el: UxElement } => entry.el?.context !== undefined)
    .sort((a, b) => b.el.y - a.el.y);

  for (const { index, el } of droppable) {
    if (total <= CRITERIA_CHAR_CAP) break;
    const bare = describeOption(el, false);
    total -= out[index]!.description.length - bare.length;
    out[index]!.description = bare;
  }
  return out;
}

function isSocial(el: UxElement): boolean {
  const name = el.name.toLowerCase();
  if (SOCIAL_NAMES.some((s) => name === s || name === `${s} icon`)) return true;
  if (!el.href) return false;
  return SOCIAL_HOSTS.some((host) => el.href!.includes(host));
}

function readableLanguages(persona: PersonaProfile): Set<string> {
  const out = new Set<string>([persona.languages.native]);
  for (const [code, level] of Object.entries(persona.languages.reads)) {
    if (level === 'ok' || level === 'fluent') out.add(code);
  }
  return out;
}

function footerKeywordsFor(persona: PersonaProfile): string[] {
  const langs = new Set<string>([
    persona.languages.native,
    ...Object.keys(persona.languages.reads),
  ]);
  const out: string[] = [];
  for (const lang of langs) out.push(...(FOOTER_KEYWORDS[lang] ?? []));
  return out.length > 0 ? out : (FOOTER_KEYWORDS['en'] ?? []);
}

/** Build the option list: reserved slots, then in-viewport main content, then below-fold nearest first. */
export function buildOptions(ctx: OptionContext): OptionSet {
  const { state, persona } = ctx;
  // A disabled control is never a candidate, reserved slots included: clicking one can only
  // burn the action timeout and land the step in the `tool` bucket. `meta.disabledControls`
  // is what tells the persona it is there.
  const candidates = state.elements.filter((el) => !isSocial(el) && !el.disabled);
  // A human cannot click what is not on screen. Below-fold controls stay out of the option
  // list; scroll_down is how she reaches them. Their names are reported as a sample only.
  const visible = candidates.filter((el) => el.inViewport);
  const below = candidates
    .filter((el) => !el.inViewport)
    .sort((a, b) => a.y - b.y);
  // A text field with no persona fact can only be focused, never filled. Offering that click
  // is a dead tap. Selects stay: choosing an option does not require a fact.
  const unfillable = (el: UxElement) => isTextInput(el) && !matchFact(el, persona.facts);

  const seen = new Set<string>();
  // Reserved slots (form controls, nav/header, langSwitcher, matching footer links) are never
  // capped; only the non-reserved remainder (main content) is subject to OPTION_CAP.
  // Both are visible-only.
  const reserved: UxElement[] = [];
  const rest: UxElement[] = [];
  const take = (el: UxElement, bucket: UxElement[]): boolean => {
    const key = `${el.name}|${el.href ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    bucket.push(el);
    return true;
  };

  for (const el of visible) if (el.landmark === 'form' && !unfillable(el)) take(el, reserved);
  for (const el of visible)
    if ((el.landmark === 'nav' || el.landmark === 'header') && !unfillable(el)) take(el, reserved);

  const switcherIds = new Set(state.meta.langSwitcher.map((l) => l.elementId));
  for (const el of visible) if (switcherIds.has(el.id) && !unfillable(el)) take(el, reserved);

  const keywords = footerKeywordsFor(persona);
  let footerTaken = 0;
  for (const el of visible) {
    if (footerTaken >= FOOTER_LINK_CAP) break;
    if (el.landmark !== 'footer' || unfillable(el)) continue;
    const name = el.name.toLowerCase();
    if (!keywords.some((k) => name.includes(k))) continue;
    if (take(el, reserved)) footerTaken += 1;
  }

  for (const el of visible) if (!unfillable(el)) take(el, rest);

  const kept = [...reserved, ...rest.slice(0, OPTION_CAP)];
  const dropped = [...rest.slice(OPTION_CAP), ...below];

  const options: Option[] = kept
    .filter((el) => !(isTextInput(el) && matchFact(el, persona.facts)))
    .map((el) => ({
      id: el.id,
      kind: 'element',
      description: describeOption(el),
      elementId: el.id,
    }));

  // Typed input options for the elements that survived the cap.
  const keptIds = new Set(kept.map((el) => el.id));
  for (const typed of buildTypedOptions(state, persona.facts)) {
    if (typed.elementId && keptIds.has(typed.elementId)) options.push(typed);
  }

  // Meta actions.
  if (state.meta.scrollY < state.meta.scrollMax && !ctx.scrollBlocked.down) {
    options.push({
      id: 'scroll_down',
      kind: 'scroll_down',
      description: 'scroll down to see more',
    });
  }
  if (state.meta.scrollY > 0 && !ctx.scrollBlocked.up) {
    options.push({ id: 'scroll_up', kind: 'scroll_up', description: 'scroll back up the page' });
  }
  if (ctx.canGoBack) {
    options.push({ id: 'back', kind: 'back', description: 'go back to the previous page' });
  }
  const readable = readableLanguages(persona);
  const visibleIds = new Set(visible.map((el) => el.id));
  // The extractor already keeps disabled links out of langSwitcher; this holds for a state
  // built by hand or by an older run.
  const disabledIds = new Set(state.elements.filter((el) => el.disabled).map((el) => el.id));
  for (const target of state.meta.langSwitcher) {
    if (!readable.has(target.code)) continue;
    if (disabledIds.has(target.elementId)) continue;
    if (!visibleIds.has(target.elementId)) continue;
    options.push({
      id: `switch_language:${target.code}`,
      kind: 'switch_language',
      description: `switch the site language to ${target.code} ("${target.name}")`,
      elementId: target.elementId,
      languageCode: target.code,
    });
  }
  // Never gated, on every step. The persona's intent and patience lines are what make this
  // plausible or absurd; the code only offers it.
  options.push({ id: 'leave', kind: 'leave', description: 'leave this site' });

  return {
    options: capCriteriaText(options, state.elements),
    droppedElements: dropped.length,
    belowFoldSample: dropped
      .filter((el) => !el.inViewport)
      .slice(0, 5)
      .map((el) => el.name),
  };
}
