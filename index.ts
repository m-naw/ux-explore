// index.ts
// Public API for the ux-explore module.

export type {
  Bucket,
  Decision,
  DecideEngine,
  DecideInput,
  Element,
  ExploreConfig,
  ExploreResult,
  Finding,
  Flag,
  Journey,
  JourneySummary,
  MetricsReport,
  Option,
  Outcome,
  PageState,
  PerUrlRow,
  PersonaProfile,
  RawDecision,
  RunIssue,
  TraceRow,
} from './engine/types';

export { ALL_BUCKETS, ALL_FLAGS, FACT_KEYS, isBucket, isFlag } from './engine/types';
export { loadPersona, parsePersona, PersonaValidationError, PERSONA_DIR } from './personas';
export { writeReport, makeTimestamp, type WriteReportResult } from './report';
export { computeMetrics, aggregatePerUrl } from './engine/trace';

import { readFile } from 'node:fs/promises';
import type { ExploreConfig, ExploreResult, Journey, RunIssue, TraceRow } from './engine/types';
import { drive, launchBrowser } from './engine/driver';
import { JevEngine } from './engine/jev-engine';
import { computeMetrics } from './engine/trace';
import {
  generateReport,
  selectScreenshotRows,
  type ReportInput,
  type ReportOutput,
} from './journey/report-llm';

/** The two side-effecting steps of a run, injectable for tests. */
export interface ExploreDeps {
  drive: (config: ExploreConfig, onStep?: (row: TraceRow) => void) => Promise<Journey>;
  report: (input: ReportInput) => Promise<ReportOutput>;
}

export interface ExploreOptions {
  onStep?: (row: TraceRow) => void;
}

/**
 * The default driver: it owns the browser and the Jev engine.
 * Keeping them here rather than in explore() is what lets an injected `deps`
 * run the whole pipeline with no Chromium and no API key.
 */
async function driveWithRealBrowser(
  config: ExploreConfig,
  onStep?: (row: TraceRow) => void,
): Promise<Journey> {
  const browser = await launchBrowser();
  try {
    return await drive(config, { browser, engine: new JevEngine(), ...(onStep ? { onStep } : {}) });
  } finally {
    await browser.close();
  }
}

/** Run one exploration: drive the browser loop, then make a single Sonnet report call. */
export async function explore(
  config: ExploreConfig,
  deps?: ExploreDeps,
  options?: ExploreOptions,
): Promise<ExploreResult> {
  const resolved: ExploreDeps = deps ?? {
    drive: driveWithRealBrowser,
    report: (input) => generateReport(input),
  };

  const journey = await resolved.drive(config, options?.onStep);

  const screenshots: Array<{ step: number; base64: string }> = [];
  const screenshotErrors: string[] = [];
  for (const row of config.report ? selectScreenshotRows(journey.rows) : []) {
    const source = row.screenshotPath;
    // selectScreenshotRows only returns rows that have one; the check keeps the types honest.
    if (!source) continue;
    try {
      screenshots.push({ step: row.step, base64: (await readFile(source)).toString('base64') });
    } catch (err) {
      screenshotErrors.push(
        `could not read ${source}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Tool and stale rows are reported separately as journey.toolIssues; the model is
  // forbidden to write findings about them, so they never reach it as trace rows.
  const reportable: Journey = {
    ...journey,
    rows: journey.rows.filter((r) => r.bucket !== 'tool' && r.bucket !== 'stale'),
  };
  // A failed report must not cost the run: the journey, its metrics and its tool issues are
  // what the browser session actually bought, and writeReport() still writes all of them
  // even when the model call fails. The narrative is simply empty.
  // Run-level failures the driver already hit (e.g. a decision record it could not write)
  // travel with the journey; they are surfaced here alongside anything the report call adds.
  const runIssues: RunIssue[] = [...(journey.runIssues ?? [])];
  let report: ReportOutput = {
    narrative: '',
    findings: [],
    droppedFindings: 0,
    downgradedFindings: 0,
    reportMs: 0,
  };
  if (config.report) {
    try {
      report = await resolved.report({
        persona: config.persona,
        goal: config.need,
        journey: reportable,
        screenshots,
      });
    } catch (err) {
      runIssues.push({
        kind: 'report-failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    journey,
    narrative: report.narrative,
    findings: report.findings,
    metrics: computeMetrics([journey]),
    outcome: journey.summary.outcome,
    screenshotErrors,
    runIssues,
    reportMs: report.reportMs,
    reportValidation: {
      droppedFindings: report.droppedFindings,
      downgradedFindings: report.downgradedFindings,
    },
  };
}
