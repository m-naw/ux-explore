import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeBrowser,
  openPage,
  closePage,
  closeBrowser,
  startFixtureServer,
  stopFixtureServer,
  type FixtureServer,
} from './harness';
import { extract, viewportSignature } from '../../engine/extract';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await closeBrowser();
  await stopFixtureServer();
});

describeBrowser('extract (frames and meta)', () => {
  it('walks the same-origin iframe with an f1: prefix and skips the cross-origin one', async () => {
    const page = await openPage();
    await page.goto(server.url('iframe-host.html', { alt: server.altOrigin }));
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 2);
    await page.waitForTimeout(200);
    const ex = await extract(page);

    const framed = ex.state.elements.filter((e) => e.name === 'Framed action');
    expect(framed).toHaveLength(1);
    expect(framed[0]!.id.startsWith('f1:')).toBe(true);
    expect(framed[0]!.y).toBeGreaterThan(0);
    expect(ex.handles.get(framed[0]!.id)).toBeDefined();
    expect(ex.state.meta.skippedFrames).toBe(1);
    // The frame is on screen, so the copy next to its button is copy the persona can read.
    expect(framed[0]!.inViewport).toBe(true);
    expect(framed[0]!.context?.near).toContain('dwie minuty');

    await ex.dispose();
    await closePage(page);
  });

  it('reads wizard progress, validation messages and language switcher targets', async () => {
    const page = await openPage();
    await page.goto(server.url('iframe-host.html'));
    const ex = await extract(page);

    expect(ex.state.meta.wizardProgress).toBe('Krok 2 z 4');
    expect(ex.state.meta.validationMessages).toContain('Pole jest wymagane');
    expect(ex.state.meta.langSwitcher.map((l) => l.code).sort()).toEqual(['pl', 'uk']);
    const uk = ex.state.meta.langSwitcher.find((l) => l.code === 'uk')!;
    expect(ex.state.elements.some((e) => e.id === uk.elementId)).toBe(true);

    await ex.dispose();
    await closePage(page);
  });

  it('reads Ukrainian wizard progress and class-based validation text', async () => {
    const page = await openPage();
    await page.goto(server.url('wizard-meta.html'));
    const ex = await extract(page);

    expect(ex.state.meta.wizardProgress).toBe('Крок 3 з 5');
    expect(ex.state.meta.validationMessages).toContain('Невірна адреса');
    const email = ex.state.elements.find((e) => e.inputType === 'email')!;
    expect(email.match.name).toBe('email');
    expect(email.landmark).toBe('form');

    await ex.dispose();
    await closePage(page);
  });

  it('treats a below-the-fold iframe as out of viewport until the top page scrolls to it', async () => {
    const page = await openPage();
    await page.goto(server.url('iframe-offscreen.html'));
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 1);
    await page.waitForTimeout(200);

    const atTop = await extract(page);
    const hidden = atTop.state.elements.find((e) => e.name === 'Framed action')!;
    expect(hidden.id.startsWith('f1:')).toBe(true);
    expect(hidden.inViewport).toBe(false);
    // The frame's own viewport showed the copy next to the button, but the top-level viewport
    // did not, so none of it may be carried as context.
    expect(hidden.context).toBeUndefined();
    expect(viewportSignature(atTop.state).some((s) => s.includes('Framed action'))).toBe(false);
    await atTop.dispose();

    await page.evaluate(() => window.scrollTo(0, 3000));
    await page.waitForTimeout(200);

    const scrolled = await extract(page);
    const shown = scrolled.state.elements.find((e) => e.name === 'Framed action')!;
    expect(shown.inViewport).toBe(true);
    expect(shown.context?.near).toContain('dwie minuty');
    expect(viewportSignature(scrolled.state).some((s) => s.includes('Framed action'))).toBe(true);
    await scrolled.dispose();

    await closePage(page);
  });
});
