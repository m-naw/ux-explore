import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeBrowser,
  getBrowser,
  openPage,
  closePage,
  closeBrowser,
  startFixtureServer,
  stopFixtureServer,
  type FixtureServer,
} from './harness';
import { extract } from '../../engine/extract';
import { hasStateChanged } from '../../engine/state-diff';
import { execute, STICKY_MARGIN_PX } from '../../engine/execute';
import { createPageMonitor } from '../../engine/page-monitor';
import { buildOptions } from '../../engine/options';
import { drive } from '../../engine/driver';
import type {
  DecideEngine,
  DecideInput,
  ExploreConfig,
  Journey,
  Option,
  PersonaProfile,
  RawDecision,
} from '../../engine/types';
import type { Page } from 'playwright';

/** The fixed header height declared by test/fixtures/sticky-form.html. */
const STICKY_HEADER_HEIGHT_PX = 120;

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await closeBrowser();
  await stopFixtureServer();
});

const OLENA: PersonaProfile = {
  name: 'Olena',
  description: 'Ukrainian, low bureaucracy literacy.',
  languages: { native: 'uk', reads: { uk: 'fluent', pl: 'weak' } },
  device: 'desktop',
  techLiteracy: 'low',
  domainLiteracy: 'low',
  patience: 'low',
  intent: 'high',
  facts: {
    givenName: 'Olena',
    email: 'olena.k@example.com',
    birthDate: '1988-04-17',
    nationality: 'UA',
    city: 'Wrocław',
  },
};

function optionsFor(state: Parameters<typeof buildOptions>[0]['state']) {
  return buildOptions({
    state,
    persona: OLENA,
    scrollBlocked: { down: false, up: false },
    canGoBack: false,
  });
}

async function runOption(page: Page, option: Option) {
  const extraction = await extract(page);
  const monitor = createPageMonitor(page);
  monitor.mark();
  const result = await execute({
    page,
    extraction,
    option,
    monitor,
    reExtract: () => extract(page),
  });
  await extraction.dispose();
  await result.after?.dispose();
  monitor.dispose();
  return result;
}

function config(overrides: Partial<ExploreConfig> = {}): ExploreConfig {
  return {
    url: server.url('wizard.html'),
    need: 'Submit the application',
    persona: OLENA,
    maxSteps: 2,
    seed: 1,
    engine: 'jev',
    output: './reports/',
    format: 'yaml',
    verbose: false,
    screenshots: false,
    recordDecisions: false,
    report: true,
    ...overrides,
  };
}

