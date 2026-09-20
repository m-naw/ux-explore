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
import {
  extract,
  VISIBLE_TEXT_CHARS,
  TEXT_BLOCK_CHARS,
  CONTEXT_NEAR_CHARS,
} from '../../engine/extract';
import type { TextBlock } from '../../engine/types';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await closeBrowser();
  await stopFixtureServer();
});

/** Exactly how `renderStateText` joins the blocks, so the test measures the real budget. */
const joined = (blocks: TextBlock[]): string => blocks.map((b) => b.text).join('\n');

describeBrowser('visible page text', () => {
  it('sends only the text in the viewport and counts the rest', async () => {
    const page = await openPage();
    await page.goto(server.url('long-article.html'));
    const ex = await extract(page);

    const text = joined(ex.state.meta.visibleText);
    expect(text).toContain('[h1] How the residence card works');
    expect(text).toContain('A residence card proves your right to stay');
    expect(text).not.toContain('The check takes two minutes');
    expect(text).not.toContain('Filed applications are reviewed');
    expect(ex.state.meta.belowFoldTextChars).toBeGreaterThan(50);
    expect(text.length).toBeLessThanOrEqual(VISIBLE_TEXT_CHARS);
    await ex.dispose();
    await closePage(page);
  });

  it('includes the CTA copy once it is scrolled into view', async () => {
    const page = await openPage();
    await page.goto(server.url('long-article.html'));
    await page.evaluate(() => {
      document.getElementById('cta')!.scrollIntoView({ block: 'center' });
    });
    const ex = await extract(page);

    const text = joined(ex.state.meta.visibleText);
    expect(text).toContain('[h2] Ready to start your application?');
    expect(text).toContain('The check takes two minutes and costs nothing.');
    expect(text).not.toContain('A residence card proves your right to stay');
    await ex.dispose();
    await closePage(page);
  });

  it('never trims a block past the per-block cap', async () => {
    const page = await openPage();
    await page.goto(server.url('long-article.html'));
    const ex = await extract(page);
    for (const block of ex.state.meta.visibleText) {
      expect(block.text.length).toBeLessThanOrEqual(TEXT_BLOCK_CHARS + '[h9] '.length);
    }
    await ex.dispose();
    await closePage(page);
  });

  it('stops at the total cap when far more than that is on screen', async () => {
    const page = await openPage();
    await page.goto(server.url('wall-of-text.html'));
    const ex = await extract(page);

    const text = joined(ex.state.meta.visibleText);
    // 6,000 chars are on screen; the cap is 2,500, separators included.
    expect(text.length).toBeLessThanOrEqual(VISIBLE_TEXT_CHARS);
    expect(text.length).toBeGreaterThan(VISIBLE_TEXT_CHARS - 400);
    expect(ex.state.meta.visibleText.length).toBeLessThan(20);
    // The blocks it did keep are the ones at the top of the page, in document order.
    expect(text).toContain('P01 ');
    expect(text).not.toContain('P20 ');
    // Nothing was below the fold: the dropped text was on screen and simply not sent.
    expect(ex.state.meta.belowFoldTextChars).toBe(0);
    await ex.dispose();
    await closePage(page);
  });

  it('trims a long paragraph to the per-block cap', async () => {
    const page = await openPage();
    await page.goto(server.url('wall-of-text.html'));
    const ex = await extract(page);

    const long = ex.state.meta.visibleText.find((b) => b.text.startsWith('LONG01'))!;
    // The paragraph is 600 chars in the DOM and level 0, so the block is exactly the cap.
    expect(long.text.length).toBe(TEXT_BLOCK_CHARS);
    for (const block of ex.state.meta.visibleText) {
      expect(block.text.length).toBeLessThanOrEqual(TEXT_BLOCK_CHARS + '[h9] '.length);
    }
    await ex.dispose();
    await closePage(page);
  });

  it('leaves out copy that is in the DOM but not on the screen', async () => {
    const page = await openPage();
    await page.goto(server.url('hidden-text.html'));
    const ex = await extract(page);

    const text = joined(ex.state.meta.visibleText);
    expect(text).toContain('This paragraph is genuinely on screen');
    // sr-only clip rect, a left:-9999px paragraph, and a closed off-canvas drawer.
    expect(text).not.toContain('SRONLY');
    expect(text).not.toContain('OFFCANVAS');
    expect(text).not.toContain('DRAWERCOPY');
    // The button's own label, rendered inside its open shadow root, is its name and not copy.
    expect(ex.state.elements.some((e) => e.name === 'Start the check')).toBe(true);
    expect(text).not.toContain('SHADOWLABEL');
    await ex.dispose();
    await closePage(page);
  });

  it('reads text out of an open shadow root', async () => {
    const page = await openPage({ device: 'mobile', locale: 'uk-UA' });
    await page.goto(server.url('hero-price.html'));
    const ex = await extract(page);

    expect(joined(ex.state.meta.visibleText)).toContain('Оплата лише після позитивного рішення.');
    await ex.dispose();
    await closePage(page);
  });

  it('never groups the whole page into one body-sized block', async () => {
    const page = await openPage();
    await page.goto(server.url('long-article.html'));
    const ex = await extract(page);

    // The heading and the intro are separate blocks, not one lump of body text.
    expect(ex.state.meta.visibleText.length).toBeGreaterThan(1);
    await ex.dispose();
    await closePage(page);
  });
});

