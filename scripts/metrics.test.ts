import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { loadJourneys, parseOrderFlag, parseRootArg, runSetMetrics } from './metrics';
import type { Journey, TraceRow } from '../engine/types';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function row(stateHash: string, distribution: Record<string, number>, confusion: number): TraceRow {
  return {
    step: 1,
    timestamp: 0,
    url: 'https://dopomo.pl/pl',
    stateHash,
    viewHash: 'v',
    viewport: { width: 1280, height: 720 },
    elementsCount: 5,
    droppedElements: 0,
    options: [],
    distribution,
    pruned: distribution,
    sampled: Object.keys(distribution)[0]!,
    sampledName: 'x',
    argmax: Object.keys(distribution)[0]!,
    exploration: false,
    confidence: 1,
    entropy: 0,
    goalMet: 0,
    confusion,
    outcome: {
      urlChanged: false,
      stateChanged: false,
      consoleErrors: [],
      failedRequests: [],
      validationMessages: [],
      durationMs: 1,
    },
    timing: { extractMs: 1, decideMs: 1, decideRetryMs: 0, executeMs: 1, settleMs: 1 },
    flags: [],
    bucket: 'none',
    stateChars: 900,
    inputTokens: 300,
    visibleTextChars: 0,
    seenTextChars: 0,
    scrollOnly: false,
  };
}

function journey(
  name: string,
  seed: number,
  steps: number,
  distribution: Record<string, number>,
  confusion: number,
): Journey {
  return {
    summary: {
      runId: `${name}-${seed}`,
      persona: { name },
      browserLocale: 'pl-PL',
      device: 'desktop',
      seed,
      outcome: {
        needMet: true,
        gaveUp: false,
        left: false,
        believedDone: false,
        reason: 'criteria matched',
        bucket: 'none',
        totalSteps: steps,
        totalDurationMs: 1000,
        outcomeFindings: [],
      },
      perUrl: [],
    },
    rows: [row('shared', distribution, confusion)],
    toolIssues: [],
  };
}

async function writeRun(root: string, j: Journey, format: 'yaml' | 'json'): Promise<void> {
  const dir = path.join(root, j.summary.runId);
  await mkdir(dir, { recursive: true });
  const body = { summary: j.summary, rows: j.rows };
  await writeFile(
    path.join(dir, `journey.${format}`),
    format === 'yaml' ? stringify(body) : JSON.stringify(body, null, 2),
    'utf-8',
  );
}

describe('loadJourneys', () => {
  it('reads both yaml and json journey files and ignores other directories', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ux-metrics-'));
    dirs.push(root);
    await writeRun(root, journey('Anna', 1, 3, { a: 1 }, 1), 'yaml');
    await writeRun(root, journey('Olena', 1, 9, { b: 1 }, 3), 'json');
    await mkdir(path.join(root, 'not-a-run'), { recursive: true });

    const journeys = await loadJourneys(root);
    expect(journeys.map((j) => j.summary.persona.name).sort()).toEqual(['Anna', 'Olena']);
    expect(journeys[0]!.toolIssues).toEqual([]);
  });
});

describe('runSetMetrics', () => {
  it('computes the divergence ratio and the ordinal check across the run set', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ux-metrics-'));
    dirs.push(root);
    await writeRun(root, journey('Anna', 1, 3, { a: 1, b: 0 }, 1), 'yaml');
    await writeRun(root, journey('Anna', 2, 3, { a: 0.9, b: 0.1 }, 1), 'yaml');
    await writeRun(root, journey('Olena', 1, 9, { a: 0, b: 1 }, 3), 'yaml');

    const metrics = await runSetMetrics(root, ['Anna', 'Dmitry', 'James', 'Olena']);
    expect(metrics.divergenceRatio).toBeGreaterThan(5);
    expect(metrics.ordinalCheck?.expected).toEqual(['Anna', 'Dmitry', 'James', 'Olena']);
    expect(metrics.ordinalCheck?.actual).toEqual(['Anna', 'Olena']);
    expect(metrics.ordinalCheck?.ordered).toBe(true);
    expect(metrics.runIds).toHaveLength(3);
    expect(metrics.charsPerToken).toBeCloseTo(3, 10);
  });
});

describe('parseOrderFlag', () => {
  it('is undefined without the flag, and then no ordinal check is reported', () => {
    expect(parseOrderFlag(['reports/'])).toBeUndefined();
  });

  it('finds the flag wherever it sits, and the root is still the path', () => {
    expect(parseOrderFlag(['--order', 'Anna,Dmitry', 'reports/'])).toEqual(['Anna', 'Dmitry']);
    expect(parseRootArg(['--order', 'Anna,Dmitry', 'reports/'])).toBe('reports/');
    expect(parseRootArg(['reports/', '--order', 'Anna,Dmitry'])).toBe('reports/');
    expect(parseRootArg([])).toBe('./reports');
  });

  it('splits a comma-separated list and trims the names', () => {
    expect(parseOrderFlag(['reports/', '--order', 'Anna, Dmitry ,James'])).toEqual([
      'Anna',
      'Dmitry',
      'James',
    ]);
  });

  it('rejects a flag with nothing usable after it', () => {
    expect(() => parseOrderFlag(['--order'])).toThrow(/comma-separated/);
    expect(() => parseOrderFlag(['--order', '--states'])).toThrow(/comma-separated/);
    expect(() => parseOrderFlag(['--order', ' , '])).toThrow(/comma-separated/);
  });
});

describe('runSetMetrics ordinal check', () => {
  it('reports no ordinal check when no ranking was declared', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ux-metrics-'));
    dirs.push(root);
    await writeRun(root, journey('Anna', 1, 3, { a: 1, b: 0 }, 1), 'yaml');
    await writeRun(root, journey('Olena', 1, 9, { a: 0, b: 1 }, 3), 'yaml');

    expect((await runSetMetrics(root)).ordinalCheck).toBeUndefined();
  });
});
