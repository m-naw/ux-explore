import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { main, missingKey } from './cli';
import { parseCliFlags } from './cli-config';
import { PERSONA_DIR } from './personas';
import type { ExploreDeps } from './index';
import type { Journey, TraceRow } from './engine/types';

const OLENA = path.join(PERSONA_DIR, 'olena.yaml');
const dirs: string[] = [];

beforeEach(() => {
  process.env['TYPESAFE_API_KEY'] = 'test-key';
  process.env['ANTHROPIC_API_KEY'] = 'test-key';
  process.exitCode = 0;
});

afterEach(async () => {
  delete process.env['TYPESAFE_API_KEY'];
  process.exitCode = 0;
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ux-cli-'));
  dirs.push(dir);
  return dir;
}

function fakeJourney(rows: TraceRow[] = []): Journey {
  return {
    summary: {
      runId: '2026-09-19T12-00-00-zzzz',
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
        totalDurationMs: 100,
        outcomeFindings: [],
      },
      perUrl: [],
    },
    rows,
    toolIssues: [],
  };
}

const DEPS: ExploreDeps = {
  drive: async () => fakeJourney(),
  report: async () => ({
    narrative: '# done',
    findings: [],
    droppedFindings: 0,
    downgradedFindings: 0,
    reportMs: 12,
  }),
};

