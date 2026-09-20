import { describe, it, expect } from 'vitest';
import { matchFact, buildTypedOptions, requiredInputsWithoutFacts } from './typed-input';
import type { Element as UxElement, Facts, PageState } from './types';

function input(partial: Partial<UxElement> & { id: string; name: string }): UxElement {
  return {
    role: 'textbox',
    hasValue: false,
    y: 100,
    inViewport: true,
    landmark: 'form',
    sticky: false,
    inAriaLive: false,
    overlay: false,
    dismissesOverlay: false,
    unnamed: false,
    match: {
      autocomplete: '',
      name: '',
      id: '',
      label: partial.name.toLowerCase(),
      placeholder: '',
      required: false,
    },
    ...partial,
  } as UxElement;
}

const EMPTY_HINTS = {
  autocomplete: '',
  name: '',
  id: '',
  label: '',
  placeholder: '',
  required: false,
};

function state(elements: UxElement[]): PageState {
  return {
    elements,
    meta: {
      url: 'https://dopomo.pl/pl/form',
      title: 'Wniosek',
      lang: 'pl',
      scrollY: 0,
      scrollMax: 0,
      viewport: { width: 1280, height: 720 },
      h1: 'Wniosek',
      mainText: '',
      validationMessages: [],
      langSwitcher: [],
      droppedElements: 0,
      belowFoldSample: [],
      visibleText: [],
      visibleTextDigest: '',
      belowFoldTextChars: 0,
      nonResponsive: false,
      disabledControls: [],
      skippedFrames: 0,
      closedRoots: 0,
    },
    stateHash: 'h',
    viewHash: 'v',
  };
}

const FACTS: Facts = {
  givenName: 'Olena',
  email: 'olena.k@example.com',
  phone: '+48500100200',
  birthDate: '1988-04-17',
  nationality: 'UA',
  city: 'Wrocław',
};

describe('matchFact', () => {
  it('matches each of the five attribute hints', () => {
    const hint = (id: string, key: keyof typeof EMPTY_HINTS, value: string) =>
      matchFact(input({ id, name: 'Pole 1', match: { ...EMPTY_HINTS, [key]: value } }), FACTS)?.key;
    expect(hint('e1', 'autocomplete', 'given-name')).toBe('givenName');
    expect(hint('e2', 'name', 'given_name')).toBe('givenName');
    expect(hint('e3', 'id', 'birth_date')).toBe('birthDate');
    expect(hint('e4', 'label', 'adres e-mail')).toBe('email');
    expect(hint('e5', 'placeholder', 'miasto')).toBe('city');
  });

  it('falls back to the input type when no attribute hint carries a token', () => {
    const typed = (id: string, inputType: string) =>
      matchFact(input({ id, name: 'Pole 1', inputType, match: { ...EMPTY_HINTS } }), FACTS)?.key;
    expect(typed('t1', 'email')).toBe('email');
    expect(typed('t2', 'tel')).toBe('phone');
    expect(typed('t3', 'date')).toBe('birthDate');
  });

  it('prefers the input type (source 6) over the accessible name (source 7)', () => {
    // `<input type="tel" aria-label="Miasto">` as the extractor models it: an aria-label gives
    // the control an accessible name but no associated label, so the `label` hint is empty
    // (see the match.label contract in test/browser/extract.test.ts). The sources are tried in
    // spec order, so this is a phone field, not a city field.
    const el = input({
      id: 'p1',
      name: 'Miasto',
      inputType: 'tel',
      match: { ...EMPTY_HINTS, label: '' },
    });
    expect(el.match.label).toBe('');
    expect(el.name).toBe('Miasto');
    expect(matchFact(el, FACTS)?.key).toBe('phone');
  });

  it('requires a leading word boundary on every token', () => {
    // A token only matches at a word start: `telefon` carries the `tel` token, `hotel` does not.
    const named = (id: string, name: string) =>
      matchFact(input({ id, name: 'Pole 1', match: { ...EMPTY_HINTS, name } }), FACTS);
    expect(named('b1', 'hotel')).toBeUndefined();
    expect(named('b2', 'capacity')).toBeUndefined();
    expect(named('b3', 'telefon')?.key).toBe('phone');
  });

  it('matches on the accessible name when no attribute hint carries the token', () => {
    // The accessible name is the last match source, tried only once the attribute hints
    // (autocomplete, name, id, label, placeholder, type) have all come up empty.
    const el = input({ id: 'e6', name: 'Miasto pobytu', match: { ...EMPTY_HINTS } });
    expect(el.match).toEqual(EMPTY_HINTS);
    expect(matchFact(el, FACTS)).toEqual({ key: 'city', value: 'Wrocław' });
  });

  it('returns nothing when no fact fits', () => {
    expect(matchFact(input({ id: 'e5', name: 'Uzasadnienie' }), FACTS)).toBeUndefined();
  });
});

