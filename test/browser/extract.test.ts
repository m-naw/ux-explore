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
import { extract, sha1 } from '../../engine/extract';
import { hasStateChanged } from '../../engine/state-diff';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await closeBrowser();
  await stopFixtureServer();
});

describeBrowser('extract (main frame)', () => {
  it('keeps below-fold elements, marks them out of viewport and records document y', async () => {
    const page = await openPage();
    await page.goto(server.url('below-fold.html'));
    const ex = await extract(page);

    const cta = ex.state.elements.find((e) => e.name === 'Start now')!;
    expect(cta.role).toBe('button');
    expect(cta.inViewport).toBe(false);
    expect(cta.y).toBeGreaterThan(2000);
    expect(cta.landmark).toBe('main');

    const home = ex.state.elements.find((e) => e.name === 'Home')!;
    expect(home.landmark).toBe('nav');
    expect(home.href).toBe('/home');
    expect(home.inViewport).toBe(true);

    expect(ex.state.elements.find((e) => e.name === 'Terms of Service')!.landmark).toBe('footer');
    expect(ex.state.meta.title).toBe('Below fold');
    expect(ex.state.meta.lang).toBe('en');
    expect(ex.state.meta.h1).toBe('Below the fold');
    expect(ex.state.meta.mainText.length).toBeLessThanOrEqual(300);
    expect(ex.state.meta.scrollMax).toBeGreaterThan(1000);
    expect(ex.state.meta.viewport).toEqual({ width: 1280, height: 720 });

    await ex.dispose();
    await closePage(page);
  });

  it('gives identically named buttons distinct ids with live handles', async () => {
    const page = await openPage();
    await page.goto(server.url('duplicate-cta.html'));
    const ex = await extract(page);

    const chosen = ex.state.elements.filter((e) => e.name === 'Choose plan');
    expect(chosen).toHaveLength(2);
    expect(new Set(chosen.map((e) => e.id)).size).toBe(2);
    expect(ex.handles.size).toBe(ex.state.elements.length);
    expect(await ex.handles.get(chosen[0]!.id)!.getAttribute('data-plan')).toBe('family');

    await ex.dispose();
    await closePage(page);
  });

  it('sees elements that appear only after a scroll', async () => {
    const page = await openPage();
    await page.goto(server.url('lazy-list.html'));
    const before = await extract(page);
    expect(before.state.elements.filter((e) => e.role === 'link')).toHaveLength(1);
    await before.dispose();

    await page.evaluate(() => window.scrollTo(0, 800));
    await page.waitForFunction(() => document.querySelectorAll('#list a').length === 4);
    const after = await extract(page);
    expect(after.state.elements.filter((e) => e.role === 'link').map((e) => e.name)).toEqual([
      'Item 1',
      'Item 2',
      'Item 3',
      'Item 4',
    ]);
    await after.dispose();
    await closePage(page);
  });

  it('walks open shadow roots and counts closed ones', async () => {
    const page = await openPage();
    await page.goto(server.url('shadow.html'));
    const ex = await extract(page);

    expect(ex.state.elements.some((e) => e.name === 'Open shadow action')).toBe(true);
    expect(ex.state.elements.some((e) => e.name === 'Invisible to the extractor')).toBe(false);
    expect(ex.state.meta.closedRoots).toBe(1);

    await ex.dispose();
    await closePage(page);
  });

  it('keeps a ticking aria-live counter out of the state hash', async () => {
    const page = await openPage();
    await page.goto(server.url('aria-live.html'));

    const a = await extract(page);
    const tickerBefore = a.state.elements.find((e) => e.inAriaLive)!;
    expect(tickerBefore.role).toBe('button');
    await page.waitForTimeout(200);
    const b = await extract(page);
    const tickerAfter = b.state.elements.find((e) => e.inAriaLive)!;

    // The ticker text really did change, and the hash did not.
    expect(tickerAfter.name).not.toBe(tickerBefore.name);
    expect(b.state.stateHash).toBe(a.state.stateHash);

    await a.dispose();
    await b.dispose();
    await closePage(page);
  });

  it('keeps an overlay control inside a live region in the state hash', async () => {
    // A consent banner whose inner wrapper is aria-live: dismissing it is a real state change,
    // and excluding it made the accept click read as `no-change` / "tap not registered".
    const page = await openPage();
    await page.goto(server.url('aria-live-consent.html'));

    const before = await extract(page);
    const accept = before.state.elements.find((e) => e.name === 'Accept all')!;
    expect(accept.inAriaLive).toBe(true);
    expect(accept.overlay).toBe(true);
    expect(accept.dismissesOverlay).toBe(false);

    await page.click('#accept');
    const after = await extract(page);
    expect(after.state.elements.some((e) => e.name === 'Accept all')).toBe(false);

    expect(after.state.stateHash).not.toBe(before.state.stateHash);
    expect(hasStateChanged(before.state, after.state)).toBe(true);

    await before.dispose();
    await after.dispose();
    await closePage(page);
  });

  it('changes the state hash after navigation', async () => {
    const page = await openPage();
    await page.goto(server.url('duplicate-cta.html'));
    const a = await extract(page);
    await page.goto(server.url('shadow.html'));
    const b = await extract(page);
    expect(b.state.stateHash).not.toBe(a.state.stateHash);
    await a.dispose();
    await b.dispose();
    await closePage(page);
  });
  it('extracts on a context the harness never touched, where __name is undefined', async () => {
    const browser = await getBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      // No addInitScript on purpose. tsx rewrites collectInFrame's declarations to __name(...),
      // so the extractor has to install the shim itself or evaluateHandle throws ReferenceError.
      expect(await page.evaluate('typeof globalThis.__name')).toBe('undefined');

      await page.goto(server.url('duplicate-cta.html'));
      const ex = await extract(page);
      expect(ex.state.elements.length).toBeGreaterThan(0);
      expect(ex.state.elements.filter((e) => e.name === 'Choose plan')).toHaveLength(2);

      // The extractor installed the shim itself. vitest's transform happens not to emit
      // __name, so only this assertion catches the regression here; under tsx the missing
      // shim makes extract() throw ReferenceError outright.
      expect(await page.evaluate('typeof globalThis.__name')).toBe('function');
      await ex.dispose();
    } finally {
      await context.close();
    }
  });

  it('emits the label instead of the visually hidden control it proxies', async () => {
    const page = await openPage();
    await page.goto(server.url('hidden-controls.html'));
    const ex = await extract(page);

    // One element per control: the clip-rect checkbox, the opacity:0 checkbox and the
    // clip-rect select, never both halves of any pair.
    expect(ex.state.elements.map((e) => `${e.role}|${e.name}`)).toEqual([
      'checkbox|Accept terms',
      'checkbox|Subscribe to the newsletter',
      'combobox|Choose a size',
    ]);
    // Role, input type and match hints come from the hidden target; the name from the label.
    expect(ex.state.elements.map((e) => e.inputType)).toEqual(['checkbox', 'checkbox', undefined]);
    expect(ex.state.elements.map((e) => e.match.name)).toEqual(['terms', 'news', 'size']);
    expect(ex.state.elements.every((e) => e.landmark === 'form')).toBe(true);

    // hasValue and selectOptions read the hidden control, not the label that proxies it.
    // Neither checkbox is ticked, so only the select holds a value; `.value` on an untouched
    // checkbox is "on" and says nothing about what the persona chose.
    expect(ex.state.elements.map((e) => e.hasValue)).toEqual([false, false, true]);
    expect(ex.state.elements[2]!.selectOptions).toEqual([
      { value: 's', label: 'Small' },
      { value: 'm', label: 'Medium' },
    ]);

    await ex.dispose();
    await closePage(page);
  });

  it('fills match.label from the associated label only, never from the accessible name', async () => {
    // The `label` hint and the accessible name are separate match sources, so they must stay
    // two different strings. An aria-label names the control without giving it an associated
    // label, and must leave the hint empty.
    const page = await openPage();
    await page.goto(server.url('label-hints.html'));
    const ex = await extract(page);

    expect(ex.state.elements.map((e) => e.name)).toEqual(['Miasto', 'Telefon', 'Pracodawca']);
    // Lowercased like every other hint; empty for the aria-label-only control.
    expect(ex.state.elements.map((e) => e.match.label)).toEqual(['', 'telefon', 'pracodawca']);

    await ex.dispose();
    await closePage(page);
  });

  it('trims an over-long accessible name to 80 characters', async () => {
    const page = await openPage();
    await page.goto(server.url('naming.html'));
    const ex = await extract(page);

    // The fixture's aria-label is exactly 120 characters.
    const verbose = ex.state.elements[0]!;
    expect(verbose.unnamed).toBe(false);
    expect(verbose.name).toHaveLength(80);
    expect(verbose.name.startsWith('Subscribe to the premium accessibility newsletter')).toBe(true);

    await ex.dispose();
    await closePage(page);
  });

  it('synthesises a capped placeholder name for icon-only buttons', async () => {
    const page = await openPage();
    await page.goto(server.url('naming.html'));
    const ex = await extract(page);

    const unnamed = ex.state.elements.filter((e) => e.unnamed);
    expect(unnamed).toHaveLength(2);

    const icon = unnamed[0]!;
    expect(icon.role).toBe('button');
    expect(icon.name).toBe('[unnamed button, class "icon-btn round"]');

    // The placeholder is built from class names, so it is capped like a real name.
    expect(unnamed[1]!.name).toHaveLength(80);

    await ex.dispose();
    await closePage(page);
  });

  it('truncates main text to 300 characters', async () => {
    const page = await openPage();
    await page.goto(server.url('naming.html'));
    const ex = await extract(page);

    expect(ex.state.meta.mainText).toHaveLength(300);

    await ex.dispose();
    await closePage(page);
  });

  it('buckets the view hash by half a viewport of scroll', async () => {
    const page = await openPage();
    await page.goto(server.url('below-fold.html'));

    const top = await extract(page);
    expect(top.state.meta.scrollY).toBe(0);
    expect(top.state.viewHash).toBe(sha1(`${top.state.stateHash}:0`));

    // 1.2 viewports down: floor(864 / (0.5 * 720)) === 2.
    await page.evaluate(() => window.scrollTo(0, Math.round(1.2 * window.innerHeight)));
    const down = await extract(page);
    expect(down.state.meta.scrollY).toBe(864);
    expect(down.state.viewHash).toBe(sha1(`${down.state.stateHash}:2`));
    expect(down.state.viewHash).not.toBe(top.state.viewHash);

    await top.dispose();
    await down.dispose();
    await closePage(page);
  });

  it('skips label proxies inside a hidden wizard panel', async () => {
    const page = await openPage();
    await page.goto(server.url('hidden-panel.html'));
    const ex = await extract(page);

    const names = ex.state.elements.map((e) => e.name);
    expect(names).toContain('Praca');
    expect(names).toContain('Studia');
    // The second panel is display:none, so its sr-only radios are not reachable and their
    // label proxies must not be offered as options.
    expect(names).not.toContain('Małżeństwo');
    expect(names).not.toContain('Dziecko');

    await ex.dispose();
    await closePage(page);
  });

  it('normalizes the document language and hreflang to a primary subtag', async () => {
    const page = await openPage();
    await page.goto(server.url('lang-tags.html'));
    const ex = await extract(page);

    expect(ex.state.meta.lang).toBe('pl');
    const codes = ex.state.meta.langSwitcher.map((l) => l.code);
    expect(codes).toContain('uk');
    // x-default names a fallback route, not a language, so it is dropped entirely.
    expect(codes).not.toContain('x-default');
    expect(codes).not.toContain('x');
    // The query-string fallback still applies to an anchor with no hreflang.
    expect(codes).toContain('en');

    await ex.dispose();
    await closePage(page);
  });

  it('dispose() releases every element handle', async () => {
    const page = await openPage();
    await page.goto(server.url('duplicate-cta.html'));
    const ex = await extract(page);

    const handle = ex.handles.get(ex.state.elements[0]!.id)!;
    expect(await handle.evaluate((node) => (node as Element).tagName)).toBe('BUTTON');

    await ex.dispose();

    expect(ex.handles.size).toBe(0);
    await expect(handle.evaluate((node) => (node as Element).tagName)).rejects.toThrow();

    await closePage(page);
  });
});