describeBrowser('wizard', () => {
  it('builds typed and select options from persona facts, and exposes radios via their proxy labels', async () => {
    const page = await openPage();
    await page.goto(server.url('wizard.html'));
    const ex = await extract(page);

    expect(ex.state.meta.wizardProgress).toBe('Krok 2 z 3');
    const ids = optionsFor(ex.state).options.map((o) => o.id);
    const given = ex.state.elements.find((e) => e.name === 'Imię')!;
    const country = ex.state.elements.find((e) => e.name === 'Obywatelstwo')!;
    const birth = ex.state.elements.find((e) => e.name === 'Data urodzenia')!;
    const motive = ex.state.elements.find((e) => e.name === 'Uzasadnienie')!;
    expect(ids).toContain(`type:${given.id}`);
    expect(ids).toContain(`type:${birth.id}`);
    expect(ids).toContain(`select:${country.id}=UA`);
    expect(ids).not.toContain(`select:${country.id}=PL`);
    // An input no fact fits gets no `type:` option at all.
    expect(ids).not.toContain(`type:${motive.id}`);

    const radio = ex.state.elements.find((e) => e.name === 'Praca')!;
    expect(radio.role).toBe('radio');

    await ex.dispose();
    await closePage(page);
  });

  it('fills a text input, an ISO date, a select and a combobox, and checks a radio via its label', async () => {
    const page = await openPage();
    await page.goto(server.url('wizard.html'));

    const ex = await extract(page);
    const options = optionsFor(ex.state).options;
    const byId = (id: string) => options.find((o) => o.id === id)!;
    const given = ex.state.elements.find((e) => e.name === 'Imię')!;
    const birth = ex.state.elements.find((e) => e.name === 'Data urodzenia')!;
    const country = ex.state.elements.find((e) => e.name === 'Obywatelstwo')!;
    const city = ex.state.elements.find((e) => e.name === 'Miasto pobytu')!;
    const radio = ex.state.elements.find((e) => e.name === 'Praca')!;
    await ex.dispose();

    const typed = await runOption(page, byId(`type:${given.id}`));
    expect(await page.inputValue('#given')).toBe('Olena');
    // The progress rule leans on this: filling a field changes no state hash.
    expect(typed.valueChanged).toBe(true);
    const retyped = await runOption(page, byId(`type:${given.id}`));
    expect(retyped.valueChanged).toBe(false);

    await runOption(page, byId(`type:${birth.id}`));
    expect(await page.inputValue('#birth')).toBe('1988-04-17');

    await runOption(page, byId(`select:${country.id}=UA`));
    expect(await page.inputValue('#country')).toBe('UA');

    // A partial prefix, so ArrowDown + Enter must really commit the suggestion: typing the
    // whole fact would leave the right value in the box even if the list never opened.
    await runOption(page, { ...byId(`type:${city.id}`), value: 'Wroc' });
    expect(await page.inputValue('#city')).toBe('Wrocław');

    await runOption(page, {
      id: radio.id,
      kind: 'element',
      description: 'radio',
      elementId: radio.id,
    });
    expect(await page.isChecked('#r-work')).toBe(true);

    await closePage(page);
  });

  it('stops offering to type a value the field already holds', async () => {
    // Retyping a value the field already holds leaves an identical stateHash, so a persona
    // can burn the whole step budget on it before the loop detector ends the run.
    const page = await openPage();
    await page.goto(server.url('wizard.html'));

    const before = await extract(page);
    const email = before.state.elements.find((e) => e.name === 'Adres e-mail')!;
    expect(email.value).toBeUndefined();
    const option = optionsFor(before.state).options.find((o) => o.id === `type:${email.id}`)!;
    await before.dispose();

    await runOption(page, option);

    const after = await extract(page);
    const filled = after.state.elements.find((e) => e.name === 'Adres e-mail')!;
    expect(filled.value).toBe('olena.k@example.com');
    expect(optionsFor(after.state).options.map((o) => o.id)).not.toContain(`type:${filled.id}`);
    await after.dispose();

    await closePage(page);
  });

  it('fills a text input pinned under a sticky header, clearing the occlusion first', async () => {
    // The `type:` focusing click goes through the same pre-checks as an element click, so a
    // sticky header cannot swallow it.
    const page = await openPage();
    await page.goto(server.url('sticky-form.html'));
    await page.waitForFunction(() => window.scrollY > 1500);

    const ex = await extract(page);
    const given = ex.state.elements.find((e) => e.name === 'Imię')!;
    // Already in the viewport, so scrollIntoViewIfNeeded is not what saves the click.
    expect(given.inViewport).toBe(true);
    const option = optionsFor(ex.state).options.find((o) => o.id === `type:${given.id}`)!;
    await ex.dispose();

    const scrollYBefore = await page.evaluate(() => window.scrollY);
    const result = await runOption(page, option);

    expect(result.outcome.error).toBeUndefined();
    expect(result.overlayBlocked).toBe(false);
    expect(await page.inputValue('#given')).toBe('Olena');
    // The exact delta pins this to our own rescue: the sticky branch scrolls up by the header
    // height plus the margin. A bare handle.click() would fail the hit-target check instead.
    const scrollYAfter = await page.evaluate(() => window.scrollY);
    expect(scrollYBefore - scrollYAfter).toBe(STICKY_HEADER_HEIGHT_PX + STICKY_MARGIN_PX);

    await closePage(page);
  });

  it('flags validation-error and attributes the step to the persona when a fact is missing', async () => {
    const browser = await getBrowser();
    const submitEngine: DecideEngine = {
      async decide(input: DecideInput): Promise<RawDecision> {
        const submit =
          input.options.find((o) => o.description.includes('"Dalej"')) ?? input.options[0]!;
        return {
          distribution: { [submit.id]: 1 },
          goalMet: 0,
          confusion: 1,
          latencyMs: 1,
          stateChars: 100,
          inputTokens: 40,
          offeredOptions: input.options,
          stateText: 'state text',
        };
      },
    };
    const journey = await drive(config(), { browser, engine: submitEngine });
    const first = journey.rows[0]!;
    expect(first.outcome.validationMessages).toContain('Uzasadnienie jest wymagane');
    expect(first.flags).toContain('validation-error');
    expect(first.flags).toContain('missing-fact');
    // A rejected submit did change something, so `no-change` must not fire.
    expect(first.flags).not.toContain('no-change');
    // `Dodatkowe uwagi` is fact-less too, but optional: only a required input explains
    // the rejection.
    expect(first.missingFactLabel).toBe('Uzasadnienie');
    expect(first.bucket).toBe('persona');
  });

  it('marks required inputs and leaves optional ones unmarked', async () => {
    const page = await openPage();
    await page.goto(server.url('wizard.html'));
    const ex = await extract(page);

    const byName = (name: string) => ex.state.elements.find((e) => e.name === name)!;
    expect(byName('Imię').match.required).toBe(true);
    // aria-required is the other marker that counts as required.
    expect(byName('Uzasadnienie').match.required).toBe(true);
    expect(byName('Dodatkowe uwagi').match.required).toBe(false);

    await ex.dispose();
    await closePage(page);
  });

  it('marks disabled controls, names them in the meta, and offers none of them', async () => {
    const page = await openPage();
    await page.goto(server.url('disabled-gate.html'));
    const ex = await extract(page);

    const byName = (name: string) => ex.state.elements.find((e) => e.name === name)!;
    const next = byName('Далі →');
    const city = byName('Місто проживання');
    const help = byName('Довідка');

    // All three stay in the state — they are part of what the persona sees — but marked.
    expect(next.disabled).toBe(true);
    expect(city.disabled).toBe(true);
    expect(help.disabled).toBe(true);
    // The radios are the one thing that is actually actionable here.
    expect(byName('Робота').disabled).toBe(false);

    expect(ex.state.meta.disabledControls).toContain('Далі →');
    expect(ex.state.meta.disabledControls).toContain('Місто проживання');
    expect(ex.state.meta.disabledControls).toContain('Довідка');

    const ids = optionsFor(ex.state).options.map((o) => o.id);
    expect(ids).not.toContain(next.id);
    expect(ids).not.toContain(city.id);
    expect(ids).not.toContain(help.id);
    // Olena has a `city` fact, so only the disabled mark can keep this option away.
    expect(ids).not.toContain(`type:${city.id}`);
    expect(ids).toContain(byName('Робота').id);

    await ex.dispose();
    await closePage(page);
  });

  it('never offers to switch to a language whose link is disabled', async () => {
    const page = await openPage();
    await page.goto(server.url('disabled-gate.html'));
    const ex = await extract(page);

    // A control in the first <legend> of a disabled fieldset is not disabled (HTML spec).
    expect(ex.state.elements.find((e) => e.name === 'Пояснити')!.disabled).toBe(false);

    // The current language is marked aria-disabled, so it is not a switch target at all.
    expect(ex.state.meta.langSwitcher.map((l) => l.code)).toEqual(['pl']);

    const reader = {
      ...OLENA,
      languages: { native: 'uk', reads: { uk: 'fluent', pl: 'fluent' } },
    } as PersonaProfile;
    const ids = buildOptions({
      state: ex.state,
      persona: reader,
      scrollBlocked: { down: false, up: false },
      canGoBack: false,
    }).options.map((o) => o.id);
    expect(ids).toContain('switch_language:pl');
    expect(ids).not.toContain('switch_language:uk');

    await ex.dispose();
    await closePage(page);
  });

  it('offers the gated Next button once a radio unlocks it', async () => {
    const page = await openPage();
    await page.goto(server.url('disabled-gate.html'));
    await page.click('#r-work');

    const ex = await extract(page);
    const next = ex.state.elements.find((e) => e.name === 'Далі →')!;
    expect(next.disabled).toBe(false);
    expect(ex.state.meta.disabledControls).not.toContain('Далі →');
    expect(optionsFor(ex.state).options.map((o) => o.id)).toContain(next.id);

    await ex.dispose();
    await closePage(page);
  });

  it('moves the state hash when a radio unlocks the gate', async () => {
    // The loop detector reads progress off stateHash, so an answer that only flips a button
    // from disabled to enabled has to register as a change.
    const page = await openPage();
    await page.goto(server.url('disabled-gate.html'));

    const before = await extract(page);
    const beforeHash = before.state.stateHash;
    await before.dispose();

    await page.click('#r-work');
    const after = await extract(page);
    expect(after.state.stateHash).not.toBe(beforeHash);
    await after.dispose();

    await closePage(page);
  });

  it('gives an identical action sequence for the same seed on the wizard', async () => {
    const browser = await getBrowser();
    const spread = (): DecideEngine => ({
      async decide(input: DecideInput): Promise<RawDecision> {
        const ids = input.options.map((o) => o.id);
        const distribution: Record<string, number> = {};
        const total = (ids.length * (ids.length + 1)) / 2;
        ids.forEach((id, i) => {
          distribution[id] = (ids.length - i) / total;
        });
        return {
          distribution,
          goalMet: 0,
          confusion: 1,
          latencyMs: 1,
          stateChars: 100,
          inputTokens: 40,
          offeredOptions: input.options,
          stateText: 'state text',
        };
      },
    });
    const sequence = (j: Journey) => j.rows.map((r) => r.sampled);
    const one = await drive(config({ maxSteps: 5, seed: 3 }), { browser, engine: spread() });
    const two = await drive(config({ maxSteps: 5, seed: 3 }), { browser, engine: spread() });
    expect(sequence(one)).toEqual(sequence(two));
    expect(one.rows.length).toBeGreaterThan(1);
  });

  it('moves the state hash when only the question above identical controls changes', async () => {
    const page = await openPage();
    await page.goto(server.url('wizard-questions.html'));

    const before = await extract(page);
    const yes = before.state.elements.find((e) => e.name === 'Tak')!;
    const beforeNames = before.state.elements.map((e) => e.name);

    await runOption(page, { id: yes.id, kind: 'element', description: 'tak', elementId: yes.id });

    const after = await extract(page);
    // Same controls, same order: a signature built from controls alone cannot tell the two
    // steps apart, and the persona answering the question would read as going nowhere.
    expect(after.state.elements.map((e) => e.name)).toEqual(beforeNames);
    expect(after.state.meta.visibleText.map((b) => b.text)).not.toEqual(
      before.state.meta.visibleText.map((b) => b.text),
    );
    expect(after.state.stateHash).not.toBe(before.state.stateHash);
    expect(hasStateChanged(before.state, after.state)).toBe(true);

    await before.dispose();
    await after.dispose();
    await closePage(page);
  });
});
