import { describe, it, expect } from 'vitest';
import { bucketStep, journeyBucket } from './attribution';
import type { Flag, Outcome, TraceRow } from './types';

const CLEAN: Outcome = {
  urlChanged: true,
  stateChanged: true,
  consoleErrors: [],
  failedRequests: [],
  validationMessages: [],
  durationMs: 50,
};

const BASE = {
  flags: [] as Flag[],
  outcome: CLEAN,
  stale: false,
  falseCompletion: false,
  href404: false,
};

describe('bucketStep', () => {
  it('puts tool failures first', () => {
    for (const failure of [
      'jev-failure',
      'zero-elements',
      'state-too-large',
      'playwright-timeout',
    ] as const) {
      expect(bucketStep({ ...BASE, toolFailure: failure })).toBe('tool');
    }
  });

  it('puts an overlay the harness never dismissed in tool, not ux', () => {
    expect(bucketStep({ ...BASE, flags: ['overlay-undismissed'] })).toBe('tool');
  });

  it('puts a twice-detached handle in stale', () => {
    expect(bucketStep({ ...BASE, stale: true })).toBe('stale');
  });

  it('attributes a missing fact to the persona even when validation also fired', () => {
    expect(bucketStep({ ...BASE, flags: ['missing-fact', 'validation-error'] })).toBe('persona');
  });

  it('puts console errors, failed requests, no-change and 404 targets in product', () => {
    expect(bucketStep({ ...BASE, outcome: { ...CLEAN, consoleErrors: ['boom'] } })).toBe('product');
    expect(bucketStep({ ...BASE, outcome: { ...CLEAN, failedRequests: ['/x (404)'] } })).toBe(
      'product',
    );
    expect(bucketStep({ ...BASE, flags: ['no-change'] })).toBe('product');
    expect(bucketStep({ ...BASE, href404: true })).toBe('product');
  });

  it('puts the spec ux flags in ux', () => {
    for (const flag of [
      'high-entropy',
      'confused',
      'backtrack',
      'overlay-blocked',
      'validation-error',
      'unlabeled-control',
      'non-responsive',
    ] as Flag[]) {
      expect(bucketStep({ ...BASE, flags: [flag] })).toBe('ux');
    }
    expect(bucketStep({ ...BASE, falseCompletion: true })).toBe('ux');
  });

  it('leaves the bucket alone for a left step: a bounce is a journey verdict, not a step one', () => {
    expect(bucketStep({ ...BASE, flags: ['left'] })).toBe('none');
    expect(bucketStep({ ...BASE, flags: ['left', 'bounce-on-entry'] })).toBe('none');
  });

  it('puts a lost persona in persona', () => {
    expect(bucketStep({ ...BASE, flags: ['lost'] })).toBe('persona');
  });

  it('is none when nothing fired', () => {
    expect(bucketStep(BASE)).toBe('none');
  });
});

function flaggedRow(
  bucket: TraceRow['bucket'],
  step: number,
  flags: Flag[] = ['no-change'],
): TraceRow {
  return {
    step,
    timestamp: 0,
    url: 'https://x.test/',
    stateHash: `h${step}`,
    viewHash: `v${step}`,
    viewport: { width: 1280, height: 720 },
    elementsCount: 4,
    droppedElements: 0,
    options: [],
    distribution: {},
    pruned: {},
    sampled: 'el_01',
    sampledName: 'x',
    argmax: 'el_01',
    exploration: false,
    confidence: 1,
    entropy: 0,
    goalMet: 0,
    confusion: 0,
    outcome: CLEAN,
    timing: { extractMs: 1, decideMs: 1, decideRetryMs: 0, executeMs: 1, settleMs: 1 },
    flags,
    bucket,
    stateChars: 10,
    inputTokens: 5,
    visibleTextChars: 0,
    seenTextChars: 0,
    scrollOnly: false,
  };
}

describe('journeyBucket', () => {
  it('takes the majority bucket over the last three flagged steps', () => {
    expect(
      journeyBucket([
        flaggedRow('ux', 1),
        flaggedRow('product', 2),
        flaggedRow('product', 3),
        flaggedRow('product', 4),
      ]),
    ).toBe('product');
  });

  it('breaks ties in the order tool, product, ux, persona', () => {
    expect(
      journeyBucket([flaggedRow('ux', 1), flaggedRow('product', 2), flaggedRow('persona', 3)]),
    ).toBe('product');
    expect(
      journeyBucket([flaggedRow('ux', 1), flaggedRow('persona', 2), flaggedRow('tool', 3)]),
    ).toBe('tool');
  });

  it('sees a lost step, because lost is a flag', () => {
    expect(
      journeyBucket([flaggedRow('persona', 1, ['lost']), flaggedRow('persona', 2, ['lost'])]),
    ).toBe('persona');
  });

  it('is none when nothing was flagged', () => {
    expect(journeyBucket([flaggedRow('none', 1, [])])).toBe('none');
  });
});
