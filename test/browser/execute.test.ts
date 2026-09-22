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
import type { Frame, Page } from 'playwright';
import { extract } from '../../engine/extract';
import {
  CLICK_PHASE_BUDGET_MS,
  execute,
  NAV_TIMEOUT_MS,
  settle,
  SETTLE_LATE_MS,
  SETTLE_MAX_MS,
  SETTLE_POLL_MS,
  STICKY_MARGIN_PX,
} from '../../engine/execute';
import { createPageMonitor } from '../../engine/page-monitor';
import type { Option } from '../../engine/types';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await closeBrowser();
  await stopFixtureServer();
});

/** The fixed header height declared by test/fixtures/sticky-header.html. */
const HEADER_HEIGHT_PX = 120;

/** The fixed footer height declared by test/fixtures/sticky-footer.html. */
const FOOTER_HEIGHT_PX = 120;

/** The fixed banner height declared by test/fixtures/sticky-frame-child.html. */
const FRAME_BANNER_HEIGHT_PX = 150;

/** Slack allowed around the settle cap: one poll interval. */
const SETTLE_POLL_BUDGET_MS = 50;

/** The same-origin child frame of test/fixtures/sticky-frame-host.html. */
async function childFrame(page: Page): Promise<Frame> {
  const frame = page.frames().find((f) => f.url().includes('sticky-frame-child'));
  if (!frame) throw new Error('child frame not attached');
  return frame;
}

function metaOption(id: 'scroll_down' | 'scroll_up' | 'back'): Option {
  return { id, kind: id, description: id };
}

/** Extract, execute one option, and return the result. The monitor is created before navigation by the caller. */
async function run(page: Page, option: Option, monitor = createPageMonitor(page)) {
  const extraction = await extract(page);
  monitor.mark();
  const result = await execute({
    page,
    extraction,
    option,
    monitor,
    reExtract: () => extract(page),
  });
  await extraction.dispose();
  return result;
}

async function idOf(page: Page, name: string): Promise<string> {
  const ex = await extract(page);
  const id = ex.state.elements.find((e) => e.name === name)!.id;
  await ex.dispose();
  return id;
}

