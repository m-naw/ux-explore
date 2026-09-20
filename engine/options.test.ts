import { describe, it, expect } from 'vitest';
import {
  buildOptions,
  capCriteriaText,
  CRITERIA_CHAR_CAP,
  describeOption,
  OPTION_CAP,
} from './options';
import type { OptionContext } from './options';
import type { Element as UxElement, PageState, PersonaProfile } from './types';

function el(partial: Partial<UxElement> & { id: string; name: string }): UxElement {
  return {
    role: 'link',
    href: `/${partial.id}`,
    hasValue: false,
    y: 100,
    inViewport: true,
    landmark: 'main',
    sticky: false,
    inAriaLive: false,
    overlay: false,
    dismissesOverlay: false,
    unnamed: false,
    match: { autocomplete: '', name: '', id: '', label: '', placeholder: '', required: false },
    ...partial,
  } as UxElement;
}

function state(elements: UxElement[], meta: Partial<PageState['meta']> = {}): PageState {
  return {
    elements,
    meta: {
      url: 'https://dopomo.pl/pl',
      title: 'Dopomo',
      lang: 'pl',
      scrollY: 0,
      scrollMax: 2000,
      viewport: { width: 1280, height: 720 },
      h1: 'Dopomo',
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
      ...meta,
    },
    stateHash: 'h',
    viewHash: 'v',
  };
}

const OLENA: PersonaProfile = {
  name: 'Olena',
  description: 'Ukrainian, phone only.',
  languages: { native: 'uk', reads: { uk: 'fluent', pl: 'weak', en: 'none' } },
  device: 'mobile',
  techLiteracy: 'low',
  domainLiteracy: 'low',
  patience: 'low',
  intent: 'high',
  facts: {},
};

const BASE = {
  persona: OLENA,
  scrollBlocked: { down: false, up: false },
  canGoBack: false,
};

