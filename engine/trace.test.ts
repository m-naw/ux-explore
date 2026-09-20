import { describe, it, expect } from 'vitest';
import { computeFlags, aggregatePerUrl, computeMetrics } from './trace';
import type { Journey, Outcome, Option, TraceRow } from './types';

const OK: Outcome = {
  urlChanged: true,
  stateChanged: true,
  consoleErrors: [],
  failedRequests: [],
  validationMessages: [],
  durationMs: 120,
};

const CLICK: Option = {
  id: 'el_01',
  kind: 'element',
  description: 'button "Dalej" (visible)',
  elementId: 'el_01',
};

const BASE = {
  firstRow: true,
  optionCount: 8,
  entropy: 1.0,
  confidence: 0.8,
  confusion: 1,
  outcome: OK,
  sampledOption: CLICK,
  sampledRole: 'button',
  sampledInputType: undefined as string | undefined,
  sampledUnnamed: false,
  overlayBlocked: false,
  stateHash: 'h5',
  recentStateHashes: ['h1', 'h2', 'h3', 'h4'],
  wasSubmit: false,
  missingFact: false,
  madeProgress: true,
  noProgressSteps: 0,
  device: 'desktop' as 'desktop' | 'mobile',
  nonResponsive: false,
  lateTransition: false,
};

describe('computeFlags', () => {
  it('flags high entropy only above 2.0 bits with more than 5 options', () => {
    expect(computeFlags({ ...BASE, entropy: 2.1, optionCount: 6 })).toContain('high-entropy');
    expect(computeFlags({ ...BASE, entropy: 2.1, optionCount: 5 })).not.toContain('high-entropy');
    expect(computeFlags({ ...BASE, entropy: 2.0, optionCount: 9 })).not.toContain('high-entropy');
  });

  it('flags low confidence, confusion and failed actions', () => {
    expect(computeFlags({ ...BASE, confidence: 0.49 })).toContain('low-confidence');
    expect(computeFlags({ ...BASE, confidence: 0.5 })).not.toContain('low-confidence');
    expect(computeFlags({ ...BASE, confusion: 3 })).toContain('confused');
    expect(
      computeFlags({ ...BASE, outcome: { ...OK, error: 'boom', errorClass: 'timeout' } }),
    ).toContain('failed-action');
  });

  it('flags no-change only for links, buttons and submits', () => {
    const inert = { ...OK, urlChanged: false, stateChanged: false };
    expect(computeFlags({ ...BASE, outcome: inert, sampledRole: 'button' })).toContain('no-change');
    expect(computeFlags({ ...BASE, outcome: inert, sampledRole: 'link' })).toContain('no-change');
    expect(
      computeFlags({ ...BASE, outcome: inert, sampledRole: 'textbox', sampledInputType: 'submit' }),
    ).toContain('no-change');
    expect(computeFlags({ ...BASE, outcome: inert, sampledRole: 'tab' })).not.toContain(
      'no-change',
    );
    expect(computeFlags({ ...BASE, outcome: inert, sampledRole: 'checkbox' })).not.toContain(
      'no-change',
    );
    expect(
      computeFlags({
        ...BASE,
        outcome: inert,
        sampledOption: { id: 'scroll_down', kind: 'scroll_down', description: 's' },
      }),
    ).not.toContain('no-change');
  });

  it('does not call a rejected submit a no-change', () => {
    const rejected = {
      ...OK,
      urlChanged: false,
      stateChanged: false,
      validationMessages: ['Pole jest wymagane'],
    };
    const flags = computeFlags({ ...BASE, outcome: rejected, wasSubmit: true });
    expect(flags).not.toContain('no-change');
    expect(flags).toContain('validation-error');
  });

  it('flags validation errors only after a submit', () => {
    const withMessages = { ...OK, validationMessages: ['Pole jest wymagane'] };
    expect(computeFlags({ ...BASE, outcome: withMessages, wasSubmit: true })).toContain(
      'validation-error',
    );
    expect(computeFlags({ ...BASE, outcome: withMessages, wasSubmit: false })).not.toContain(
      'validation-error',
    );
  });

  it('flags backtracks inside the previous four steps only', () => {
    expect(computeFlags({ ...BASE, stateHash: 'h2' })).toContain('backtrack');
    expect(
      computeFlags({ ...BASE, stateHash: 'h0', recentStateHashes: ['h0', 'h1', 'h2', 'h3', 'h4'] }),
    ).not.toContain('backtrack');
  });

  it('does not call staying on the same page a backtrack', () => {
    // Filling a form in place leaves the stateHash alone step after step, and repeating the
    // immediately preceding state is standing still, not going back.
    expect(computeFlags({ ...BASE, stateHash: 'h4' })).not.toContain('backtrack');
    // Two steps back is a return, and that still counts.
    expect(computeFlags({ ...BASE, stateHash: 'h3' })).toContain('backtrack');
  });

  it('flags a step whose page moved only after every handle had gone', () => {
    expect(computeFlags({ ...BASE, lateTransition: true })).toContain('late-transition');
    expect(computeFlags(BASE)).not.toContain('late-transition');
  });

  it('flags overlay-blocked, unlabeled-control and missing-fact', () => {
    expect(
      computeFlags({ ...BASE, overlayBlocked: true, overlayDismissMethod: 'control' }),
    ).toContain('overlay-blocked');
    expect(computeFlags({ ...BASE, sampledUnnamed: true })).toContain('unlabeled-control');
    expect(computeFlags({ ...BASE, missingFact: true })).toContain('missing-fact');
  });

  it('separates an overlay a dismiss control could not clear from one only Escape was tried on', () => {
    // Escape closes nothing on most consent banners, so a surviving overlay after Escape is
    // the harness failing to dismiss, not the site trapping the persona.
    const clicked = computeFlags({
      ...BASE,
      overlayBlocked: true,
      overlayDismissMethod: 'control',
    });
    expect(clicked).toContain('overlay-blocked');
    expect(clicked).not.toContain('overlay-undismissed');

    for (const method of ['escape', 'none'] as const) {
      const fallback = computeFlags({
        ...BASE,
        overlayBlocked: true,
        overlayDismissMethod: method,
      });
      expect(fallback).toContain('overlay-undismissed');
      expect(fallback).not.toContain('overlay-blocked');
    }
  });

  it('flags lost only when confidence is high, nothing else fired and progress stalled for four steps', () => {
    expect(computeFlags({ ...BASE, confidence: 0.7, noProgressSteps: 4 })).toEqual(['lost']);
    expect(computeFlags({ ...BASE, confidence: 0.69, noProgressSteps: 4 })).not.toContain('lost');
    expect(computeFlags({ ...BASE, confidence: 0.9, noProgressSteps: 3 })).not.toContain('lost');
    expect(
      computeFlags({ ...BASE, confidence: 0.9, noProgressSteps: 4, confusion: 3 }),
    ).not.toContain('lost');
  });
});

