import { describe, it, expect } from 'vitest';
import { timer } from './timing';

describe('timer()', () => {
  it('returns a non-negative integer for elapsed ms after a short delay', async () => {
    const stop = timer();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const elapsed = stop();
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(50);
    expect(Number.isInteger(elapsed)).toBe(true);
  });

  it('returns increasing values on multiple calls to the same stop function', async () => {
    const stop = timer();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const first = stop();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = stop();
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('two independent timers do not interfere with each other', async () => {
    const stopA = timer();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stopB = timer();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const elapsedA = stopA();
    const elapsedB = stopB();
    // A started earlier so should have higher elapsed time
    expect(elapsedA).toBeGreaterThan(elapsedB);
  });

  it('returns 0 or close to 0 when called immediately', () => {
    const stop = timer();
    const elapsed = stop();
    // Should be very close to 0 (within a few ms)
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(10);
  });
});
