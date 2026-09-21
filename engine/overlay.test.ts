import { describe, it, expect } from 'vitest';
import {
  CONSENT_KEYWORDS,
  DISMISS_KEYWORDS,
  isConsentText,
  isDismissName,
  isOverlayOccluder,
  overlayDismissPlan,
} from './overlay';

describe('isDismissName', () => {
  it('matches dismiss stems at a word start, in every spec language', () => {
    expect(isDismissName('ЗАКРИТИ')).toBe(true);
    expect(isDismissName('Понятно')).toBe(true);
    expect(isDismissName('Got it, thanks')).toBe(true);
    expect(isDismissName('OK')).toBe(true);
    expect(isDismissName('Close')).toBe(true);
    expect(isDismissName('Dismiss')).toBe(true);
    expect(isDismissName('Skip')).toBe(true);
    expect(isDismissName('×')).toBe(true);
  });

  it('does not treat accept or agree as a dismiss control', () => {
    expect(isDismissName('Accept all')).toBe(false);
    expect(isDismissName('I agree')).toBe(false);
    expect(isDismissName('Akceptuję wszystkie')).toBe(false);
    expect(isDismissName('Zgadzam się')).toBe(false);
    expect(isDismissName('Прийняти всі')).toBe(false);
    expect(isDismissName('Согласен')).toBe(false);
    expect(isConsentText('Accept all')).toBe(true);
    expect(isConsentText('Akceptuję wszystkie')).toBe(true);
  });

  it('does not match a stem buried inside another word', () => {
    expect(isDismissName('Polityka cookie')).toBe(false);
    expect(isDismissName('Cookie settings')).toBe(false);
    expect(isDismissName('Karta CUKR')).toBe(false);
    expect(isDismissName('Choose plan')).toBe(false);
  });

  it('carries close/dismiss/skip and not consent choices', () => {
    expect(DISMISS_KEYWORDS).toContain('close');
    expect(DISMISS_KEYWORDS).toContain('dismiss');
    expect(DISMISS_KEYWORDS).toContain('skip');
    expect(DISMISS_KEYWORDS).not.toContain('accept');
    expect(DISMISS_KEYWORDS).not.toContain('agree');
    expect(DISMISS_KEYWORDS).not.toContain('zgadzam');
    expect(CONSENT_KEYWORDS).toContain('akceptuj');
    expect(CONSENT_KEYWORDS).toContain('прийняти');
    expect(CONSENT_KEYWORDS).toContain('согласен');
    expect(DISMISS_KEYWORDS.length).toBe(12);
    expect(CONSENT_KEYWORDS.length).toBe(8);
  });
});

describe('overlayDismissPlan', () => {
  const el = (overlay: boolean, dismissesOverlay: boolean) => ({ overlay, dismissesOverlay });

  it('clicks a plain close control when one is present', () => {
    expect(overlayDismissPlan([el(true, false), el(true, true)])).toBe('control');
  });

  it('defers when the overlay only offers consent choices', () => {
    expect(overlayDismissPlan([el(true, false), el(true, false)])).toBe('defer');
  });

  it('falls back to Escape when the occluder has no controls', () => {
    expect(overlayDismissPlan([el(false, false)])).toBe('escape');
  });
});

describe('isOverlayOccluder', () => {
  const top = { width: 1280, height: 720 };
  const main = { x: 0, y: 0 };

  it('judges area against the top-level viewport, not the frame that measured the rect', () => {
    // A banner filling a 300x250 iframe: 100% of that frame, 8% of the page.
    const rect = { left: 0, top: 0, right: 300, bottom: 250 };
    expect(
      isOverlayOccluder({
        rect,
        frameOffset: { x: 40, y: 120 },
        topViewport: top,
        text: 'Site notice',
      }),
    ).toBe(false);
    // The same box measured by the main frame is still only 8% of the page.
    expect(
      isOverlayOccluder({ rect, frameOffset: main, topViewport: top, text: 'Site notice' }),
    ).toBe(false);
  });

  it('calls a veil covering most of the page an overlay', () => {
    expect(
      isOverlayOccluder({
        rect: { left: 0, top: 0, right: 1280, bottom: 720 },
        frameOffset: main,
        topViewport: top,
        text: '',
      }),
    ).toBe(true);
  });

  it('counts only the part of the box that is on screen', () => {
    // 500x88 pinned bar, all but 100px of it off the left edge: far too small on either count.
    expect(
      isOverlayOccluder({
        rect: { left: -400, top: 632, right: 100, bottom: 720 },
        frameOffset: main,
        topViewport: top,
        text: 'We use cookies.',
      }),
    ).toBe(false);
  });

  it('calls a small bar an overlay when it carries a dismiss keyword', () => {
    const rect = { left: 0, top: 632, right: 1280, bottom: 720 };
    expect(
      isOverlayOccluder({
        rect,
        frameOffset: main,
        topViewport: top,
        text: 'We use cookies. Got it',
      }),
    ).toBe(true);
    expect(
      isOverlayOccluder({
        rect,
        frameOffset: main,
        topViewport: top,
        text: 'We use cookies. Accept all',
      }),
    ).toBe(true);
    // The same bar without one is a sticky footer to scroll clear of.
    expect(
      isOverlayOccluder({ rect, frameOffset: main, topViewport: top, text: 'Site notice' }),
    ).toBe(false);
  });
});