function row(overrides: Partial<TraceRow>): TraceRow {
  return {
    step: 1,
    timestamp: 0,
    url: 'https://dopomo.pl/pl',
    stateHash: 'h1',
    viewHash: 'v1',
    viewport: { width: 1280, height: 720 },
    elementsCount: 10,
    droppedElements: 0,
    options: [CLICK],
    distribution: { el_01: 1 },
    pruned: { el_01: 1 },
    sampled: 'el_01',
    sampledName: 'Dalej',
    argmax: 'el_01',
    exploration: false,
    confidence: 1,
    entropy: 0,
    goalMet: 0,
    confusion: 0,
    outcome: OK,
    timing: { extractMs: 10, decideMs: 300, decideRetryMs: 0, executeMs: 100, settleMs: 200 },
    flags: [],
    bucket: 'none',
    stateChars: 1000,
    inputTokens: 400,
    visibleTextChars: 0,
    seenTextChars: 0,
    scrollOnly: false,
    ...overrides,
  };
}

function journey(
  rows: TraceRow[],
  name: string,
  seed: number,
  needMet: boolean | null = true,
): Journey {
  return {
    summary: {
      runId: `${name}-${seed}`,
      persona: { name },
      browserLocale: 'pl-PL',
      device: 'desktop',
      seed,
      outcome: {
        needMet,
        gaveUp: false,
        left: false,
        believedDone: false,
        reason: 'criteria matched',
        bucket: 'none',
        totalSteps: rows.length,
        totalDurationMs: 1000,
        outcomeFindings: [],
      },
      perUrl: [],
    },
    rows,
    toolIssues: [],
  };
}

describe('aggregatePerUrl', () => {
  it('counts visits, exits and backtracks per normalized url and ignores scroll-only rows', () => {
    const j = journey(
      [
        row({ step: 1, url: 'https://dopomo.pl/pl/?utm_source=x', entropy: 1, confusion: 1 }),
        row({
          step: 2,
          url: 'https://dopomo.pl/pl',
          scrollOnly: true,
          sampled: 'scroll_down',
          sampledName: 'scroll_down',
        }),
        row({
          step: 3,
          url: 'https://dopomo.pl/pl/cukr',
          entropy: 3,
          confusion: 2,
          flags: ['backtrack'],
        }),
      ],
      'Anna',
      1,
    );
    const perUrl = aggregatePerUrl([j]);
    const landing = perUrl.find((r) => r.url === 'https://dopomo.pl/pl')!;
    expect(landing.visits).toBe(1);
    expect(landing.meanEntropy).toBeCloseTo(1, 10);
    const cukr = perUrl.find((r) => r.url === 'https://dopomo.pl/pl/cukr')!;
    expect(cukr.exits).toBe(1);
    expect(cukr.backtracks).toBe(1);
    expect(cukr.topSampled[0]).toEqual({ name: 'Dalej', meanProbability: 1 });
  });
});

