import { describe, it, expect } from 'vitest';
import {
  classifyExecuteError,
  clickPhaseBudget,
  CLICK_PHASE_BUDGET_MS,
  DetachedHandleError,
} from './execute';
import { CLICK_TIMEOUT_MS } from './util';

describe('classifyExecuteError', () => {
  it('routes the Playwright pointer-events error to intercepted', () => {
    expect(
      classifyExecuteError(
        'locator.click: Timeout 4000ms exceeded.\n<div class="cookie-veil"> intercepts pointer events',
      ),
    ).toBe('intercepted');
  });

  it('routes the phrase even when the interceptor is printed as a closed tag', () => {
    // A real Playwright 1.59 message. It also says "Timeout 4000ms exceeded", so interception must win.
    const message = [
      'elementHandle.click: Timeout 4000ms exceeded.',
      'Call log:',
      '  - attempting click action',
      '    - <div id="veil"></div> intercepts pointer events',
    ].join('\n');
    expect(classifyExecuteError(message)).toBe('intercepted');
  });

  it("classifies the engine's own detached-handle error by type, not by its wording", () => {
    expect(classifyExecuteError(new DetachedHandleError())).toBe('detached');
    expect(classifyExecuteError(new DetachedHandleError('anything at all'))).toBe('detached');
  });

  it('recognises a detached handle Playwright reported, plus timeouts and navigation aborts', () => {
    expect(classifyExecuteError('Element is not attached to the DOM')).toBe('detached');
    expect(classifyExecuteError('elementHandle.click: Timeout 4000ms exceeded.')).toBe('timeout');
    expect(
      classifyExecuteError('Execution context was destroyed, most likely because of a navigation'),
    ).toBe('navigation');
    expect(classifyExecuteError('something else entirely')).toBe('unknown');
  });
});

describe('clickPhaseBudget', () => {
  const at = (times: number[]) => {
    let i = 0;
    return () => times[Math.min(i++, times.length - 1)]!;
  };

  it('gives the first attempt a full click timeout and starts the clock there', () => {
    const next = clickPhaseBudget(at([1000, 1000]));
    expect(next()).toBe(CLICK_TIMEOUT_MS);
  });

  it('shrinks later attempts to what is left of the phase budget', () => {
    const next = clickPhaseBudget(at([0, 9_500, 11_000]));
    expect(next()).toBe(CLICK_TIMEOUT_MS);
    // 2,500ms left of the 12s phase: less than one click timeout, so the attempt is trimmed.
    expect(next()).toBe(CLICK_PHASE_BUDGET_MS - 9_500);
    expect(next()).toBe(CLICK_PHASE_BUDGET_MS - 11_000);
  });

  it('never returns zero, because Playwright reads a zero timeout as no timeout at all', () => {
    const exhausted = clickPhaseBudget(at([0, CLICK_PHASE_BUDGET_MS]));
    exhausted();
    expect(() => exhausted()).toThrow(DetachedHandleError);

    const overrun = clickPhaseBudget(at([0, CLICK_PHASE_BUDGET_MS + 5_000]));
    overrun();
    expect(() => overrun()).toThrow(DetachedHandleError);
  });

  it('keeps every attempt positive and capped for a phase that runs its full length', () => {
    const now = at([0, 100, 4_200, 8_300, 11_999]);
    const next = clickPhaseBudget(now);
    const handed = [next(), next(), next(), next(), next()];
    for (const timeout of handed) {
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThanOrEqual(CLICK_TIMEOUT_MS);
    }
  });
});
