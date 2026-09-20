import { describe, it, expect } from 'vitest';
import { jaccardDistance, hasStateChanged } from './state-diff';
import type { Element as UxElement, PageState } from './types';

function el(name: string): UxElement {
  return {
    id: `el_${name}`,
    role: 'link',
    name,
    href: `/${name}`,
    hasValue: false,
    y: 10,
    inViewport: true,
    landmark: 'main',
    sticky: false,
    inAriaLive: false,
    overlay: false,
    dismissesOverlay: false,
    unnamed: false,
    disabled: false,
    match: { autocomplete: '', name: '', id: '', label: '', placeholder: '', required: false },
  };
}

function state(url: string, names: string[]): PageState {
  return {
    elements: names.map(el),
    meta: {
      url,
      title: 't',
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
      visibleText: [],
      visibleTextDigest: '',
      belowFoldTextChars: 0,
      nonResponsive: false,
      disabledControls: [],
      skippedFrames: 0,
      closedRoots: 0,
    },
    stateHash: names.join(','),
    viewHash: names.join(','),
  };
}

describe('jaccardDistance', () => {
  it('is 0 for identical sets, 1 for disjoint sets, 0 for two empty sets', () => {
    expect(jaccardDistance(['a', 'b'], ['b', 'a'])).toBe(0);
    expect(jaccardDistance(['a'], ['b'])).toBe(1);
    expect(jaccardDistance([], [])).toBe(0);
  });
});

describe('hasStateChanged', () => {
  it('is false when the same page barely moves', () => {
    const names = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    expect(
      hasStateChanged(state('https://x.test/a', names), state('https://x.test/a', names)),
    ).toBe(false);
  });

  it('is true when more than 10 percent of the viewport content differs', () => {
    expect(
      hasStateChanged(
        state('https://x.test/a', ['one', 'two', 'three']),
        state('https://x.test/a', ['one', 'two', 'nine']),
      ),
    ).toBe(true);
  });

  it('is true when only the url changed', () => {
    expect(
      hasStateChanged(state('https://x.test/a', ['one']), state('https://x.test/b', ['one'])),
    ).toBe(true);
  });

  it('ignores utm noise on the url', () => {
    expect(
      hasStateChanged(
        state('https://x.test/a', ['one']),
        state('https://x.test/a?utm_source=x', ['one']),
      ),
    ).toBe(false);
  });
});
