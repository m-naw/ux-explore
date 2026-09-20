import { describe, it, expect } from 'vitest';
import { detectLoop } from './loop-detector';
import type { Outcome, TraceRow } from './types';

const OUTCOME: Outcome = {
  urlChanged: false,
  stateChanged: false,
  consoleErrors: [],
  failedRequests: [],
  validationMessages: [],
  durationMs: 10,
};

interface RowSpec {
  step: number;
  url?: string;
  stateHash: string;
  viewHash: string;
  sampled: string;
  sampledName: string;
  sampledHref?: string;
}

function row(spec: RowSpec): TraceRow {
  return {
    step: spec.step,
    timestamp: spec.step,
    url: spec.url ?? 'https://x.test/page',
    stateHash: spec.stateHash,
    viewHash: spec.viewHash,
    viewport: { width: 1280, height: 720 },
    elementsCount: 5,
    droppedElements: 0,
    options: [],
    distribution: {},
    pruned: {},
    sampled: spec.sampled,
    sampledName: spec.sampledName,
    ...(spec.sampledHref ? { sampledHref: spec.sampledHref } : {}),
    argmax: spec.sampled,
    exploration: false,
    confidence: 1,
    entropy: 0,
    goalMet: 0,
    confusion: 0,
    outcome: OUTCOME,
    timing: { extractMs: 1, decideMs: 1, decideRetryMs: 0, executeMs: 1, settleMs: 1 },
    flags: [],
    bucket: 'none',
    stateChars: 10,
    inputTokens: 5,
    visibleTextChars: 0,
    seenTextChars: 0,
    scrollOnly: spec.sampled.startsWith('scroll'),
  };
}

describe('detectLoop', () => {
  it('fires on the same name and href three times in a row on the same state', () => {
    const rows = [1, 2, 3].map((step) =>
      row({
        step,
        stateHash: 'a',
        viewHash: 'va',
        sampled: 'el_01',
        sampledName: 'Dalej',
        sampledHref: '/next',
      }),
    );
    expect(detectLoop(rows)).toEqual({ looped: true, reason: 'repeat-action' });
  });

  it('does not fire when the same name points at a different href', () => {
    const rows = [
      row({
        step: 1,
        stateHash: 'a',
        viewHash: 'va',
        sampled: 'el_01',
        sampledName: 'Dalej',
        sampledHref: '/a',
      }),
      row({
        step: 2,
        stateHash: 'a',
        viewHash: 'va',
        sampled: 'el_02',
        sampledName: 'Dalej',
        sampledHref: '/b',
      }),
      row({
        step: 3,
        stateHash: 'a',
        viewHash: 'va',
        sampled: 'el_01',
        sampledName: 'Dalej',
        sampledHref: '/a',
      }),
    ];
    expect(detectLoop(rows).looped).toBe(false);
  });

  it('does not fire when the state changed between repeats', () => {
    const rows = [
      row({ step: 1, stateHash: 'a', viewHash: 'va', sampled: 'el_01', sampledName: 'Dalej' }),
      row({ step: 2, stateHash: 'b', viewHash: 'vb', sampled: 'el_01', sampledName: 'Dalej' }),
      row({ step: 3, stateHash: 'a', viewHash: 'va', sampled: 'el_01', sampledName: 'Dalej' }),
    ];
    expect(detectLoop(rows).looped).toBe(false);
  });

  it('fires when viewHash is unchanged for four consecutive steps', () => {
    const rows = [1, 2, 3, 4].map((step) =>
      row({ step, stateHash: 'a', viewHash: 'v', sampled: `el_0${step}`, sampledName: `A${step}` }),
    );
    expect(detectLoop(rows)).toEqual({ looped: true, reason: 'stuck-view' });
  });

  it('fires on down, up, down, up on one page, even though every scroll changes the state hash', () => {
    const rows = [
      row({
        step: 1,
        stateHash: 's1',
        viewHash: 'v1',
        sampled: 'scroll_down',
        sampledName: 'scroll_down',
      }),
      row({
        step: 2,
        stateHash: 's2',
        viewHash: 'v2',
        sampled: 'scroll_up',
        sampledName: 'scroll_up',
      }),
      row({
        step: 3,
        stateHash: 's3',
        viewHash: 'v1',
        sampled: 'scroll_down',
        sampledName: 'scroll_down',
      }),
      row({
        step: 4,
        stateHash: 's4',
        viewHash: 'v2',
        sampled: 'scroll_up',
        sampledName: 'scroll_up',
      }),
    ];
    expect(detectLoop(rows)).toEqual({ looped: true, reason: 'scroll-oscillation' });
  });

  it('does not call an oscillation across two different pages a loop', () => {
    const rows = [
      row({
        step: 1,
        url: 'https://x.test/a',
        stateHash: 's1',
        viewHash: 'v1',
        sampled: 'scroll_down',
        sampledName: 'scroll_down',
      }),
      row({
        step: 2,
        url: 'https://x.test/a',
        stateHash: 's2',
        viewHash: 'v2',
        sampled: 'scroll_up',
        sampledName: 'scroll_up',
      }),
      row({
        step: 3,
        url: 'https://x.test/b',
        stateHash: 's3',
        viewHash: 'v3',
        sampled: 'scroll_down',
        sampledName: 'scroll_down',
      }),
      row({
        step: 4,
        url: 'https://x.test/b',
        stateHash: 's4',
        viewHash: 'v4',
        sampled: 'scroll_up',
        sampledName: 'scroll_up',
      }),
    ];
    expect(detectLoop(rows).looped).toBe(false);
  });

  it('ignores utm noise when deciding whether it is the same page', () => {
    const rows = [
      row({
        step: 1,
        url: 'https://x.test/a',
        stateHash: 's1',
        viewHash: 'v1',
        sampled: 'scroll_down',
        sampledName: 'scroll_down',
      }),
      row({
        step: 2,
        url: 'https://x.test/a?utm_source=x',
        stateHash: 's2',
        viewHash: 'v2',
        sampled: 'scroll_up',
        sampledName: 'scroll_up',
      }),
      row({
        step: 3,
        url: 'https://x.test/a/',
        stateHash: 's3',
        viewHash: 'v1',
        sampled: 'scroll_down',
        sampledName: 'scroll_down',
      }),
      row({
        step: 4,
        url: 'https://x.test/a',
        stateHash: 's4',
        viewHash: 'v2',
        sampled: 'scroll_up',
        sampledName: 'scroll_up',
      }),
    ];
    expect(detectLoop(rows)).toEqual({ looped: true, reason: 'scroll-oscillation' });
  });

  it('does not fire on ordinary progress', () => {
    const rows = [1, 2, 3, 4].map((step) =>
      row({
        step,
        url: `https://x.test/${step}`,
        stateHash: `s${step}`,
        viewHash: `v${step}`,
        sampled: `el_0${step}`,
        sampledName: `A${step}`,
      }),
    );
    expect(detectLoop(rows).looped).toBe(false);
  });
});
