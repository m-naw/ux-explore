import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { explore, type ExploreDeps } from './index';
import type { ExploreConfig, Journey, Outcome, PersonaProfile, TraceRow } from './engine/types';
import type { ReportInput, ReportOutput } from './journey/report-llm';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ux-explore-'));
  dirs.push(dir);
  return dir;
}

const PERSONA: PersonaProfile = {
  name: 'Olena',
  description: 'Ukrainian, phone only.',
  languages: { native: 'uk', reads: { uk: 'fluent', pl: 'weak' } },
  device: 'mobile',
  techLiteracy: 'low',
  domainLiteracy: 'low',
  patience: 'low',
  intent: 'high',
  facts: {},
};

const CONFIG: ExploreConfig = {
  url: 'https://dopomo.pl/pl',
  need: 'find the sugar card',
  persona: PERSONA,
  maxSteps: 25,
  seed: 1,
  engine: 'jev',
  output: './out',
  format: 'yaml',
  verbose: false,
  screenshots: true,
  recordDecisions: false,
  report: true,
};

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

function journey(rows: TraceRow[], toolIssues: TraceRow[] = []): Journey {
  return {
    summary: {
      runId: '2026-09-19T10-00-00-abcd',
      persona: { name: 'Olena' },
      browserLocale: 'uk-UA',
      device: 'mobile',
      seed: 1,
      outcome: {
        needMet: true,
        gaveUp: false,
        left: false,
        believedDone: false,
        reason: 'criteria matched',
        bucket: 'none',
        totalSteps: rows.length,
        totalDurationMs: 800,
        outcomeFindings: [],
      },
      perUrl: [],
    },
    rows,
    toolIssues,
  };
}

const REPORT: ReportOutput = {
  narrative: '# Olena\nShe got there.',
  findings: [],
  droppedFindings: 0,
  downgradedFindings: 0,
  reportMs: 42,
};

function deps(j: Journey, seen: ReportInput[] = []): ExploreDeps {
  return {
    drive: async () => j,
    report: async (input) => {
      seen.push(input);
      return REPORT;
    },
  };
}