describe('main', () => {
  it('prints usage for --help and exits cleanly', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--help']);
    expect(log.mock.calls.flat().join('\n')).toContain('--success-url');
    expect(process.exitCode).toBe(0);
  });

  it('reports a missing flag and sets a failing exit code', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await main(['--url', 'https://x.test']);
    expect(process.exitCode).toBe(1);
  });

  it('refuses to start without TYPESAFE_API_KEY or without ANTHROPIC_API_KEY', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env['TYPESAFE_API_KEY'];
    await main(['--url', 'https://x.test', '--need', 'n', '--persona', OLENA]);
    expect(error.mock.calls.flat().join('\n')).toContain('TYPESAFE_API_KEY');
    expect(process.exitCode).toBe(1);

    process.env['TYPESAFE_API_KEY'] = 'test-key';
    delete process.env['ANTHROPIC_API_KEY'];
    process.exitCode = 0;
    await main(['--url', 'https://x.test', '--need', 'n', '--persona', OLENA]);
    expect(error.mock.calls.flat().join('\n')).toContain('ANTHROPIC_API_KEY');
    expect(process.exitCode).toBe(1);
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
  });

  it('does not require ANTHROPIC_API_KEY when --no-report is set, but still requires TYPESAFE_API_KEY', () => {
    const base = ['--url', 'https://x.test', '--need', 'n', '--persona', OLENA];

    delete process.env['ANTHROPIC_API_KEY'];
    expect(missingKey(parseCliFlags([...base, '--no-report']))).toBeUndefined();

    delete process.env['TYPESAFE_API_KEY'];
    expect(missingKey(parseCliFlags([...base, '--no-report']))).toContain('TYPESAFE_API_KEY');

    process.env['TYPESAFE_API_KEY'] = 'test-key';
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
  });

  it('reports a persona file that does not exist', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await main(['--url', 'https://x.test', '--need', 'n', '--persona', '/nope/none.yaml'], DEPS);
    expect(error.mock.calls.flat().join('\n')).toContain('Persona file not found');
    expect(process.exitCode).toBe(1);
  });

  it('runs the pipeline with injected deps and writes a report, launching no browser', async () => {
    const base = await tempDir();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(
      ['--url', 'https://x.test', '--need', 'n', '--persona', OLENA, '--output', base],
      DEPS,
    );
    const printed = log.mock.calls.flat().join('\n');
    expect(printed).toContain('NEED MET');
    expect(printed).toContain('2026-09-19T12-00-00-zzzz');
    expect(process.exitCode).toBe(0);
  });

  it('surfaces a screenshot that could not be copied as a tool issue', async () => {
    const base = await tempDir();
    const shot = path.join(base, 'missing.jpg');
    await writeFile(path.join(base, 'placeholder'), '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const deps: ExploreDeps = {
      drive: async () =>
        fakeJourney([
          {
            step: 1,
            timestamp: 0,
            url: 'https://x.test/',
            stateHash: 'h',
            viewHash: 'v',
            viewport: { width: 390, height: 844 },
            screenshotPath: shot,
            elementsCount: 1,
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
            stateChars: 1,
            inputTokens: 1,
            visibleTextChars: 0,
            seenTextChars: 0,
            scrollOnly: false,
          },
        ]),
      report: async () => ({
        narrative: '# done',
        findings: [],
        droppedFindings: 0,
        downgradedFindings: 0,
        reportMs: 12,
      }),
    };
    await main(
      ['--url', 'https://x.test', '--need', 'n', '--persona', OLENA, '--output', base],
      deps,
    );
    expect(log.mock.calls.flat().join('\n')).toContain('Tool issue:');
  });

  it('prints the report evidence check when it changed anything, and under --verbose', async () => {
    const base = await tempDir();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const checked: ExploreDeps = {
      drive: async () => fakeJourney(),
      report: async () => ({
        narrative: '# done',
        findings: [],
        droppedFindings: 1,
        downgradedFindings: 2,
        reportMs: 12,
      }),
    };
    await main(
      ['--url', 'https://x.test', '--need', 'n', '--persona', OLENA, '--output', base],
      checked,
    );
    const printed = log.mock.calls.flat().join('\n');
    expect(printed).toContain('Report check:');
    expect(printed).toContain('1 finding dropped');
    expect(printed).toContain('2 downgraded');

    // Silent when the model broke no rules...
    log.mockClear();
    await main(
      ['--url', 'https://x.test', '--need', 'n', '--persona', OLENA, '--output', base],
      DEPS,
    );
    expect(log.mock.calls.flat().join('\n')).not.toContain('Report check:');

    // ...unless the run is verbose, where a clean check is worth stating.
    log.mockClear();
    await main(
      ['--url', 'https://x.test', '--need', 'n', '--persona', OLENA, '--output', base, '--verbose'],
      DEPS,
    );
    expect(log.mock.calls.flat().join('\n')).toContain('Report check:');
  });

  it('deduplicates a screenshot error reported by both explore() and writeReport() for the same path', async () => {
    const base = await tempDir();
    const shot = path.join(base, 'missing-flagged.jpg');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const flaggedRow: TraceRow = {
      step: 1,
      timestamp: 0,
      url: 'https://x.test/',
      stateHash: 'h',
      viewHash: 'v',
      viewport: { width: 390, height: 844 },
      screenshotPath: shot,
      elementsCount: 1,
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
      outcome: {
        urlChanged: false,
        stateChanged: false,
        consoleErrors: [],
        failedRequests: [],
        validationMessages: [],
        durationMs: 1,
      },
      timing: { extractMs: 1, decideMs: 1, decideRetryMs: 0, executeMs: 1, settleMs: 1 },
      // Flagged (and not tool/stale) so explore() also tries to read it for the report call,
      // in addition to writeReport() trying to copy it into the output dir.
      flags: ['confused'],
      bucket: 'none',
      stateChars: 1,
      inputTokens: 1,
      visibleTextChars: 0,
      seenTextChars: 0,
      scrollOnly: false,
    };
    const deps: ExploreDeps = {
      drive: async () => fakeJourney([flaggedRow]),
      report: async () => ({
        narrative: '# done',
        findings: [],
        droppedFindings: 0,
        downgradedFindings: 0,
        reportMs: 12,
      }),
    };
    await main(
      ['--url', 'https://x.test', '--need', 'n', '--persona', OLENA, '--output', base],
      deps,
    );
    const printed = log.mock.calls.flat().join('\n');
    const occurrences = printed.split('Tool issue:').length - 1;
    expect(occurrences).toBe(1);
    expect(printed).toContain(shot);
  });
});
