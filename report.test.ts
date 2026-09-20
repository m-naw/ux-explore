import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { makeTimestamp, writeReport } from './report';
import type { ExploreResult, Outcome, TraceRow } from './engine/types';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ux-report-'));
  dirs.push(dir);
  return dir;
}

const OUTCOME: Outcome = {
  urlChanged: true,
  stateChanged: true,
  consoleErrors: [],
  failedRequests: [],
  validationMessages: [],
  durationMs: 30,
};

function row(overrides: Partial<TraceRow> = {}): TraceRow {
  return {
    step: 1,
    timestamp: 0,
    url: 'https://dopomo.pl/pl',
    stateHash: 'h1',
    viewHash: 'v1',
    viewport: { width: 390, height: 844 },
    elementsCount: 9,
    droppedElements: 0,
    options: [],
    distribution: { a: 1 },
    pruned: { a: 1 },
    sampled: 'a',
    sampledName: 'Karta CUKR',
    sampledHref: '/pl/cukr',
    argmax: 'a',
    exploration: false,
    confidence: 1,
    entropy: 0,
    goalMet: 0,
    confusion: 1,
    outcome: OUTCOME,
    timing: { extractMs: 80, decideMs: 300, decideRetryMs: 0, executeMs: 180, settleMs: 250 },
    flags: [],
    bucket: 'none',
    stateChars: 3000,
    inputTokens: 1000,
    visibleTextChars: 0,
    seenTextChars: 0,
    scrollOnly: false,
    ...overrides,
  };
}

function result(rows: TraceRow[] = [row()]): ExploreResult {
  const journey = {
    summary: {
      runId: '2026-09-19T10-00-00-abcd',
      persona: { name: 'Olena' },
      browserLocale: 'uk-UA',
      device: 'mobile' as const,
      seed: 1,
      outcome: {
        needMet: true,
        gaveUp: false,
        left: false,
        believedDone: false,
        reason: 'criteria matched',
        bucket: 'none' as const,
        totalSteps: rows.length,
        totalDurationMs: 800,
        outcomeFindings: [],
      },
      perUrl: [],
    },
    rows,
    toolIssues: [row({ step: 2, bucket: 'tool' })],
  };
  return {
    journey,
    narrative: '# Olena\nShe got there.',
    findings: [
      {
        findingId: 'f1',
        category: 'navigation',
        severity: 'medium',
        confidence: 'high',
        bucket: 'ux',
        issue: 'i',
        evidence: 'e',
        evidenceSteps: [1],
        recommendation: 'r',
        analyticsCheck: 'a',
      },
    ],
    metrics: {
      runIds: ['2026-09-19T10-00-00-abcd'],
      divergenceRatio: null,
      explorationRate: 0,
      completionRateByExploration: { explored: null, exploited: 1 },
      perUrl: [],
      leaveRateByPersona: {},
      charsPerToken: 3,
    },
    outcome: journey.summary.outcome,
    screenshotErrors: [],
    runIssues: [],
    reportMs: 1234,
    reportValidation: { droppedFindings: 1, downgradedFindings: 2 },
  };
}

describe('makeTimestamp', () => {
  it('is filesystem safe', () => {
    expect(makeTimestamp(new Date('2026-09-19T10:11:12.345Z'))).toBe('2026-09-19T10-11-12');
  });
});

describe('writeReport', () => {
  it('writes every spec file into a run-id directory', async () => {
    const base = await tempDir();
    const { dir, screenshotErrors } = await writeReport(result(), base, 'yaml');

    expect(path.basename(dir)).toBe('2026-09-19T10-00-00-abcd');
    expect(screenshotErrors).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual([
      'findings.yaml',
      'journey.yaml',
      'metrics.json',
      'narrative.md',
      'tool-issues.json',
    ]);

    const journey = parse(await readFile(path.join(dir, 'journey.yaml'), 'utf-8')) as {
      summary: { runId: string };
      rows: unknown[];
    };
    expect(journey.summary.runId).toBe('2026-09-19T10-00-00-abcd');
    expect(journey.rows).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(dir, 'tool-issues.json'), 'utf-8'))).toHaveLength(1);
    const metrics = JSON.parse(await readFile(path.join(dir, 'metrics.json'), 'utf-8'));
    expect(metrics.charsPerToken).toBe(3);
    // The evidence check rides with the metrics, not with the per-step tool rows.
    expect(metrics.reportValidation).toEqual({ droppedFindings: 1, downgradedFindings: 2 });
    expect(await readFile(path.join(dir, 'narrative.md'), 'utf-8')).toContain('She got there.');
  });

  it('writes run-level failures into tool-issues.json alongside the tool rows', async () => {
    const base = await tempDir();
    const failed: ExploreResult = {
      ...result(),
      narrative: '',
      findings: [],
      runIssues: [{ kind: 'report-failed', message: 'overloaded_error' }],
    };
    const { dir } = await writeReport(failed, base, 'yaml');
    const issues = JSON.parse(
      await readFile(path.join(dir, 'tool-issues.json'), 'utf-8'),
    ) as unknown[];
    expect(issues).toHaveLength(2);
    expect(issues[1]).toEqual({ kind: 'report-failed', message: 'overloaded_error' });
    // The journey is still on disk, which is the point of not throwing.
    expect(await readFile(path.join(dir, 'journey.yaml'), 'utf-8')).toContain('runId');
  });

  it('writes json when asked', async () => {
    const base = await tempDir();
    const { dir } = await writeReport(result(), base, 'json');
    const files = await readdir(dir);
    expect(files).toContain('journey.json');
    expect(files).toContain('findings.json');
  });

  it('copies screenshots that exist', async () => {
    const base = await tempDir();
    const shot = path.join(base, 'step-01.jpg');
    await writeFile(shot, 'not really a jpeg');
    const { dir, screenshotErrors } = await writeReport(
      result([row({ screenshotPath: shot })]),
      base,
      'yaml',
    );
    expect(screenshotErrors).toEqual([]);
    expect(await readdir(path.join(dir, 'screenshots'))).toEqual(['step-01.jpg']);
  });

  it('reports a screenshot it could not copy instead of swallowing it', async () => {
    const base = await tempDir();
    const missing = path.join(base, 'does-not-exist.jpg');
    const { screenshotErrors } = await writeReport(
      result([row({ screenshotPath: missing })]),
      base,
      'yaml',
    );
    expect(screenshotErrors).toHaveLength(1);
    expect(screenshotErrors[0]).toContain('does-not-exist.jpg');
  });

  it('matches the serialized journey snapshot', async () => {
    const base = await tempDir();
    const { dir } = await writeReport(result(), base, 'yaml');
    expect(await readFile(path.join(dir, 'journey.yaml'), 'utf-8')).toMatchSnapshot();
  });
});
