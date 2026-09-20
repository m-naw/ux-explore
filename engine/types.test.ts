import { describe, it, expect } from 'vitest';
import { ALL_BUCKETS, ALL_FLAGS, isBucket, isFlag, FACT_KEYS } from './types';

describe('engine/types', () => {
  it('lists every bucket, bounce included', () => {
    expect([...ALL_BUCKETS]).toEqual([
      'tool',
      'stale',
      'product',
      'ux',
      'persona',
      'bounce',
      'none',
    ]);
  });

  it('lists every flag, including the lost flag the journey bucket needs', () => {
    expect([...ALL_FLAGS]).toEqual([
      'high-entropy',
      'low-confidence',
      'confused',
      'failed-action',
      'no-change',
      'validation-error',
      'backtrack',
      'overlay-blocked',
      'overlay-undismissed',
      'unlabeled-control',
      'missing-fact',
      'lost',
      'bounce-on-entry',
      'left',
      'non-responsive',
      'late-transition',
    ]);
  });

  it('lists every persona fact key', () => {
    expect([...FACT_KEYS]).toEqual([
      'givenName',
      'familyName',
      'email',
      'phone',
      'nationality',
      'birthDate',
      'city',
      'employer',
      'arrivalDate',
      'pesel',
    ]);
  });

  it('guards reject unknown values', () => {
    expect(isBucket('ux')).toBe(true);
    expect(isBucket('weird')).toBe(false);
    expect(isBucket('bounce')).toBe(true);
    expect(isFlag('lost')).toBe(true);
    expect(isFlag('misleading-confirmation')).toBe(false);
    expect(isFlag('bounce-on-entry')).toBe(true);
  });
});