describe('explore', () => {
  it('runs with no browser and no Jev key when deps are injected', async () => {
    const saved = process.env['TYPESAFE_API_KEY'];
    delete process.env['TYPESAFE_API_KEY'];
    try {
      const result = await explore(CONFIG, deps(journey([row()])));
      expect(result.narrative).toContain('She got there.');
      expect(result.outcome.needMet).toBe(true);
      expect(result.journey.rows).toHaveLength(1);
      expect(result.screenshotErrors).toEqual([]);
    } finally {
      if (saved !== undefined) process.env['TYPESAFE_API_KEY'] = saved;
    }
  });

  it('surfaces the report evidence-check counters', async () => {
    const result = await explore(CONFIG, {
      drive: async () => journey([row()]),
      report: async () => ({ ...REPORT, droppedFindings: 2, downgradedFindings: 1 }),
    });
    expect(result.reportValidation).toEqual({ droppedFindings: 2, downgradedFindings: 1 });
  });

  it('reports zero evidence-check counters when the report call failed', async () => {
    const result = await explore(CONFIG, {
      drive: async () => journey([row()]),
      report: async () => {
        throw new Error('report boom');
      },
    });
    expect(result.reportValidation).toEqual({ droppedFindings: 0, downgradedFindings: 0 });
    expect(result.runIssues[0]!.kind).toBe('report-failed');
  });

  it('passes the config and the onStep callback through to drive', async () => {
    const calls: Array<{ config: ExploreConfig; onStep?: (row: TraceRow) => void }> = [];
    const onStep = (): void => {};
    const j = journey([row()]);
    await explore(
      CONFIG,
      {
        drive: async (config, cb) => {
          calls.push({ config, ...(cb ? { onStep: cb } : {}) });
          return j;
        },
        report: async () => REPORT,
      },
      { onStep },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.config).toBe(CONFIG);
    expect(calls[0]!.onStep).toBe(onStep);
  });

  it('keeps tool and stale rows out of the journey the report sees', async () => {
    const seen: ReportInput[] = [];
    const j = journey(
      [
        row(),
        row({ step: 2, bucket: 'tool' }),
        row({ step: 3, bucket: 'stale' }),
        row({ step: 4 }),
      ],
      [row({ step: 2, bucket: 'tool' })],
    );
    const result = await explore(CONFIG, deps(j, seen));
    expect(seen[0]!.journey.rows.map((r) => r.step)).toEqual([1, 4]);
    expect(seen[0]!.persona).toBe(PERSONA);
    expect(seen[0]!.goal).toBe(CONFIG.need);
    expect(result.journey.rows).toHaveLength(4);
  });

  it('base64 encodes the selected screenshots for the report', async () => {
    const dir = await tempDir();
    const shot = path.join(dir, 'step-01.jpg');
    await writeFile(shot, 'jpeg-bytes');
    const seen: ReportInput[] = [];
    const j = journey([row({ flags: ['confused'], screenshotPath: shot }), row({ step: 2 })]);
    const result = await explore(CONFIG, deps(j, seen));
    expect(seen[0]!.screenshots).toEqual([
      { step: 1, base64: Buffer.from('jpeg-bytes').toString('base64') },
    ]);
    expect(result.screenshotErrors).toEqual([]);
  });

  it('collects unreadable screenshots instead of swallowing or throwing', async () => {
    const dir = await tempDir();
    const missing = path.join(dir, 'gone.jpg');
    const seen: ReportInput[] = [];
    const j = journey([row({ flags: ['confused'], screenshotPath: missing })]);
    const result = await explore(CONFIG, deps(j, seen));
    expect(seen[0]!.screenshots).toEqual([]);
    expect(result.screenshotErrors).toHaveLength(1);
    expect(result.screenshotErrors[0]).toContain('gone.jpg');
  });

  it('keeps the journey when the report call fails', async () => {
    // A failed report must not lose a run that cost a browser session and 25 Jev calls.
    // The files still get written; the narrative is empty and the failure is recorded as
    // a tool issue.
    const j = journey([row()]);
    const result = await explore(CONFIG, {
      drive: async () => j,
      report: async () => {
        throw new Error('overloaded_error: the model is overloaded');
      },
    });
    expect(result.journey).toBe(j);
    expect(result.narrative).toBe('');
    expect(result.findings).toEqual([]);
    expect(result.metrics.runIds).toEqual(['2026-09-19T10-00-00-abcd']);
    expect(result.runIssues).toEqual([
      { kind: 'report-failed', message: 'overloaded_error: the model is overloaded' },
    ]);
  });

  it('records no run issues when the report call succeeds', async () => {
    const result = await explore(CONFIG, deps(journey([row()])));
    expect(result.runIssues).toEqual([]);
  });

  it('computes single-journey metrics with no divergence ratio and no ordinal check', async () => {
    const result = await explore(CONFIG, deps(journey([row()])));
    expect(result.metrics.runIds).toEqual(['2026-09-19T10-00-00-abcd']);
    expect(result.metrics.divergenceRatio).toBeNull();
    expect(result.metrics.ordinalCheck).toBeUndefined();
  });

  it('skips the report call entirely when config.report is false', async () => {
    let reportCalls = 0;
    const result = await explore(
      { ...CONFIG, report: false },
      {
        drive: async () => journey([row()]),
        report: async () => {
          reportCalls += 1;
          throw new Error('the report must not be called');
        },
      },
    );

    expect(reportCalls).toBe(0);
    expect(result.narrative).toBe('');
    expect(result.findings).toEqual([]);
    expect(result.runIssues).toEqual([]);
    expect(result.reportMs).toBe(0);
    // The journey and its metrics are still what the browser session bought.
    expect(result.journey.rows.length).toBeGreaterThan(0);
    expect(result.metrics.runIds).toHaveLength(1);
  });

  it('surfaces run issues the driver already found, alongside anything the report call adds', async () => {
    const withRecordFailure: Journey = {
      ...journey([row()]),
      runIssues: [{ kind: 'record-failed', step: 3, message: 'EACCES: permission denied' }],
    };
    const result = await explore(CONFIG, {
      drive: async () => withRecordFailure,
      report: async () => REPORT,
    });
    expect(result.runIssues).toEqual([
      { kind: 'record-failed', step: 3, message: 'EACCES: permission denied' },
    ]);
  });
});