describe('buildOptions', () => {
  it('caps element options at 30 and reports what it dropped', () => {
    const elements = Array.from({ length: 45 }, (_, i) =>
      el({ id: `el_${i}`, name: `Item ${i}`, inViewport: i < 10, y: 100 + i * 50 }),
    );
    const set = buildOptions({ ...BASE, state: state(elements) });
    expect(set.options.filter((o) => o.kind === 'element')).toHaveLength(OPTION_CAP);
    expect(set.droppedElements).toBe(15);
    expect(set.belowFoldSample).toHaveLength(5);
  });

  it('always reserves form controls, nav and header links, and at most six matching footer links', () => {
    const elements = [
      el({
        id: 'el_form',
        name: 'Dalej',
        role: 'button',
        landmark: 'form',
        inViewport: false,
        y: 4000,
      }),
      el({ id: 'el_nav', name: 'Usługi', landmark: 'nav', inViewport: false, y: 4100 }),
      el({ id: 'el_head', name: 'Zaloguj', landmark: 'header', inViewport: false, y: 4200 }),
      ...[
        'Kontakt',
        'Cennik',
        'Pomoc',
        'Logowanie',
        'Rejestracja',
        'Regulamin',
        'Blog',
        'Kariera',
      ].map((n, i) =>
        el({ id: `el_f${i}`, name: n, landmark: 'footer', inViewport: false, y: 5000 + i }),
      ),
      ...Array.from({ length: 40 }, (_, i) =>
        el({ id: `el_body${i}`, name: `Body ${i}`, inViewport: true, y: 200 + i }),
      ),
    ];
    const ids = buildOptions({ ...BASE, state: state(elements) }).options.map((o) => o.id);
    expect(ids).toContain('el_form');
    expect(ids).toContain('el_nav');
    expect(ids).toContain('el_head');
    expect(ids.filter((id) => /^el_f\d$/.test(id))).toHaveLength(6);
    expect(ids).not.toContain('el_f6'); // Blog matches no keyword
  });

  it('tells the persona what a field already holds', () => {
    const filled = el({
      id: 'el_1',
      name: 'Adres e-mail',
      role: 'textbox',
      href: undefined,
      value: 'olena.k@example.com',
    });
    expect(describeOption(filled)).toBe(
      'textbox "Adres e-mail" (visible) (filled: "olena.k@example.com")',
    );
    const long = el({
      id: 'el_2',
      name: 'Uzasadnienie',
      role: 'textbox',
      href: undefined,
      value: 'a'.repeat(30),
    });
    expect(describeOption(long)).toBe(
      `textbox "Uzasadnienie" (visible) (filled: "${'a'.repeat(20)}…")`,
    );
  });

  it('never offers a disabled control, not even one in a reserved slot', () => {
    const elements = [
      el({ id: 'el_next', name: 'Dalej', role: 'button', landmark: 'form', disabled: true }),
      el({
        id: 'el_city',
        name: 'Miasto',
        role: 'textbox',
        landmark: 'form',
        disabled: true,
        href: undefined,
        match: {
          autocomplete: '',
          name: 'city',
          id: '',
          label: 'miasto',
          placeholder: '',
          required: false,
        },
      }),
      el({ id: 'el_help', name: 'Pomoc', landmark: 'nav', disabled: true }),
      el({ id: 'el_back', name: 'Wstecz', role: 'button', landmark: 'form' }),
    ];
    const persona = { ...OLENA, facts: { city: 'Wrocław' } };
    const ids = buildOptions({ ...BASE, persona, state: state(elements) }).options.map((o) => o.id);
    expect(ids).not.toContain('el_next');
    expect(ids).not.toContain('el_city');
    expect(ids).not.toContain('type:el_city');
    expect(ids).not.toContain('el_help');
    expect(ids).toContain('el_back');
  });

  it('does not offer a language switch through a disabled link', () => {
    const elements = [
      el({ id: 'el_uk', name: 'Українська', href: '/uk', langCode: 'uk', disabled: true }),
      el({ id: 'el_pl', name: 'Polski', href: '/pl', langCode: 'pl' }),
    ];
    const ids = buildOptions({
      ...BASE,
      persona: { ...OLENA, languages: { native: 'uk', reads: { uk: 'fluent', pl: 'fluent' } } },
      state: state(elements, {
        langSwitcher: [
          { code: 'uk', elementId: 'el_uk', name: 'Українська' },
          { code: 'pl', elementId: 'el_pl', name: 'Polski' },
        ],
      }),
    }).options.map((o) => o.id);
    expect(ids).toContain('switch_language:pl');
    expect(ids).not.toContain('switch_language:uk');
  });

  it('drops social icon links and deduplicates by name and href', () => {
    const set = buildOptions({
      ...BASE,
      state: state([
        el({ id: 'el_a', name: 'Karta CUKR', href: '/pl/cukr' }),
        el({ id: 'el_b', name: 'Karta CUKR', href: '/pl/cukr' }),
        el({ id: 'el_tw', name: 'Twitter', href: 'https://twitter.com/dopomo' }),
        el({ id: 'el_fb', name: 'Facebook', href: 'https://facebook.com/dopomo' }),
      ]),
    });
    expect(set.options.filter((o) => o.kind === 'element').map((o) => o.id)).toEqual(['el_a']);
  });

  it('describes elements the way the spec renders criteria', () => {
    const set = buildOptions({
      ...BASE,
      state: state([
        el({ id: 'el_14', name: 'Karta CUKR', href: '/pl/cukr' }),
        el({
          id: 'el_22',
          name: 'Dalej',
          role: 'button',
          href: undefined,
          inViewport: false,
          y: 3000,
        }),
      ]),
    });
    const byId = new Map(set.options.map((o) => [o.id, o.description]));
    expect(byId.get('el_14')).toBe('link "Karta CUKR" -> /pl/cukr (visible)');
    expect(byId.get('el_22')).toBe('button "Dalej" (below fold)');
    expect(byId.get('scroll_down')).toBe('scroll down to see more');
  });

  it('suppresses only the scroll direction that did not move', () => {
    const scrolled = state([el({ id: 'el_a', name: 'A' })], { scrollY: 400, scrollMax: 2000 });
    expect(buildOptions({ ...BASE, state: scrolled }).options.map((o) => o.id)).toEqual(
      expect.arrayContaining(['scroll_down', 'scroll_up']),
    );

    const downBlocked = buildOptions({
      ...BASE,
      state: scrolled,
      scrollBlocked: { down: true, up: false },
    });
    expect(downBlocked.options.map((o) => o.id)).not.toContain('scroll_down');
    expect(downBlocked.options.map((o) => o.id)).toContain('scroll_up');

    const upBlocked = buildOptions({
      ...BASE,
      state: scrolled,
      scrollBlocked: { down: false, up: true },
    });
    expect(upBlocked.options.map((o) => o.id)).toContain('scroll_down');
    expect(upBlocked.options.map((o) => o.id)).not.toContain('scroll_up');
  });

  it('offers switch_language only for languages the persona reads at ok or better', () => {
    const s = state(
      [
        el({ id: 'el_uk', name: 'Українська', langCode: 'uk' }),
        el({ id: 'el_en', name: 'English', langCode: 'en' }),
      ],
      {
        langSwitcher: [
          { code: 'uk', elementId: 'el_uk', name: 'Українська' },
          { code: 'en', elementId: 'el_en', name: 'English' },
        ],
      },
    );
    const ids = buildOptions({ ...BASE, state: s }).options.map((o) => o.id);
    expect(ids).toContain('switch_language:uk');
    expect(ids).not.toContain('switch_language:en');
  });

  it('offers leave as the only exit, however confused or stuck the persona is', () => {
    const s = state([el({ id: 'el_a', name: 'A' })]);
    const options = buildOptions({ ...BASE, state: s }).options;
    expect(options.filter((o) => o.kind === 'leave').map((o) => o.id)).toEqual(['leave']);
  });

  it('offers back only when the browser has history', () => {
    const s = state([el({ id: 'el_a', name: 'A' })]);
    expect(buildOptions({ ...BASE, state: s }).options.map((o) => o.id)).not.toContain('back');
    expect(buildOptions({ ...BASE, state: s, canGoBack: true }).options.map((o) => o.id)).toContain(
      'back',
    );
  });

  it('never caps reserved slots, even when they exceed the option cap', () => {
    const reserved = Array.from({ length: 35 }, (_, i) =>
      el({ id: `el_nav${i}`, name: `Nav ${i}`, landmark: 'nav', inViewport: false, y: 4000 + i }),
    );
    const main = Array.from({ length: 10 }, (_, i) =>
      el({ id: `el_main${i}`, name: `Main ${i}`, inViewport: true, y: 100 + i }),
    );
    const set = buildOptions({ ...BASE, state: state([...reserved, ...main]) });
    const ids = set.options.map((o) => o.id);
    for (const r of reserved) expect(ids).toContain(r.id);
    for (const m of main) expect(ids).toContain(m.id);
    expect(set.droppedElements).toBe(0);
  });

  it('caps only the non-reserved remainder when reserved slots exceed the cap', () => {
    const reserved = Array.from({ length: 35 }, (_, i) =>
      el({ id: `el_nav${i}`, name: `Nav ${i}`, landmark: 'nav', inViewport: false, y: 4000 + i }),
    );
    const mainKept = Array.from({ length: 30 }, (_, i) =>
      el({ id: `el_main${i}`, name: `Main ${i}`, inViewport: true, y: 100 + i }),
    );
    const mainDropped = Array.from({ length: 10 }, (_, i) =>
      el({ id: `el_below${i}`, name: `Below ${i}`, inViewport: false, y: 9000 + i }),
    );
    const set = buildOptions({ ...BASE, state: state([...reserved, ...mainKept, ...mainDropped]) });
    const ids = set.options.map((o) => o.id);
    for (const r of reserved) expect(ids).toContain(r.id);
    for (const k of mainKept) expect(ids).toContain(k.id);
    for (const d of mainDropped) expect(ids).not.toContain(d.id);
    expect(set.droppedElements).toBe(10);
    expect(set.belowFoldSample.length).toBeGreaterThan(0);
    expect(set.belowFoldSample.length).toBeLessThanOrEqual(5);
    expect(set.belowFoldSample.every((name) => mainDropped.some((d) => d.name === name))).toBe(
      true,
    );
  });

  it('adds type: options for inputs that a persona fact can fill', () => {
    const set = buildOptions({
      ...BASE,
      persona: { ...OLENA, facts: { givenName: 'Olena' } },
      state: state([
        el({
          id: 'el_01',
          name: 'Imię',
          role: 'textbox',
          href: undefined,
          landmark: 'form',
          match: {
            autocomplete: 'given-name',
            name: '',
            id: '',
            label: 'imię',
            placeholder: '',
            required: false,
          },
        }),
      ]),
    });
    expect(set.options.map((o) => o.id)).toContain('type:el_01');
  });
});

