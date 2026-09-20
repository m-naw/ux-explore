import { describe, it, expect } from 'vitest';
import { normalizeUrl, toRelativeHref } from './url-normalize';

describe('normalizeUrl', () => {
  it('strips utm parameters and the trailing slash but keeps the hash', () => {
    expect(normalizeUrl('https://dopomo.pl/pl/cukr/?utm_source=x&page=2#form')).toBe(
      'https://dopomo.pl/pl/cukr?page=2#form',
    );
  });

  it('leaves a bare origin alone', () => {
    expect(normalizeUrl('https://dopomo.pl/')).toBe('https://dopomo.pl');
  });

  it('distinguishes the two loopback hostnames, which the fixture server relies on', () => {
    expect(normalizeUrl('http://127.0.0.1:8080/a')).not.toBe(
      normalizeUrl('http://localhost:8080/a'),
    );
  });
});

describe('toRelativeHref', () => {
  it('returns a relative path for same-origin links', () => {
    expect(
      toRelativeHref('https://dopomo.pl/pl/cukr?utm_medium=cpc&a=1', 'https://dopomo.pl/pl'),
    ).toBe('/pl/cukr?a=1');
  });

  it('returns the absolute url for cross-origin links', () => {
    expect(toRelativeHref('https://twitter.com/dopomo', 'https://dopomo.pl/pl')).toBe(
      'https://twitter.com/dopomo',
    );
  });
});
