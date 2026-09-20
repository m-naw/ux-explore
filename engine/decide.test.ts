import { describe, it, expect } from 'vitest';
import {
  makeRng,
  entropyBits,
  argmaxOf,
  pruneDistribution,
  sampleFrom,
  toDecision,
  PROB_FLOOR,
} from './decide';
import type { RawDecision } from './types';

describe('makeRng', () => {
  it('is deterministic for a seed and different across seeds', () => {
    const a = makeRng(1);
    const b = makeRng(1);
    const c = makeRng(2);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect([c(), c(), c()]).not.toEqual(first);
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('separates the first draw of neighbouring seeds', () => {
    // Raw mulberry32 advances its state by a fixed constant before the first mix, so seeds
    // 1, 2 and 3 opened on 0.627 / 0.734 / 0.720. Three "independent" runs then took the same
    // first action, which is not three samples of anything. The seed is now finalised before
    // it is used, so neighbouring seeds start far apart.
    const firsts = [1, 2, 3].map((seed) => makeRng(seed)());
    for (let i = 0; i < firsts.length; i += 1) {
      for (let k = i + 1; k < firsts.length; k += 1) {
        expect(Math.abs(firsts[i]! - firsts[k]!)).toBeGreaterThan(0.15);
      }
    }
  });
});

describe('entropyBits', () => {
  it('is 0 for a certain distribution and log2(n) for a uniform one', () => {
    expect(entropyBits({ a: 1 })).toBe(0);
    expect(entropyBits({ a: 0.5, b: 0.5 })).toBeCloseTo(1, 10);
    expect(entropyBits({ a: 0.25, b: 0.25, c: 0.25, d: 0.25 })).toBeCloseTo(2, 10);
  });

  it('is lower than log2(n) for a skewed distribution', () => {
    const skewed = entropyBits({ a: 0.9, b: 0.06, c: 0.04 });
    expect(skewed).toBeCloseTo(
      0.9 * Math.log2(1 / 0.9) + 0.06 * Math.log2(1 / 0.06) + 0.04 * Math.log2(1 / 0.04),
      10,
    );
    expect(skewed).toBeLessThan(Math.log2(3));
  });
});

describe('argmaxOf', () => {
  it('breaks ties by ordinal id order, not locale collation', () => {
    expect(argmaxOf({ el_09: 0.4, el_02: 0.4, el_30: 0.2 })).toBe('el_02');
    expect(argmaxOf({ Z: 0.5, a: 0.5 })).toBe('Z'); // ordinal: 'Z' (0x5A) < 'a' (0x61)
  });
});

describe('pruneDistribution', () => {
  it('keeps options until cumulative mass reaches 0.9, drops sub-floor options, renormalizes', () => {
    const pruned = pruneDistribution({ a: 0.5, b: 0.3, c: 0.15, d: 0.04, e: 0.01 });
    expect(Object.keys(pruned).sort()).toEqual(['a', 'b', 'c']);
    expect(Object.values(pruned).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 10);
    expect(pruned['a']).toBeCloseTo(0.5 / 0.95, 10);
  });

  it('drops any option below the 0.03 floor even inside the top-p set', () => {
    expect(Object.keys(pruneDistribution({ a: 0.88, b: 0.02, c: 0.1 })).sort()).toEqual(['a', 'c']);
    expect(PROB_FLOOR).toBe(0.03);
  });

  it('always keeps at least the argmax', () => {
    const pruned = pruneDistribution({ a: 0.02, b: 0.01 });
    expect(Object.keys(pruned)).toEqual(['a']);
    expect(pruned['a']).toBe(1);
  });
});

describe('sampleFrom', () => {
  it('returns the option whose cumulative band contains the draw, on a skewed distribution', () => {
    const pruned = { a: 0.7, b: 0.2, c: 0.1 };
    expect(sampleFrom(pruned, () => 0.0)).toBe('a');
    expect(sampleFrom(pruned, () => 0.69)).toBe('a');
    expect(sampleFrom(pruned, () => 0.71)).toBe('b');
    expect(sampleFrom(pruned, () => 0.95)).toBe('c');
  });

  it('gives different picks for different seeds on the same distribution', () => {
    const pruned = { a: 0.34, b: 0.33, c: 0.33 };
    const picks = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => sampleFrom(pruned, makeRng(seed))),
    );
    expect(picks.size).toBeGreaterThan(1);
  });
});

describe('toDecision', () => {
  const raw: RawDecision = {
    distribution: { el_01: 0.55, el_02: 0.4, el_03: 0.05 },
    goalMet: 0.1,
    confusion: 1.2,
    latencyMs: 300,
    stateChars: 1200,
    inputTokens: 400,
    offeredOptions: [],
    stateText: 'state text',
  };

  it('fills pruned, argmax, confidence, entropy and the exploration flag', () => {
    const d = toDecision(raw, () => 0.0);
    expect(d.argmax).toBe('el_01');
    expect(d.confidence).toBeCloseTo(0.55, 10);
    expect(d.entropy).toBeCloseTo(entropyBits(raw.distribution), 10);
    expect(Object.keys(d.pruned).sort()).toEqual(['el_01', 'el_02']);
    expect(d.sampled).toBe('el_01');
    expect(d.exploration).toBe(false);
  });

  it('flags exploration when the draw lands off the argmax', () => {
    const d = toDecision(raw, () => 0.99);
    expect(d.sampled).toBe('el_02');
    expect(d.exploration).toBe(true);
  });

  it('is reproducible for a seed', () => {
    expect(toDecision(raw, makeRng(1)).sampled).toBe(toDecision(raw, makeRng(1)).sampled);
  });
});