describe('buildTypedOptions', () => {
  it('creates a type: option per matched input and a select: option per matched select value', () => {
    const options = buildTypedOptions(
      state([
        input({
          id: 'el_01',
          name: 'Imię',
          match: {
            autocomplete: 'given-name',
            name: '',
            id: '',
            label: 'imię',
            placeholder: '',
            required: false,
          },
        }),
        input({ id: 'el_02', name: 'Uzasadnienie' }),
        input({
          id: 'el_03',
          name: 'Obywatelstwo',
          role: 'combobox',
          match: {
            autocomplete: '',
            name: 'nationality',
            id: '',
            label: 'obywatelstwo',
            placeholder: '',
            required: false,
          },
          selectOptions: [
            { value: '', label: 'Wybierz' },
            { value: 'UA', label: 'Ukraina' },
            { value: 'PL', label: 'Polska' },
          ],
        }),
      ]),
      FACTS,
    );
    const ids = options.map((o) => o.id);
    expect(ids).toContain('type:el_01');
    expect(ids).not.toContain('type:el_02');
    expect(ids).toContain('select:el_03=UA');
    expect(ids).not.toContain('select:el_03=PL');
    const typed = options.find((o) => o.id === 'type:el_01')!;
    expect(typed.value).toBe('Olena');
    expect(typed.description).toBe('type "Olena" into textbox "Imię"');
  });

  it('lists up to 10 option values when the select matches no fact', () => {
    const options = buildTypedOptions(
      state([
        input({
          id: 'el_09',
          name: 'Miesiąc',
          role: 'combobox',
          selectOptions: Array.from({ length: 10 }, (_, i) => ({
            value: String(i + 1),
            label: `M${i + 1}`,
          })),
        }),
      ]),
      {},
    );
    expect(options.filter((o) => o.kind === 'select')).toHaveLength(10);
  });

  it('falls back to the value list when the matched fact fits none of the options', () => {
    // A fact that names the select but matches no `<option>` must not silence the select:
    // the persona still needs something to choose.
    const options = buildTypedOptions(
      state([
        input({
          id: 'el_11',
          name: 'Obywatelstwo',
          role: 'combobox',
          match: { ...EMPTY_HINTS, name: 'nationality' },
          selectOptions: [
            { value: '', label: 'Wybierz' },
            { value: 'PL', label: 'Polska' },
            { value: 'DE', label: 'Niemcy' },
          ],
        }),
      ]),
      FACTS,
    );
    expect(options.map((o) => o.id)).toEqual(['select:el_11=PL', 'select:el_11=DE']);
  });

  it('treats a combobox without options as a typed input', () => {
    const options = buildTypedOptions(
      state([
        input({
          id: 'el_07',
          name: 'Miasto pobytu',
          role: 'combobox',
          match: {
            autocomplete: '',
            name: 'city',
            id: '',
            label: 'miasto pobytu',
            placeholder: '',
            required: false,
          },
        }),
      ]),
      FACTS,
    );
    expect(options.map((o) => o.id)).toEqual(['type:el_07']);
    expect(options[0]!.value).toBe('Wrocław');
  });
});

