import { describe, it, expect } from 'vitest';
import {
  BelievesDoneTracker,
  criteriaMet,
  criteriaConfigured,
  leftInExhaustion,
  resolveOutcome,
} from './goal';

describe('criteriaMet', () => {
  it('matches the success url regex', () => {
    expect(criteriaMet({ successUrl: /\/signup$/ }, 'https://dopomo.pl/pl/signup', '')).toBe(true);
    expect(criteriaMet({ successUrl: /\/signup$/ }, 'https://dopomo.pl/pl/cukr', '')).toBe(false);
  });

  it('matches the success text anywhere in the visible text', () => {
    expect(
      criteriaMet({ successText: 'Załóż konto' }, 'https://x.test/', 'Witaj. Załóż konto teraz.'),
    ).toBe(true);
    expect(criteriaMet({ successText: 'Załóż konto' }, 'https://x.test/', 'Witaj.')).toBe(false);
  });

  it('is satisfied by either criterion when both are configured', () => {
    const c = { successUrl: /signup/, successText: 'konto' };
    expect(criteriaMet(c, 'https://x.test/signup', 'nic')).toBe(true);
    expect(criteriaMet(c, 'https://x.test/cukr', 'konto')).toBe(true);
    expect(criteriaMet(c, 'https://x.test/cukr', 'nic')).toBe(false);
  });

  it('reports whether anything is configured, and never matches when nothing is', () => {
    expect(criteriaConfigured({})).toBe(false);
    expect(criteriaConfigured({ successText: 'x' })).toBe(true);
    expect(criteriaMet({}, 'https://x.test/anything', 'anything')).toBe(false);
  });
});

describe('BelievesDoneTracker', () => {
  it('fires only after two consecutive readings at or above 0.8', () => {
    const t = new BelievesDoneTracker();
    expect(t.push(0.9)).toBe(false);
    expect(t.push(0.85)).toBe(true);
    expect(t.fired).toBe(true);
  });

  it('resets the run when a reading drops below the threshold', () => {
    const t = new BelievesDoneTracker();
    expect(t.push(0.9)).toBe(false);
    expect(t.push(0.4)).toBe(false);
    expect(t.push(0.9)).toBe(false);
    expect(t.push(0.9)).toBe(true);
  });

  it('reports fired only once it has actually fired', () => {
    const t = new BelievesDoneTracker();
    t.push(0.9);
    expect(t.fired).toBe(false);
  });
});

describe('resolveOutcome', () => {
  const BASE = {
    criteria: { successUrl: /signup/ },
    criteriaMatched: false,
    believesDoneFired: false,
    gaveUp: false,
    left: false,
    lastGoalMet: 0.1,
    maxStepsReached: false,
    looped: false,
  };

  it('marks needMet and flags an unrecognized success when goalMet stayed low', () => {
    const r = resolveOutcome({ ...BASE, criteriaMatched: true, lastGoalMet: 0.2 });
    expect(r.needMet).toBe(true);
    expect(r.reason).toBe('criteria matched');
    expect(r.findings).toEqual(['unrecognized-success']);
  });

  it('marks needMet with no finding when the persona knew it had arrived', () => {
    const r = resolveOutcome({ ...BASE, criteriaMatched: true, lastGoalMet: 0.9 });
    expect(r.needMet).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('needs met with no finding when belief fires on the same step criteria match', () => {
    const r = resolveOutcome({
      ...BASE,
      criteriaMatched: true,
      believesDoneFired: true,
      lastGoalMet: 0.9,
    });
    expect(r).toEqual({ needMet: true, reason: 'criteria matched', findings: [] });
  });

  it('needs met with unrecognized-success when belief fires on a same-step low-goalMet criteria match', () => {
    const r = resolveOutcome({
      ...BASE,
      criteriaMatched: true,
      believesDoneFired: true,
      lastGoalMet: 0.4,
    });
    expect(r.needMet).toBe(true);
    expect(r.findings).toEqual(['unrecognized-success']);
  });

  it('treats belief without a criteria match as a false completion in the ux bucket', () => {
    const r = resolveOutcome({ ...BASE, believesDoneFired: true, lastGoalMet: 0.9 });
    expect(r.needMet).toBe(false);
    expect(r.bucketHint).toBe('ux');
    expect(r.findings).toEqual(['false-completion']);
  });

  it('is unverified when the persona believes it is done and nothing was configured', () => {
    const r = resolveOutcome({ ...BASE, criteria: {}, believesDoneFired: true, lastGoalMet: 0.9 });
    expect(r.needMet).toBeNull();
    expect(r.reason).toBe('unverified');
    expect(r.findings).toEqual([]);
  });

  it('reports give up, loops and the step budget', () => {
    expect(resolveOutcome({ ...BASE, gaveUp: true }).reason).toBe('gave up');
    expect(resolveOutcome({ ...BASE, looped: true }).reason).toBe('loop detected');
    expect(resolveOutcome({ ...BASE, maxStepsReached: true }).reason).toBe('step budget exhausted');
    expect(resolveOutcome({ ...BASE, maxStepsReached: true }).needMet).toBe(false);
  });
});

describe('leaving', () => {
  const base = {
    criteria: {},
    criteriaMatched: false,
    believesDoneFired: false,
    gaveUp: false,
    lastGoalMet: 0.1,
    maxStepsReached: false,
    looped: false,
  };

  it('resolves a leave as a bounce, not a give-up', () => {
    expect(resolveOutcome({ ...base, left: true })).toEqual({
      needMet: false,
      reason: 'left the site',
      bucketHint: 'bounce',
      findings: [],
    });
  });

  it('outranks a belief that fired on the same step, with no false-completion finding', () => {
    const r = resolveOutcome({
      ...base,
      criteria: { successUrl: /signup/ },
      left: true,
      believesDoneFired: true,
      lastGoalMet: 0.9,
    });
    expect(r).toEqual({
      needMet: false,
      reason: 'left the site',
      bucketHint: 'bounce',
      findings: [],
    });
  });

  it('still prefers matched criteria over a leave', () => {
    const r = resolveOutcome({ ...base, left: true, criteriaMatched: true, lastGoalMet: 0.9 });
    expect(r.needMet).toBe(true);
    expect(r.reason).toBe('criteria matched');
  });
});

describe('leftInExhaustion', () => {
  const base = { left: true, confusion: 1, noProgressSteps: 0, patience: 'medium' as const };

  it('is false when the persona did not leave at all', () => {
    expect(leftInExhaustion({ ...base, left: false, confusion: 5, noProgressSteps: 9 })).toBe(
      false,
    );
  });

  it('calls a leave taken at confusion three or more a give-up', () => {
    expect(leftInExhaustion({ ...base, confusion: 3 })).toBe(true);
    expect(leftInExhaustion({ ...base, confusion: 2 })).toBe(false);
  });

  it('calls a leave after a patience-length run of no progress a give-up', () => {
    expect(leftInExhaustion({ ...base, noProgressSteps: 4 })).toBe(true);
    expect(leftInExhaustion({ ...base, noProgressSteps: 3 })).toBe(false);
    expect(leftInExhaustion({ ...base, patience: 'low', noProgressSteps: 3 })).toBe(true);
    expect(leftInExhaustion({ ...base, patience: 'high', noProgressSteps: 4 })).toBe(false);
  });

  it('is a plain choice when the persona was neither confused nor stuck', () => {
    expect(leftInExhaustion(base)).toBe(false);
  });
});
