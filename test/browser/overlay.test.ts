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
import { extract } from '../../engine/extract';
import { annotateOverlays, dismissOverlay } from '../../engine/overlay';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await closeBrowser();
  await stopFixtureServer();
});

describeBrowser('overlay', () => {
  it('flags a full-screen cookie dialog and its dismiss control', async () => {
    const page = await openPage();
    await page.goto(server.url('cookie-modal.html'));
    const ex = await extract(page);

    const accept = ex.state.elements.find((e) => e.name === 'Akceptuję wszystkie')!;
    expect(accept.overlay).toBe(true);
    expect(accept.dismissesOverlay).toBe(true);

    const policy = ex.state.elements.find((e) => e.name === 'Polityka cookie')!;
    expect(policy.overlay).toBe(true);
    expect(policy.dismissesOverlay).toBe(false);

    // Named only by its aria-label, so the keyword has to come from there.
    const close = ex.state.elements.find((e) => e.name === 'Close')!;
    expect(close.overlay).toBe(true);
    expect(close.dismissesOverlay).toBe(true);

    expect(ex.state.elements.find((e) => e.name === 'Wybierz plan')!.overlay).toBe(false);

    expect(await dismissOverlay(page, ex)).toEqual({ dismissed: true, method: 'control' });
    await ex.dispose();

    const after = await extract(page);
    expect(after.state.elements.some((e) => e.overlay)).toBe(false);
    await after.dispose();
    await closePage(page);
  });

  it('detects a bottom bar under 20 percent of the viewport via its dismiss keyword', async () => {
    const page = await openPage();
    await page.goto(server.url('cookie-bar.html'));
    const ex = await extract(page);

    const ok = ex.state.elements.find((e) => e.name === 'Got it')!;
    expect(ok.overlay).toBe(true);
    expect(ok.dismissesOverlay).toBe(true);

    // The control the bar covers is not itself in an overlay: it has no pinned ancestor.
    expect(ex.state.elements.find((e) => e.name === 'Choose plan')!.overlay).toBe(false);

    await ex.dispose();
    await closePage(page);
  });

  it('counts a control inside an open shadow root among what a keyword bar covers', async () => {
    const page = await openPage();
    await page.goto(server.url('overlay-shadow-summary.html'));
    const ex = await extract(page);

    // The only thing the bar covers is a <summary> inside a shadow root, which a plain
    // document.querySelectorAll of link/button/input would never see.
    const ok = ex.state.elements.find((e) => e.name === 'Got it')!;
    expect(ok.overlay).toBe(true);
    expect(ok.dismissesOverlay).toBe(true);

    await ex.dispose();
    await closePage(page);
  });

  it('keeps flags on the right ids after state.elements has been filtered', async () => {
    const page = await openPage();
    await page.goto(server.url('cookie-modal.html'));
    const ex = await extract(page);

    const accept = ex.state.elements.find((e) => e.name === 'Akceptuję wszystkie')!;
    expect(accept.id).toBe('el_02');

    // Later steps drop elements from state.elements (the option cap's droppedElements); the ids
    // stay the ordinals extract assigned, so annotation must key off the id, not the position.
    ex.state.elements = ex.state.elements.filter((e) => e.id === 'el_02');
    for (const el of ex.state.elements) {
      el.overlay = false;
      el.dismissesOverlay = false;
    }
    await annotateOverlays(page, ex.state);

    expect(ex.state.elements[0]!.overlay).toBe(true);
    expect(ex.state.elements[0]!.dismissesOverlay).toBe(true);

    await ex.dispose();
    await closePage(page);
  });

  it('ignores a control off the side of the viewport when judging what a keyword bar covers', async () => {
    const page = await openPage();
    await page.goto(server.url('overlay-offscreen.html'));
    const ex = await extract(page);

    // The bar covers the centre of `Ghost`, but `Ghost` is entirely left of the viewport, so the
    // four-edge in-viewport test the extractor uses rules it out and the bar is not an overlay.
    const ok = ex.state.elements.find((e) => e.name === 'Got it')!;
    expect(ok.overlay).toBe(false);
    expect(ok.dismissesOverlay).toBe(false);

    await ex.dispose();
    await closePage(page);
  });

  it('measures an in-frame panel against the top-level viewport, not the frame', async () => {
    const page = await openPage();
    await page.goto(server.url('iframe-overlay-host.html'));
    const ex = await extract(page);

    // 88px of a 400px frame is 22% of the frame but 12% of the 720px top-level viewport, and the
    // panel carries no dismiss keyword, so neither overlay rule fires.
    const details = ex.state.elements.find((e) => e.name === 'Show details')!;
    expect(details.id.startsWith('f1:')).toBe(true);
    expect(details.overlay).toBe(false);

    await ex.dispose();
    await closePage(page);
  });

  it('falls back to Escape and says so when there is no dismiss control', async () => {
    const page = await openPage();
    await page.goto(server.url('below-fold.html'));
    const ex = await extract(page);
    expect(await dismissOverlay(page, ex)).toEqual({ dismissed: true, method: 'escape' });
    await ex.dispose();
    await closePage(page);
  });
});