describeBrowser('execute', () => {
  it('scrolls a below-fold target into view and lands the click', async () => {
    const page = await openPage();
    await page.goto(server.url('below-fold.html'));
    const id = await idOf(page, 'Start now');
    const result = await run(page, { id, kind: 'element', description: 'cta', elementId: id });
    expect(result.outcome.error).toBeUndefined();
    expect(await page.title()).toBe('clicked');
    // The `no-change` flag is limited to link/button/submit, so execute captures the identity.
    expect(result.targetRole).toBe('button');
    expect(result.targetInputType).toBeUndefined();
    await result.after?.dispose();
    await closePage(page);
  });

  it('scrolls out from under a sticky header that covers an already-visible target', async () => {
    const page = await openPage();
    await page.goto(server.url('sticky-header.html'));
    await page.waitForFunction(() => window.scrollY > 1500);

    const ex = await extract(page);
    const cta = ex.state.elements.find((e) => e.name === 'Start now')!;
    // Already in the viewport, so scrollIntoViewIfNeeded cannot be what saves the click.
    expect(cta.inViewport).toBe(true);
    await ex.dispose();

    const scrollYBefore = await page.evaluate(() => window.scrollY);
    const result = await run(page, {
      id: cta.id,
      kind: 'element',
      description: 'cta',
      elementId: cta.id,
    });
    expect(result.outcome.error).toBeUndefined();
    expect(result.outcome.errorClass).toBeUndefined();

    // The click really landed on the button, not on the header.
    expect(await page.getAttribute('#cta', 'data-clicked')).toBe('yes');
    expect(await page.title()).toBe('cta-clicked');

    // And it landed because the sticky branch scrolled up by the header height plus the margin,
    // clearing the occlusion before the click. The exact delta is what pins this to our own
    // rescue: Playwright's click retry also frees an occluded target, but by centering it, which
    // moves the page several hundred pixels. Deleting the sticky branch fails this assertion.
    const scrollYAfter = await page.evaluate(() => window.scrollY);
    expect(scrollYBefore - scrollYAfter).toBeGreaterThanOrEqual(120);
    expect(scrollYBefore - scrollYAfter).toBe(HEADER_HEIGHT_PX + STICKY_MARGIN_PX);

    await result.after?.dispose();
    await closePage(page);
  });

  it('scrolls down when the pinned occluder sits below the target', async () => {
    const page = await openPage();
    await page.goto(server.url('sticky-footer.html'));
    await page.waitForFunction(() => window.scrollY > 1000);

    const ex = await extract(page);
    const cta = ex.state.elements.find((e) => e.name === 'Start now')!;
    expect(cta.inViewport).toBe(true);
    await ex.dispose();

    const scrollYBefore = await page.evaluate(() => window.scrollY);
    const result = await run(page, {
      id: cta.id,
      kind: 'element',
      description: 'cta',
      elementId: cta.id,
    });
    expect(result.outcome.errorClass).toBeUndefined();
    expect(await page.getAttribute('#cta', 'data-clicked')).toBe('yes');

    // The bar is below the target, so the rescue moves the page the other way: scrolling up
    // would push the target further under it.
    const scrollYAfter = await page.evaluate(() => window.scrollY);
    expect(scrollYAfter - scrollYBefore).toBe(FOOTER_HEIGHT_PX + STICKY_MARGIN_PX);

    await result.after?.dispose();
    await closePage(page);
  });

  it('does not call a banner filling a small iframe an overlay', async () => {
    const page = await openPage();
    await page.goto(server.url('sticky-frame-host.html'));
    const child = await childFrame(page);
    await child.waitForFunction(() => window.scrollY > 100);

    const id = await idOf(page, 'Start now');
    expect(id.startsWith('f1:')).toBe(true);
    const result = await run(page, { id, kind: 'element', description: 'cta', elementId: id });

    // 150px of a 300x250 frame is 60% of that frame but 5% of the 1280x720 page. Judged against
    // the frame it would look like a full-page consent veil and the step would try to dismiss it.
    expect(result.overlayBlocked).toBe(false);
    expect(result.outcome.errorClass).toBeUndefined();
    await result.after?.dispose();
    await closePage(page);
  });

  it('scrolls the iframe own window to clear a sticky header inside that iframe', async () => {
    const page = await openPage();
    await page.goto(server.url('sticky-frame-host.html'));
    const child = await childFrame(page);
    await child.waitForFunction(() => window.scrollY > 100);

    const scrollBefore = await child.evaluate(() => window.scrollY);
    const topScrollBefore = await page.evaluate(() => window.scrollY);
    const id = await idOf(page, 'Start now');
    const result = await run(page, { id, kind: 'element', description: 'cta', elementId: id });

    expect(result.outcome.errorClass).toBeUndefined();
    expect(await child.getAttribute('#cta', 'data-clicked')).toBe('yes');
    // The frame scrolled, not the top page: scrolling the top window moves the whole iframe and
    // leaves the button exactly as covered as it was.
    expect(scrollBefore - (await child.evaluate(() => window.scrollY))).toBe(
      FRAME_BANNER_HEIGHT_PX + STICKY_MARGIN_PX,
    );
    expect(await page.evaluate(() => window.scrollY)).toBe(topScrollBefore);
    await result.after?.dispose();
    await closePage(page);
  });

  it('reports urlChanged for a client-side navigation that commits during settle', async () => {
    const page = await openPage();
    await page.goto(server.url('client-nav.html'));
    const id = await idOf(page, 'Register now');
    const result = await run(page, { id, kind: 'element', description: 'cta', elementId: id });

    // The pushState lands ~400ms after the click, so a URL sampled before settle still shows
    // the old page and the row claimed the CTA looped back to where it started.
    expect(result.after!.state.meta.url).toContain('/uk/register?step=1');
    expect(result.outcome.urlChanged).toBe(true);
    await result.after?.dispose();
    await closePage(page);
  });

  it('goes back to the previous document', async () => {
    const page = await openPage();
    await page.goto(server.url('broken-link.html'));
    const first = page.url();

    const id = await idOf(page, 'Download the form');
    const forward = await run(page, { id, kind: 'element', description: 'link', elementId: id });
    expect(page.url()).not.toBe(first);
    await forward.after?.dispose();

    const back = await run(page, metaOption('back'));
    expect(back.outcome.urlChanged).toBe(true);
    expect(page.url()).toBe(first);
    await back.after?.dispose();
    await closePage(page);
  });

  it('dismisses a cookie overlay via close, not accept, before clicking the covered call to action', async () => {
    const page = await openPage();
    await page.goto(server.url('cookie-modal.html'));
    const extraction = await extract(page);
    expect(extraction.state.elements.find((e) => e.name === 'Wybierz plan')).toBeUndefined();
    const template = extraction.state.elements[0]!;
    const handle = await page.locator('#cta').elementHandle();
    extraction.state.elements.push({
      ...template,
      id: 'el_cta',
      name: 'Wybierz plan',
      overlay: false,
      dismissesOverlay: false,
    });
    extraction.handles.set('el_cta', handle!);
    const monitor = createPageMonitor(page);
    monitor.mark();
    const result = await execute({
      page,
      extraction,
      option: { id: 'el_cta', kind: 'element', description: 'cta', elementId: 'el_cta' },
      monitor,
      reExtract: () => extract(page),
    });
    expect(result.overlayBlocked).toBe(false);
    expect(result.overlayDismissal).toEqual({ dismissed: true, method: 'control' });
    expect(await page.evaluate(() => document.body.dataset.dismissed)).toBe('close');
    expect(await page.title()).toBe('cta-clicked');
    await extraction.dispose();
    await result.after?.dispose();
    await closePage(page);
  });

  it('does not accept cookies when a covered target has only consent choices', async () => {
    const page = await openPage();
    await page.goto(server.url('consent-choice.html'));
    const extraction = await extract(page);
    expect(extraction.state.elements.find((e) => e.name === 'Choose plan')).toBeUndefined();
    expect(extraction.state.elements.find((e) => e.name === 'Accept all')!.dismissesOverlay).toBe(
      false,
    );
    const template = extraction.state.elements[0]!;
    const handle = await page.locator('#cta').elementHandle();
    extraction.state.elements.push({
      ...template,
      id: 'el_cta',
      name: 'Choose plan',
      overlay: false,
      dismissesOverlay: false,
    });
    extraction.handles.set('el_cta', handle!);
    const monitor = createPageMonitor(page);
    monitor.mark();
    const result = await execute({
      page,
      extraction,
      option: { id: 'el_cta', kind: 'element', description: 'cta', elementId: 'el_cta' },
      monitor,
      reExtract: () => extract(page),
    });
    expect(result.overlayBlocked).toBe(true);
    expect(result.overlayDismissal).toBeUndefined();
    expect(await page.evaluate(() => document.body.dataset.dismissed ?? '')).toBe('');
    expect(await page.title()).toBe('Consent choice');
    expect(await page.locator('#dialog').count()).toBe(1);
    await extraction.dispose();
    await result.after?.dispose();
    await closePage(page);
  });

  it('reports overlayBlocked when the overlay survives the dismissal', async () => {
    const page = await openPage();
    await page.goto(server.url('stubborn-overlay.html'));
    await page.evaluate(() => document.getElementById('veil')!.remove());
    const extraction = await extract(page);
    const cta = extraction.state.elements.find((e) => e.name === 'Choose plan')!;
    await page.evaluate(() => {
      const veil = document.createElement('div');
      veil.id = 'veil';
      veil.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50';
      document.body.appendChild(veil);
    });
    const monitor = createPageMonitor(page);
    monitor.mark();
    const result = await execute({
      page,
      extraction,
      option: { id: cta.id, kind: 'element', description: 'cta', elementId: cta.id },
      monitor,
      reExtract: () => extract(page),
    });
    // The diagnosis has to survive the click that then fails: this is the step the driver flags
    // `overlay-blocked`, and the flag would be lost if the throw discarded the pre-check result.
    expect(result.overlayBlocked).toBe(true);
    // No dismiss control anywhere, so only Escape was tried: a harness limitation, which the
    // driver flags `overlay-undismissed` rather than blaming the site for a trapping overlay.
    expect(result.overlayDismissal).toEqual({ dismissed: true, method: 'escape' });
    expect(result.outcome.errorClass).toBe('intercepted');
    expect(await page.title()).toBe('Stubborn overlay');
    await extraction.dispose();
    await result.after?.dispose();
    await closePage(page);
  });

  it('clicks the right one of two identically named buttons', async () => {
    const page = await openPage();
    await page.goto(server.url('duplicate-cta.html'));
    const ex = await extract(page);
    const second = ex.state.elements.filter((e) => e.name === 'Choose plan')[1]!;
    await ex.dispose();
    const result = await run(page, {
      id: second.id,
      kind: 'element',
      description: 'cta',
      elementId: second.id,
    });
    expect(await page.title()).toBe('enterprise');
    await result.after?.dispose();
    await closePage(page);
  });

  it('retries once when a re-render detaches the handle', async () => {
    const page = await openPage();
    await page.goto(server.url('stale-rerender.html', { mode: 'once' }));
    const extraction = await extract(page);
    const target = extraction.state.elements.find((e) => e.name === 'Continue')!;
    await page.evaluate(() => (window as unknown as { __rerender: () => boolean }).__rerender());

    const monitor = createPageMonitor(page);
    monitor.mark();
    const result = await execute({
      page,
      extraction,
      option: { id: target.id, kind: 'element', description: 'continue', elementId: target.id },
      monitor,
      reExtract: () => extract(page),
    });
    expect(result.stale).toBe(false);
    expect(await page.title()).toBe('continue-clicked');
    await extraction.dispose();
    await result.after?.dispose();
    monitor.dispose();
    await closePage(page);
  });

  it('falls back to a role+name locator when every fresh handle is detached too', async () => {
    const page = await openPage();
    // The framework replaces the node every 150ms, so no handle survives long enough to be
    // clicked and the re-extract retry detaches as well. A person still sees one button.
    await page.goto(server.url('rerender-loop.html'));
    const extraction = await extract(page);
    const target = extraction.state.elements.find((e) => e.name === 'Continue')!;
    // Detach the handle the step was given, then the one its retry takes, so the fallback is
    // reached on purpose rather than whenever the timer happens to fire.
    await page.evaluate(() => (window as unknown as { __rerender: () => void }).__rerender());

    const monitor = createPageMonitor(page);
    monitor.mark();
    const result = await execute({
      page,
      extraction,
      option: { id: target.id, kind: 'element', description: 'continue', elementId: target.id },
      monitor,
      reExtract: async () => {
        const next = await extract(page);
        await page.evaluate(() => (window as unknown as { __rerender: () => void }).__rerender());
        return next;
      },
    });

    expect(result.outcome.error).toBeUndefined();
    expect(result.stale).toBe(false);
    expect(await page.title()).toBe('continue-clicked');

    await extraction.dispose();
    await result.after?.dispose();
    monitor.dispose();
    await closePage(page);
  });

  it('buckets stale when no handle survives and no locator can reach the element', async () => {
    const page = await openPage();
    // The control is inside an iframe, so the role+name fallback is not available and the
    // page around it never changes: nothing says the action happened.
    await page.goto(server.url('rerender-frame-host.html'));
    const extraction = await extract(page);
    const target = extraction.state.elements.find((e) => e.name === 'Continue')!;
    expect(target.id).toContain(':');
    const rerender = async () => {
      const child = page.frames().find((f) => f !== page.mainFrame())!;
      await child.evaluate(() => (window as unknown as { __rerender: () => void }).__rerender());
    };
    await rerender();

    const monitor = createPageMonitor(page);
    monitor.mark();
    const started = Date.now();
    const result = await execute({
      page,
      extraction,
      option: { id: target.id, kind: 'element', description: 'continue', elementId: target.id },
      monitor,
      reExtract: async () => {
        const next = await extract(page);
        await rerender();
        return next;
      },
    });
    // A step that cannot reach its target still ends: the click phase is bounded, and no
    // attempt is ever handed the zero timeout Playwright reads as "wait forever".
    expect(Date.now() - started).toBeLessThan(
      CLICK_PHASE_BUDGET_MS + NAV_TIMEOUT_MS + SETTLE_LATE_MS,
    );
    expect(result.stale).toBe(true);
    expect(result.outcome.errorClass).toBe('detached');
    await extraction.dispose();
    await result.after?.dispose();
    monitor.dispose();
    await closePage(page);
  });

  it('reports stateChanged for an SPA tab switch and is not fooled by an aria-live ticker', async () => {
    const page = await openPage();
    await page.goto(server.url('spa-tabs.html'));
    const tabId = await idOf(page, 'Requirements');
    const switched = await run(page, {
      id: tabId,
      kind: 'element',
      description: 'tab',
      elementId: tabId,
    });
    expect(switched.outcome.urlChanged).toBe(false);
    expect(switched.outcome.stateChanged).toBe(true);
    expect(switched.settleMs).toBeLessThanOrEqual(1500);
    // A live aria-live ticker must not push settle past its cap.
    await switched.after?.dispose();

    const idle = await run(page, metaOption('scroll_up'));
    expect(idle.outcome.stateChanged).toBe(false);
    await idle.after?.dispose();
    await closePage(page);
  });

  it('settles quickly on a page with no interactive elements', async () => {
    const page = await openPage();
    await page.setContent('<main><p>Nothing to click here.</p></main>');
    expect(await settle(page)).toBeLessThan(1000);
    await closePage(page);
  });

  it('stops at the cap on a page that never settles', async () => {
    const page = await openPage();
    await page.setContent(
      '<main><button id="b">start</button></main>' +
        '<script>setInterval(() => { document.getElementById("b").textContent = String(Math.random()); }, 30);</script>',
    );
    const settleMs = await settle(page);
    // It really ran to the cap, and the last sleep was trimmed rather than overshooting it.
    expect(settleMs).toBeGreaterThanOrEqual(SETTLE_MAX_MS - SETTLE_POLL_BUDGET_MS);
    expect(settleMs).toBeLessThanOrEqual(SETTLE_MAX_MS + SETTLE_POLL_BUDGET_MS);
    await closePage(page);
  });

  it('captures a same-origin console error and ignores a third-party load error', async () => {
    const page = await openPage();
    const monitor = createPageMonitor(page); // before goto, so the third-party error is in the baseline
    await page.goto(server.url('broken-link.html', { alt: server.altOrigin }));
    await page.waitForTimeout(200);

    const id = await idOf(page, 'Submit application');
    const result = await run(
      page,
      { id, kind: 'element', description: 'submit', elementId: id },
      monitor,
    );
    expect(result.outcome.consoleErrors.length).toBeGreaterThan(0);
    expect(result.outcome.consoleErrors.join(' ')).not.toContain('third-party boom');
    await result.after?.dispose();
    monitor.dispose();
    await closePage(page);
  });

  it('captures a same-origin 404 on a link the persona followed', async () => {
    const page = await openPage();
    const monitor = createPageMonitor(page);
    await page.goto(server.url('broken-link.html'));
    const id = await idOf(page, 'Download the form');
    const result = await run(
      page,
      { id, kind: 'element', description: 'link', elementId: id },
      monitor,
    );
    expect(result.outcome.urlChanged).toBe(true);
    expect(result.outcome.failedRequests.join(' ')).toContain('definitely-missing.html');
    await result.after?.dispose();
    monitor.dispose();
    await closePage(page);
  });

  it('reports per-direction whether a scroll actually moved the page', async () => {
    const page = await openPage();
    await page.goto(server.url('below-fold.html'));
    const down = await run(page, metaOption('scroll_down'));
    expect(down.scrollChangedY).toBe(true);
    await down.after?.dispose();

    await page.evaluate(() => window.scrollTo(0, 0));
    const up = await run(page, metaOption('scroll_up'));
    expect(up.scrollChangedY).toBe(false);
    await up.after?.dispose();
    await closePage(page);
  });

  it('waits past the normal settle for a click that navigates late', async () => {
    const page = await openPage();
    await page.goto(server.url('slow-wizard-step.html'));
    const extraction = await extract(page);
    const target = extraction.state.elements.find((e) => e.name === 'Next')!;

    const monitor = createPageMonitor(page);
    monitor.mark();
    const result = await execute({
      page,
      extraction,
      option: { id: target.id, kind: 'element', description: 'next', elementId: target.id },
      monitor,
      reExtract: () => extract(page),
    });

    // The transition lands at 2.5s, well past SETTLE_MAX_MS: without the late window the step
    // reports urlChanged false and the trace flags a working button `no-change`.
    expect(result.outcome.urlChanged).toBe(true);
    expect(result.outcome.error).toBeUndefined();
    expect(result.settleMs).toBeGreaterThan(SETTLE_MAX_MS);
    expect(result.settleMs).toBeLessThanOrEqual(SETTLE_LATE_MS + SETTLE_POLL_MS);

    await extraction.dispose();
    await result.after?.dispose();
    monitor.dispose();
    await closePage(page);
  });

  it('records the click path, so a fallback is visible in the trace', async () => {
    const page = await openPage();
    await page.goto(server.url('below-fold.html'));
    const id = await idOf(page, 'Start now');
    const result = await run(page, { id, kind: 'element', description: 'cta', elementId: id });
    expect(result.clickPath).toBe('handle');
    await result.after?.dispose();
    await closePage(page);
  });

  it('calls a step that navigated late a success, not a stale detached handle', async () => {
    const page = await openPage();
    // The shape that loses a step on a real wizard: the answer was accepted and the next
    // screen is already on its way, but the button it was given is gone, so every handle and
    // the locator all fail while the page is quietly mid-transition.
    await page.goto(server.url('slow-wizard-step.html', { trigger: 'mousedown' }));
    const extraction = await extract(page);
    const target = extraction.state.elements.find((e) => e.name === 'Next')!;
    await page.evaluate(() =>
      document
        .getElementById('next')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    );
    await page.waitForFunction(() => document.getElementById('next') === null);

    const monitor = createPageMonitor(page);
    monitor.mark();
    const result = await execute({
      page,
      extraction,
      option: { id: target.id, kind: 'element', description: 'next', elementId: target.id },
      monitor,
      reExtract: () => extract(page),
    });

    expect(result.stale).toBe(false);
    expect(result.outcome.error).toBeUndefined();
    expect(result.outcome.urlChanged).toBe(true);
    expect(result.lateTransition).toBe(true);

    await extraction.dispose();
    await result.after?.dispose();
    monitor.dispose();
    await closePage(page);
  });
});
