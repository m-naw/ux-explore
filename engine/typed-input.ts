// engine/typed-input.ts
// Fact matching and typed input options.

import {
  FACT_KEYS,
  type Element as UxElement,
  type FactKey,
  type Facts,
  type Option,
  type PageState,
} from './types';
import { escapeRegExp } from './util';

/** Up to this many `<option>` values are offered when a select matches no fact. */
export const SELECT_OPTION_CAP = 10;

/** Tokens that identify each fact on an input's autocomplete / name / id / label / placeholder. */
const FACT_TOKENS: Record<FactKey, string[]> = {
  givenName: [
    'given-name',
    'given_name',
    'givenname',
    'firstname',
    'first_name',
    'fname',
    'imię',
    'imie',
    'ім',
    'имя',
  ],
  familyName: [
    'family-name',
    'family_name',
    'lastname',
    'last_name',
    'surname',
    'lname',
    'nazwisko',
    'прізвищ',
    'фамили',
  ],
  email: ['email', 'e-mail', 'mail', 'poczta', 'пошт', 'почт'],
  phone: ['tel', 'phone', 'telefon', 'телефон'],
  nationality: [
    'nationality',
    'citizenship',
    'country',
    'obywatelstwo',
    'kraj',
    'громадянств',
    'гражданств',
  ],
  birthDate: ['birth', 'bday', 'dob', 'urodzen', 'народжен', 'рожден'],
  city: ['city', 'town', 'locality', 'miasto', 'місто', 'город'],
  employer: [
    'employer',
    'company',
    'organisation',
    'organization',
    'pracodawc',
    'firma',
    'роботодав',
    'работодат',
  ],
  arrivalDate: ['arrival', 'entry-date', 'przyjazd', 'wjazd', 'приїзд', 'въезд'],
  pesel: ['pesel'],
};

/** Input types that imply a fact even when no token matches. */
const TYPE_FACT: Record<string, FactKey> = { email: 'email', tel: 'phone', date: 'birthDate' };

/**
 * A token matches only at the start of a word: `telefon` still carries the
 * `tel` token, `hotel` does not, and `obywatelstwo` no longer reads as a phone field. The token
 * may still be a prefix of the word, which is what makes the stemmed tokens above work.
 */
function tokenPattern(token: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(token)}`, 'u');
}

const FACT_PATTERNS: Record<FactKey, RegExp[]> = Object.fromEntries(
  FACT_KEYS.map((key) => [key, FACT_TOKENS[key].map(tokenPattern)]),
) as Record<FactKey, RegExp[]>;

/** The first fact whose tokens appear in one source string, in FACT_KEYS order. */
function factInSource(source: string, facts: Facts): { key: FactKey; value: string } | undefined {
  if (source === '') return undefined;
  for (const key of FACT_KEYS) {
    const value = facts[key];
    if (value === undefined) continue;
    if (FACT_PATTERNS[key].some((pattern) => pattern.test(source))) return { key, value };
  }
  return undefined;
}

/**
 * Find the persona fact that belongs in this input, if any.
 *
 * Sources are tried strongest clue first — autocomplete, name, id, label, placeholder, the
 * input type, and finally the accessible name. Each source is exhausted before the next one is
 * read, so a weaker later clue can never outrank a stronger earlier one: `type=tel` beats an
 * accessible name that merely mentions a city.
 */
export function matchFact(
  el: UxElement,
  facts: Facts,
): { key: FactKey; value: string } | undefined {
  const m = el.match;
  for (const source of [m.autocomplete, m.name, m.id, m.label, m.placeholder]) {
    const hit = factInSource(source, facts);
    if (hit) return hit;
  }
  const byType = el.inputType ? TYPE_FACT[el.inputType] : undefined;
  if (byType) {
    const value = facts[byType];
    if (value !== undefined) return { key: byType, value };
  }
  return factInSource(el.name.toLowerCase(), facts);
}

/** A `<select>`: it is the only element that carries `selectOptions`. */
export function isSelect(el: UxElement): boolean {
  return Array.isArray(el.selectOptions);
}

/** Anything the persona can type into: a textbox, or a combobox that is not a `<select>`. */
export function isTextInput(el: UxElement): boolean {
  if (isSelect(el)) return false;
  return el.role === 'textbox' || el.role === 'combobox';
}

/** `type:` and `select:` options for the current page. */
export function buildTypedOptions(state: PageState, facts: Facts): Option[] {
  const options: Option[] = [];
  for (const el of state.elements) {
    // A disabled input refuses both a fill and the focusing click that precedes it.
    if (el.disabled) continue;
    if (isSelect(el)) {
      const fact = matchFact(el, facts);
      const values = (el.selectOptions ?? []).filter((v) => v.value !== '');
      const byFact = fact
        ? values.filter((v) => v.value === fact.value || v.label === fact.value)
        : [];
      // A fact that names the select but fits none of its `<option>` values must not silence
      // the select: the persona still needs something to choose.
      const chosen = byFact.length > 0 ? byFact : values.slice(0, SELECT_OPTION_CAP);
      for (const value of chosen) {
        // Choosing what is already chosen changes nothing, and a run of those reads as a loop.
        if (el.value !== undefined && value.value === el.value) continue;
        options.push({
          id: `select:${el.id}=${value.value}`,
          kind: 'select',
          description: `choose "${value.label}" in ${el.role} "${el.name}"`,
          elementId: el.id,
          value: value.value,
        });
      }
      continue;
    }
    if (!isTextInput(el)) continue;
    const fact = matchFact(el, facts);
    if (!fact) continue;
    // The field already holds this fact, so retyping it would leave an identical state hash
    // and read to the loop detector as a persona going nowhere.
    if (el.value !== undefined && el.value.trim().toLowerCase() === fact.value.trim().toLowerCase())
      continue;
    options.push({
      id: `type:${el.id}`,
      kind: 'type',
      description: `type "${fact.value}" into ${el.role} "${el.name}"`,
      elementId: el.id,
      value: fact.value,
    });
  }
  return options;
}

/**
 * Labels of form inputs on this page that no persona fact can fill.
 *
 * Only elements inside a form landmark count: the label explains a submit
 * the site rejected, so a header search box or a footer newsletter field — neither of which the
 * rejected form contains — must never become the `missing-fact:<label>` finding.
 *
 * Within that form, a control the site marked `required` (or `aria-required="true"`) is what the
 * rejection is about, so an optional field the persona simply left blank is not named. A form
 * that marks nothing — plenty validate in script only — falls back to every fact-less input,
 * which is the behaviour this had before the marker existed.
 */
export function requiredInputsWithoutFacts(state: PageState, facts: Facts): string[] {
  const formInputs = state.elements.filter((el) => el.landmark === 'form' && isTextInput(el));
  const marked = formInputs.filter((el) => el.match.required);
  const considered = marked.length > 0 ? marked : formInputs;
  return considered.filter((el) => !matchFact(el, facts)).map((el) => el.name);
}
