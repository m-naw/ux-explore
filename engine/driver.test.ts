import { describe, it, expect } from 'vitest';
import { browserLocaleFor, madeProgress, makeRunId, updateScrollBlocked } from './driver';
import type { PersonaProfile } from './types';

function persona(overrides: Partial<PersonaProfile>): PersonaProfile {
  return {
    name: 'X',
    description: 'd',
    languages: { native: 'uk', reads: { uk: 'fluent' } },
    device: 'desktop',
    techLiteracy: 'medium',
    domainLiteracy: 'medium',
    patience: 'medium',
    intent: 'high',
    facts: {},
    ...overrides,
  };
}

describe('browserLocaleFor', () => {
  it('derives the locale from the native language', () => {
    expect(browserLocaleFor(persona({ languages: { native: 'uk', reads: {} } }))).toBe('uk-UA');
    expect(browserLocaleFor(persona({ languages: { native: 'pl', reads: {} } }))).toBe('pl-PL');
    expect(browserLocaleFor(persona({ languages: { native: 'en', reads: {} } }))).toBe('en-GB');
    expect(browserLocaleFor(persona({ languages: { native: 'ru', reads: {} } }))).toBe('ru-RU');
    expect(browserLocaleFor(persona({ languages: { native: 'de', reads: {} } }))).toBe('en-GB');
  });

  it('prefers an explicit browserLocale', () => {
    expect(browserLocaleFor(persona({ browserLocale: 'pl-PL' }))).toBe('pl-PL');
  });
});

describe('makeRunId', () => {
  it('is a timestamp plus a short random suffix', () => {
    expect(makeRunId(new Date('2026-09-19T10:11:12.000Z'), () => 0.5)).toMatch(
      /^2026-09-19T10-11-12-[a-z0-9]{4}$/,
    );
  });

  it('gives different ids for different draws', () => {
    const at = new Date('2026-09-19T10:11:12.000Z');
    expect(makeRunId(at, () => 0.1)).not.toBe(makeRunId(at, () => 0.9));
  });
});

describe('madeProgress', () => {
  const typed = { newStateHash: false, kind: 'type' as const, failed: false, valueChanged: true };

  it('counts a new state hash whatever the action was', () => {
    expect(madeProgress({ ...typed, newStateHash: true, valueChanged: false })).toBe(true);
    expect(
      madeProgress({ newStateHash: true, kind: 'element', failed: false, valueChanged: false }),
    ).toBe(true);
  });

  it('counts a typed or selected value that actually changed', () => {
    // Filling a wizard in place produces no new state hash, and four filled fields in a
    // row must not read as a persona who is lost.
    expect(madeProgress(typed)).toBe(true);
    expect(madeProgress({ ...typed, kind: 'select' })).toBe(true);
  });

  it('does not count a typed step that changed nothing or failed', () => {
    expect(madeProgress({ ...typed, valueChanged: false })).toBe(false);
    expect(madeProgress({ ...typed, failed: true })).toBe(false);
  });

  it('does not count a click that left the state hash alone', () => {
    expect(
      madeProgress({ newStateHash: false, kind: 'element', failed: false, valueChanged: true }),
    ).toBe(false);
  });
});

describe('updateScrollBlocked', () => {
  it('blocks the direction whose scroll did not move the page', () => {
    expect(updateScrollBlocked({ down: false, up: false }, 'scroll_down', false)).toEqual({
      down: true,
      up: false,
    });
    expect(updateScrollBlocked({ down: false, up: false }, 'scroll_up', false)).toEqual({
      down: false,
      up: true,
    });
  });

  it('clears the opposite direction when a scroll moved the page', () => {
    // Scrolling up off the bottom makes room to scroll down again, and the reverse.
    expect(updateScrollBlocked({ down: true, up: false }, 'scroll_up', true)).toEqual({
      down: false,
      up: false,
    });
    expect(updateScrollBlocked({ down: false, up: true }, 'scroll_down', true)).toEqual({
      down: false,
      up: false,
    });
  });

  it('leaves the opposite direction blocked when the scroll did not move', () => {
    expect(updateScrollBlocked({ down: true, up: false }, 'scroll_up', false)).toEqual({
      down: true,
      up: true,
    });
  });

  it('clears both directions for any action that is not a scroll', () => {
    expect(updateScrollBlocked({ down: true, up: true }, 'element', false)).toEqual({
      down: false,
      up: false,
    });
    expect(updateScrollBlocked({ down: true, up: true }, 'back', false)).toEqual({
      down: false,
      up: false,
    });
  });
});
