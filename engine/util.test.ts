import { describe, it, expect } from 'vitest';
import { escapeRegExp, inViewport, l1Distance, mean, originOf, percentile } from './util';

describe('originOf', () => {
  it('keeps the port, because a different port is a different origin', () => {
    expect(originOf('http://127.0.0.1:5173/a?b=1')).toBe('http://127.0.0.1:5173');
    expect(originOf('https://example.com/a')).toBe('https://example.com');
  });

  it("reports 'null' for anything unparseable, the way a browser does", () => {
    expect(originOf('about:blank')).toBe('null');
    expect(originOf('')).toBe('null');
  });
});

describe('escapeRegExp', () => {
  it('makes a literal safe to embed in a pattern', () => {
    expect(new RegExp(escapeRegExp('a.b+c')).test('a.b+c')).toBe(true);
    expect(new RegExp(escapeRegExp('a.b+c')).test('axbbc')).toBe(false);
  });
});

describe('mean and l1Distance', () => {
  it('returns 0 for an empty list rather than NaN', () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 2, 6])).toBe(3);
  });

  it('treats a key missing from either distribution as zero', () => {
    expect(l1Distance({ a: 1 }, { a: 0.5, b: 0.5 })).toBeCloseTo(1);
    expect(l1Distance({}, {})).toBe(0);
  });
});

describe('percentile', () => {
  it('takes the nearest rank, so p50 of an even list is the lower middle', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('inViewport', () => {
  const viewport = { width: 390, height: 844 };

  it('accepts a rect showing any pixel on screen', () => {
    expect(inViewport({ top: 0, bottom: 40, left: 0, right: 390 }, viewport)).toBe(true);
    expect(inViewport({ top: -20, bottom: 10, left: 0, right: 390 }, viewport)).toBe(true);
  });

  it('rejects a closed off-canvas drawer as firmly as something below the fold', () => {
    expect(inViewport({ top: 0, bottom: 844, left: -390, right: 0 }, viewport)).toBe(false);
    expect(inViewport({ top: 900, bottom: 1000, left: 0, right: 390 }, viewport)).toBe(false);
    expect(inViewport({ top: 0, bottom: 844, left: 390, right: 780 }, viewport)).toBe(false);
  });
});