describeBrowser('per-option context', () => {
  it('carries the heading above the button and the price beside it', async () => {
    const page = await openPage({ device: 'mobile', locale: 'uk-UA' });
    await page.goto(server.url('hero-price.html'));
    const ex = await extract(page);

    const button = ex.state.elements.find((e) => e.name === 'Перевірте →')!;
    expect(button.inViewport).toBe(true);
    expect(button.context?.heading).toBe('Отримайте карту CUKR');
    expect(button.context?.near).toContain('249 zł');
    expect(button.context!.near!.length).toBeLessThanOrEqual(CONTEXT_NEAR_CHARS);
    await ex.dispose();
    await closePage(page);
  });

  it('gives no context to a below-fold option', async () => {
    const page = await openPage({ device: 'mobile', locale: 'uk-UA' });
    await page.goto(server.url('hero-price.html'));
    const ex = await extract(page);

    const terms = ex.state.elements.find((e) => e.name === 'Умови')!;
    expect(terms.inViewport).toBe(false);
    expect(terms.context).toBeUndefined();
    await ex.dispose();
    await closePage(page);
  });

  it('never uses the element name as its own near-text', async () => {
    const page = await openPage();
    await page.goto(server.url('long-article.html'));
    await page.evaluate(() => {
      document.getElementById('cta')!.scrollIntoView({ block: 'center' });
    });
    const ex = await extract(page);

    const cta = ex.state.elements.find((e) => e.name === 'Check my case')!;
    expect(cta.context?.near).not.toBe('Check my case');
    expect(cta.context?.near).toContain('two minutes');
    await ex.dispose();
    await closePage(page);
  });

  it('ignores a block below the fold even when it is well inside the 160 px radius', async () => {
    const page = await openPage({ device: 'mobile', locale: 'uk-UA' });
    await page.goto(server.url('hero-price.html'));
    await page.evaluate(() => {
      // Put the button 40 px above the fold, then a paragraph 140 px below its bottom edge:
      // inside the context radius, but off screen, so the persona has not read it.
      const button = document.getElementById('check')!;
      const rect = button.getBoundingClientRect();
      window.scrollTo(0, window.scrollY + rect.bottom - (window.innerHeight - 40));
      const note = document.createElement('p');
      note.textContent = 'ZNIZHKA fifty percent for the first hundred applicants';
      note.style.position = 'absolute';
      note.style.margin = '0';
      note.style.left = '0';
      note.style.top = `${window.scrollY + window.innerHeight + 100}px`;
      document.body.appendChild(note);
    });
    const ex = await extract(page);

    const button = ex.state.elements.find((e) => e.name === 'Перевірте →')!;
    expect(button.inViewport).toBe(true);
    for (const element of ex.state.elements) {
      expect(element.context?.near ?? '').not.toContain('ZNIZHKA');
      expect(element.context?.heading ?? '').not.toContain('ZNIZHKA');
    }
    expect(joined(ex.state.meta.visibleText)).not.toContain('ZNIZHKA');
    await ex.dispose();
    await closePage(page);
  });
});

describeBrowser('non-responsive pages', () => {
  it('flags a page with no viewport meta opened on a phone', async () => {
    const page = await openPage({ device: 'mobile' });
    await page.goto(server.url('long-article.html'));
    const ex = await extract(page);

    // Chromium lays a page with no viewport meta out at 980px and scales it down, so the
    // persona is looking at a desktop layout zoomed out on a 390px screen.
    expect(ex.state.meta.viewport.width).toBeGreaterThan(390);
    expect(ex.state.meta.nonResponsive).toBe(true);
    await ex.dispose();
    await closePage(page);
  });

  it('does not flag a page that carries the viewport meta', async () => {
    const page = await openPage({ device: 'mobile', locale: 'uk-UA' });
    await page.goto(server.url('hero-price.html'));
    const ex = await extract(page);

    expect(ex.state.meta.viewport.width).toBe(390);
    expect(ex.state.meta.nonResponsive).toBe(false);
    await ex.dispose();
    await closePage(page);
  });

  it('does not flag a desktop page', async () => {
    const page = await openPage();
    await page.goto(server.url('long-article.html'));
    const ex = await extract(page);

    expect(ex.state.meta.nonResponsive).toBe(false);
    await ex.dispose();
    await closePage(page);
  });

  it('keeps a live counter out of the state hash but still shows it to the model', async () => {
    const page = await openPage();
    await page.goto(server.url('live-counter.html'));

    const first = await extract(page);
    // Let the clock tick several times, so the live text is certainly different.
    await page.waitForFunction(
      (was: string) => document.getElementById('clock')!.textContent !== was,
      first.state.meta.visibleText.find((b) => b.inAriaLive)!.text,
    );
    const second = await extract(page);

    const live = (blocks: typeof first.state.meta.visibleText) =>
      blocks.find((b) => b.inAriaLive)!.text;
    expect(live(first.state.meta.visibleText)).not.toBe(live(second.state.meta.visibleText));
    // The persona still reads it; only the signature is spared.
    expect(joined(second.state.meta.visibleText)).toContain('Pozostało');
    expect(second.state.meta.visibleTextDigest).toBe(first.state.meta.visibleTextDigest);
    expect(second.state.stateHash).toBe(first.state.stateHash);

    // `aria-live="off"` is an explicit opt-out, so that block is ordinary copy.
    expect(
      first.state.meta.visibleText.find((b) => b.text.includes('Sekcja 1 z 3'))!.inAriaLive,
    ).toBe(false);

    await first.dispose();
    await second.dispose();
    await closePage(page);
  });
});