describe('already-filled controls', () => {
  it('stops offering a type: option once the field holds the fact, whatever the case or padding', () => {
    const facts: Facts = { email: 'olena.k@example.com' };
    const empty = input({ id: 'el_01', name: 'Adres e-mail', inputType: 'email' });
    expect(buildTypedOptions(state([empty]), facts).map((o) => o.id)).toEqual(['type:el_01']);

    const filled = input({
      id: 'el_01',
      name: 'Adres e-mail',
      inputType: 'email',
      value: '  OLENA.K@Example.com  ',
    });
    expect(buildTypedOptions(state([filled]), facts)).toEqual([]);
  });

  it('stops offering the select: option for the value already chosen', () => {
    const chosen = input({
      id: 'el_02',
      name: 'Obywatelstwo',
      role: 'combobox',
      selectOptions: [
        { value: 'UA', label: 'Ukraina' },
        { value: 'PL', label: 'Polska' },
      ],
      value: 'UA',
    });
    expect(buildTypedOptions(state([chosen]), {}).map((o) => o.id)).toEqual(['select:el_02=PL']);
  });
});

describe('requiredInputsWithoutFacts', () => {
  it('names inputs that have no matching fact', () => {
    expect(
      requiredInputsWithoutFacts(
        state([
          input({
            id: 'el_01',
            name: 'Imię',
            match: {
              autocomplete: 'given-name',
              name: '',
              id: '',
              label: 'imię',
              placeholder: '',
              required: false,
            },
          }),
          input({ id: 'el_02', name: 'Uzasadnienie' }),
        ]),
        FACTS,
      ),
    ).toEqual(['Uzasadnienie']);
  });

  it('looks only inside a form, so a site-wide search or newsletter box is never named', () => {
    // `missingFactLabel` explains a rejected form submit, so a textbox outside the form
    // cannot be the input the persona failed to fill.
    expect(
      requiredInputsWithoutFacts(
        state([
          input({ id: 'el_01', name: 'Szukaj', landmark: 'header' }),
          input({ id: 'el_02', name: 'Newsletter', landmark: 'footer' }),
          input({ id: 'el_03', name: 'Uzasadnienie', landmark: 'form' }),
        ]),
        FACTS,
      ),
    ).toEqual(['Uzasadnienie']);
  });

  it('considers only the required inputs once the form marks any of them', () => {
    // An optional note field the persona left blank is not why the submit was rejected,
    // so it must never become the `missing-fact:<label>` finding.
    const required = (name: string, id: string): UxElement =>
      input({ id, name, match: { ...EMPTY_HINTS, label: name.toLowerCase(), required: true } });
    expect(
      requiredInputsWithoutFacts(
        state([required('Uzasadnienie', 'el_01'), input({ id: 'el_02', name: 'Dodatkowe uwagi' })]),
        FACTS,
      ),
    ).toEqual(['Uzasadnienie']);
  });

  it('accepts aria-required as the marker', () => {
    expect(
      requiredInputsWithoutFacts(
        state([
          input({ id: 'el_01', name: 'Uzasadnienie', match: { ...EMPTY_HINTS, required: true } }),
          input({ id: 'el_02', name: 'Dodatkowe uwagi' }),
        ]),
        FACTS,
      ),
    ).toEqual(['Uzasadnienie']);
  });

  it('falls back to every fact-less input when the form marks none of them required', () => {
    // Plenty of forms mark nothing and validate in script; the label is still the best
    // explanation available for a submit the site rejected.
    expect(
      requiredInputsWithoutFacts(
        state([
          input({ id: 'el_01', name: 'Uzasadnienie' }),
          input({ id: 'el_02', name: 'Dodatkowe uwagi' }),
        ]),
        FACTS,
      ),
    ).toEqual(['Uzasadnienie', 'Dodatkowe uwagi']);
  });
});
