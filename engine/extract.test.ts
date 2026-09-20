import { describe, it, expect } from 'vitest';
import {
  extractWithRetry,
  isNavigationRaceError,
  viewportSignature,
  textBlocksDigest,
} from './extract';
import type { Page } from 'playwright';
import type { Element as UxElement, PageState, TextBlock } from './types';

function el(partial: Partial<UxElement> & { id: string; name: string }): UxElement {
  return {
    role: 'link',
    href: '/x',
    hasValue: false,
    y: 10,
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

/** The control entries only: every signature ends with the visible-text digest. */
function controlsOf(state: PageState): string[] {
  return viewportSignature(state).slice(0, -1);
}

function state(elements: UxElement[], visibleText: TextBlock[] = []): PageState {
  // The real extractor digests every in-viewport block before the visibleText budget trims
  // the list; these fixtures are always under the budget, so the two sets are the same.

  return {
    elements,
    meta: {
      url: 'https://x.test/',
      title: '',
      lang: 'en',
      scrollY: 0,
      scrollMax: 0,
      viewport: { width: 1280, height: 720 },
      h1: '',
      mainText: '',
      validationMessages: [],
      langSwitcher: [],
      droppedElements: 0,
      belowFoldSample: [],
      visibleText,
      visibleTextDigest: textBlocksDigest(visibleText),
      belowFoldTextChars: 0,
      nonResponsive: false,
      disabledControls: [],
      skippedFrames: 0,
      closedRoots: 0,
    },
    stateHash: '',
    viewHash: '',
  };
}

describe('viewportSignature', () => {
  it('excludes out-of-viewport elements', () => {
    const sig = controlsOf(
      state([el({ id: 'a', name: 'Visible' }), el({ id: 'b', name: 'Hidden', inViewport: false })]),
    );
    expect(sig).toEqual(['link|Visible|/x|']);
  });

  it('excludes elements inside aria-live regions', () => {
    const sig = controlsOf(
      state([el({ id: 'a', name: 'Stable' }), el({ id: 'b', name: 'Ticker', inAriaLive: true })]),
    );
    expect(sig).toEqual(['link|Stable|/x|']);
  });

  it('excludes numeric-only names whether or not they have an href', () => {
    const sig = controlsOf(
      state([
        el({ id: 'a', name: 'Page 2' }),
        el({ id: 'b', name: '42' }),
        el({ id: 'c', name: '3.14', href: '/page/3' }),
      ]),
    );
    expect(sig).toEqual(['link|Page 2|/x|']);
  });

  it('appends a state token, so checking a radio and enabling a button both move the hash', () => {
    const radio = (checked: boolean) =>
      el({ id: 'a', name: 'Robota', role: 'radio', href: undefined, hasValue: checked });
    expect(controlsOf(state([radio(false)]))).toEqual(['radio|Robota||']);
    expect(controlsOf(state([radio(true)]))).toEqual(['radio|Robota||v']);

    const next = (disabled: boolean) =>
      el({ id: 'b', name: 'Dalej', role: 'button', href: undefined, disabled });
    expect(controlsOf(state([next(true)]))).toEqual(['button|Dalej||d']);
    expect(controlsOf(state([next(false)]))).toEqual(['button|Dalej||']);
  });

  it('carries the visible text, so two wizard steps with identical controls differ', () => {
    const controls = [el({ id: 'a', name: 'Tak', role: 'button', href: undefined })];
    const one = viewportSignature(
      state(controls, [{ text: 'Czy masz paszport?', landmark: 'main', inAriaLive: false }]),
    );
    const two = viewportSignature(
      state(controls, [{ text: 'Czy mieszkasz w Polsce?', landmark: 'main', inAriaLive: false }]),
    );
    expect(one.slice(0, -1)).toEqual(two.slice(0, -1));
    expect(one).not.toEqual(two);
  });

  it('ignores a numeric-only block, so a counter does not churn the hash every step', () => {
    const digest = (n: string) =>
      textBlocksDigest([
        { text: 'Koszyk', landmark: 'main', inAriaLive: false },
        { text: n, landmark: 'main', inAriaLive: false },
      ]);
    expect(digest('1')).toBe(digest('2'));
  });

  it('ignores a live-region block, so a ticker does not churn the hash every step', () => {
    const digest = (ticker: string) =>
      textBlocksDigest([
        { text: '[h1] Wniosek', landmark: 'main', inAriaLive: false },
        { text: ticker, landmark: 'main', inAriaLive: true },
      ]);
    expect(digest('Pozostało 5 minut')).toBe(digest('Pozostało 4 minuty'));
    // The page copy still counts: only the live block is exempt.
    expect(digest('x')).not.toBe(
      textBlocksDigest([
        { text: '[h2] Inny krok', landmark: 'main', inAriaLive: false },
        { text: 'x', landmark: 'main', inAriaLive: true },
      ]),
    );
  });

  it('is sorted, so element order never changes the hash', () => {
    const one = viewportSignature(state([el({ id: 'a', name: 'B' }), el({ id: 'b', name: 'A' })]));
    const two = viewportSignature(state([el({ id: 'b', name: 'A' }), el({ id: 'a', name: 'B' })]));
    expect(one).toEqual(two);
  });
});

describe('isNavigationRaceError', () => {
  it('recognises the page being replaced under a read', () => {
    expect(
      isNavigationRaceError(new Error('frame.evaluate: Execution context was destroyed')),
    ).toBe(true);
    expect(isNavigationRaceError(new Error('frame was detached'))).toBe(true);
  });

  it('treats a bare closed target as the same race', () => {
    expect(isNavigationRaceError(new Error('Target closed'))).toBe(true);
  });

  it('does not swallow an ordinary failure', () => {
    expect(isNavigationRaceError(new Error('Timeout 4000ms exceeded'))).toBe(false);
    expect(isNavigationRaceError(new Error('boom'))).toBe(false);
  });

  it('does not treat a closed page as a race worth retrying', () => {
    // Retrying a page that is gone would spend the whole step budget on extract-failed rows
    // instead of letting the failure surface.
    expect(
      isNavigationRaceError(new Error('Target page, context or browser has been closed')),
    ).toBe(false);
    expect(
      isNavigationRaceError(
        new Error('page.evaluate: Target page, context or browser has been closed'),
      ),
    ).toBe(false);
  });
});

/** A page whose every frame read loses its execution context. */
function racingPage(waits: string[]): Page {
  const frame = {
    evaluate: async (): Promise<never> => {
      throw new Error(
        'frame.evaluate: Execution context was destroyed, most likely because of a navigation',
      );
    },
  };
  return {
    mainFrame: () => frame,
    frames: () => [frame],
    url: () => 'https://x.test/',
    waitForLoadState: async (state: string) => {
      waits.push(state);
    },
  } as unknown as Page;
}

describe('extractWithRetry', () => {
  it('waits for the next document and gives up if that read is lost too', async () => {
    const waits: string[] = [];
    await expect(extractWithRetry(racingPage(waits))).rejects.toThrow(
      /Execution context was destroyed/,
    );
    // Exactly one wait: the caller reports the second failure rather than looping on it.
    expect(waits).toEqual(['domcontentloaded']);
  });

  it('rethrows an unrelated failure without waiting', async () => {
    const waits: string[] = [];
    const page = {
      mainFrame: () => ({
        evaluate: async (): Promise<never> => {
          throw new Error('Timeout 4000ms exceeded');
        },
      }),
      url: () => 'https://x.test/',
      waitForLoadState: async (state: string) => {
        waits.push(state);
      },
    } as unknown as Page;
    await expect(extractWithRetry(page)).rejects.toThrow(/Timeout 4000ms exceeded/);
    expect(waits).toEqual([]);
  });
});