describe('describeOption context', () => {
  it('appends the heading and the nearby copy for a visible option', () => {
    const button = el({
      id: 'el_01',
      name: 'Перевірте →',
      role: 'button',
      href: undefined,
      context: { heading: 'Отримайте карту CUKR', near: 'Безкоштовна перевірка за 2 хвилини' },
    });
    expect(describeOption(button)).toBe(
      'button "Перевірте →" (visible; under "Отримайте карту CUKR"; near "Безкоштовна перевірка за 2 хвилини")',
    );
  });

  it('keeps a below-fold option to name plus (below fold)', () => {
    const link = el({ id: 'el_02', name: 'Умови', inViewport: false, context: { heading: 'x' } });
    expect(describeOption(link)).toBe('link "Умови" -> /el_02 (below fold)');
  });

  it('drops the context when asked', () => {
    const button = el({
      id: 'el_03',
      name: 'Go',
      role: 'button',
      href: undefined,
      context: { near: 'cheap' },
    });
    expect(describeOption(button, false)).toBe('button "Go" (visible)');
  });
});

describe('capCriteriaText', () => {
  const longContext = { heading: 'H'.repeat(80), near: 'N'.repeat(120) };

  it('leaves the options alone when they fit', () => {
    const elements = [el({ id: 'el_01', name: 'A', context: longContext })];
    const options = elements.map((e) => ({
      id: e.id,
      kind: 'element' as const,
      description: describeOption(e),
      elementId: e.id,
    }));
    expect(capCriteriaText(options, elements)).toEqual(options);
  });

  it('drops contexts from the lowest option first and never touches names', () => {
    const elements = Array.from({ length: 30 }, (_, i) =>
      el({
        id: `el_${String(i + 1).padStart(2, '0')}`,
        name: `Option ${i + 1}`,
        y: (i + 1) * 100,
        context: longContext,
      }),
    );
    const options = elements.map((e) => ({
      id: e.id,
      kind: 'element' as const,
      description: describeOption(e),
      elementId: e.id,
    }));
    const capped = capCriteriaText(options, elements);

    const total = capped.reduce((s, o) => s + o.description.length, 0);
    // The loop stops at `total <= CAP`, so this is the same boundary the code uses.
    expect(total).toBeLessThanOrEqual(CRITERIA_CHAR_CAP);
    // And it really was over before the cap ran, or this test proves nothing.
    expect(options.reduce((s, o) => s + o.description.length, 0)).toBeGreaterThan(
      CRITERIA_CHAR_CAP,
    );
    expect(capped[29]!.description).not.toContain('under "');
    expect(capped[0]!.description).toContain('under "');
    for (const [i, option] of capped.entries()) {
      expect(option.description).toContain(`"Option ${i + 1}"`);
    }
  });

  it('never rewrites a non-element option that points at the same element', () => {
    // `type:`, `select:` and `switch_language` options carry the element's id too. Their text
    // is an instruction, not a description, so the cap must leave it alone rather than replace
    // it with the element's own criteria line.
    const elements = Array.from({ length: 30 }, (_, i) =>
      el({
        id: `el_${String(i + 1).padStart(2, '0')}`,
        name: `Option ${i + 1}`,
        y: (i + 1) * 100,
        context: longContext,
      }),
    );
    const last = elements[29]!;
    const options = [
      ...elements.map((e) => ({
        id: e.id,
        kind: 'element' as const,
        description: describeOption(e),
        elementId: e.id,
      })),
      {
        id: `type:${last.id}`,
        kind: 'type' as const,
        description: `type "Olena" into link "${last.name}"`,
        elementId: last.id,
      },
    ];
    const capped = capCriteriaText(options, elements);
    expect(capped[30]!.description).toBe(`type "Olena" into link "${last.name}"`);
  });
});

function ctx(pageState: PageState, overrides: Partial<OptionContext> = {}): OptionContext {
  return {
    state: pageState,
    persona: OLENA,
    scrollBlocked: { down: false, up: false },
    canGoBack: false,
    ...overrides,
  };
}

describe('the leave option', () => {
  it('is offered on every step, with no gate at all', () => {
    const { options } = buildOptions(ctx(state([el({ id: 'el_01', name: 'Start' })])));
    const leave = options.find((o) => o.id === 'leave');
    expect(leave).toEqual({ id: 'leave', kind: 'leave', description: 'leave this site' });
  });

  it('is offered on every step, with no confusion or stall gating it', () => {
    const { options } = buildOptions(ctx(state([el({ id: 'el_01', name: 'Start' })])));
    expect(options.filter((o) => o.kind === 'leave')).toHaveLength(1);
  });
});