describe('computeMetrics', () => {
  it('returns a null divergence ratio for a single journey, because there is nothing to compare', () => {
    const metrics = computeMetrics([journey([row({})], 'Anna', 1)]);
    expect(metrics.divergenceRatio).toBeNull();
    expect(metrics.ordinalCheck).toBeUndefined();
  });

  it('divides cross-persona divergence by same-persona seed-repeat divergence over a run set', () => {
    const shared = 'shared-hash';
    const metrics = computeMetrics([
      journey([row({ stateHash: shared, distribution: { a: 1, b: 0 } })], 'Anna', 1),
      journey([row({ stateHash: shared, distribution: { a: 0.9, b: 0.1 } })], 'Anna', 2),
      journey([row({ stateHash: shared, distribution: { a: 0, b: 1 } })], 'Olena', 1),
    ]);
    expect(metrics.divergenceRatio).toBeGreaterThan(5);
  });

  it('reports the exploration rate and completion rates as fractions', () => {
    const metrics = computeMetrics([
      journey([row({ exploration: true })], 'Anna', 1, true),
      journey([row({ exploration: true })], 'Anna', 2, false),
      journey([row({ exploration: false })], 'Olena', 1, false),
    ]);
    expect(metrics.explorationRate).toBeCloseTo(2 / 3, 10);
    expect(metrics.completionRateByExploration.explored).toBeCloseTo(0.5, 10);
    expect(metrics.completionRateByExploration.exploited).toBe(0);
  });

  it('reports a broken ordinal check without throwing', () => {
    const metrics = computeMetrics(
      [journey([row({}), row({ step: 2 })], 'Anna', 1), journey([row({})], 'Olena', 1)],
      ['Anna', 'Olena'],
    );
    expect(metrics.ordinalCheck).toEqual({
      expected: ['Anna', 'Olena'],
      actual: ['Olena', 'Anna'],
      ordered: false,
    });
  });

  it('measures the real chars-per-token ratio', () => {
    expect(
      computeMetrics([journey([row({ stateChars: 1200, inputTokens: 400 })], 'Anna', 1)])
        .charsPerToken,
    ).toBeCloseTo(3, 10);
  });
});

describe('bounce-on-entry', () => {
  const LEAVE: Option = { id: 'leave', kind: 'leave', description: 'leave this site' };

  it('flags a leave on step 1', () => {
    expect(computeFlags({ ...BASE, sampledOption: LEAVE, confusion: 0 })).toContain(
      'bounce-on-entry',
    );
  });

  it('does not flag a leave on a later row', () => {
    expect(
      computeFlags({ ...BASE, firstRow: false, sampledOption: LEAVE, confusion: 0 }),
    ).not.toContain('bounce-on-entry');
  });

  it('does not flag an ordinary first row', () => {
    expect(computeFlags({ ...BASE })).not.toContain('bounce-on-entry');
  });

  it('flags every leave row as left, first or not, so the report can see it', () => {
    expect(computeFlags({ ...BASE, sampledOption: LEAVE, confusion: 0 })).toContain('left');
    expect(
      computeFlags({ ...BASE, firstRow: false, sampledOption: LEAVE, confusion: 0 }),
    ).toContain('left');
    expect(computeFlags({ ...BASE })).not.toContain('left');
  });

  it('adds confused when the persona left while confused', () => {
    const flags = computeFlags({ ...BASE, sampledOption: LEAVE, confusion: 3 });
    expect(flags).toContain('confused');
    expect(flags).toContain('bounce-on-entry');
  });
});

describe('leave rates', () => {
  it('reports the share of journeys that left on each URL', () => {
    const a = journey([row({ url: 'https://dopomo.pl/lp' })], 'Oksana', 1);
    a.summary.outcome.left = true;
    const b = journey([row({ url: 'https://dopomo.pl/lp' })], 'Olena', 1);
    b.summary.outcome.left = false;

    const perUrl = aggregatePerUrl([a, b]);
    expect(perUrl[0]!.exits).toBe(2);
    expect(perUrl[0]!.leaveRate).toBe(0.5);
  });

  it('reports the leave rate per persona', () => {
    const a = journey([row({})], 'Oksana', 1);
    a.summary.outcome.left = true;
    const b = journey([row({})], 'Oksana', 2);
    b.summary.outcome.left = false;
    const c = journey([row({})], 'Olena', 1);
    c.summary.outcome.left = false;

    expect(computeMetrics([a, b, c]).leaveRateByPersona).toEqual({ Oksana: 0.5, Olena: 0 });
  });
});

describe('non-responsive', () => {
  it('flags a desktop layout the phone persona has to read zoomed out', () => {
    expect(computeFlags({ ...BASE, device: 'mobile', nonResponsive: true })).toContain(
      'non-responsive',
    );
  });

  it('does not flag a page that fits the phone', () => {
    expect(computeFlags({ ...BASE, device: 'mobile', nonResponsive: false })).not.toContain(
      'non-responsive',
    );
  });

  it('does not flag a desktop persona, who has the width for it anyway', () => {
    expect(computeFlags({ ...BASE, device: 'desktop', nonResponsive: true })).not.toContain(
      'non-responsive',
    );
  });
});
