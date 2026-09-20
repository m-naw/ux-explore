// report.ts
// Writes the report files for one journey.

import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import type { ExploreResult } from './engine/types';

/** Filesystem-safe timestamp, used where no runId is available. */
export function makeTimestamp(date?: Date): string {
  return (date ?? new Date())
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d{3}Z$/, '');
}

function serialize(data: unknown, format: 'yaml' | 'json'): string {
  return format === 'json' ? JSON.stringify(data, null, 2) : stringify(data, { lineWidth: 120 });
}

function ext(format: 'yaml' | 'json'): string {
  return format === 'json' ? 'json' : 'yaml';
}

export interface WriteReportResult {
  dir: string;
  /** Screenshots that could not be copied. The CLI surfaces these as tool issues. */
  screenshotErrors: string[];
}

/** Write journey, narrative, findings, tool issues, metrics and screenshots into `{outputDir}/{runId}/`. */
export async function writeReport(
  result: ExploreResult,
  outputDir: string,
  format: 'yaml' | 'json' = 'yaml',
): Promise<WriteReportResult> {
  const dir = path.join(outputDir, result.journey.summary.runId);
  await mkdir(dir, { recursive: true });

  await writeFile(
    path.join(dir, `journey.${ext(format)}`),
    serialize({ summary: result.journey.summary, rows: result.journey.rows }, format),
    'utf-8',
  );
  await writeFile(path.join(dir, 'narrative.md'), result.narrative, 'utf-8');
  await writeFile(
    path.join(dir, `findings.${ext(format)}`),
    serialize(result.findings, format),
    'utf-8',
  );
  // Step-level tool rows and run-level failures land in one file, so a reader who opens
  // tool-issues.json sees everything that went wrong with the tool on this run.
  await writeFile(
    path.join(dir, 'tool-issues.json'),
    JSON.stringify([...result.journey.toolIssues, ...result.runIssues], null, 2),
    'utf-8',
  );
  // The evidence check rides along with the metrics rather than in tool-issues.json, which is
  // an array of rows: these are counts about the report call, not steps that went wrong.
  await writeFile(
    path.join(dir, 'metrics.json'),
    JSON.stringify({ ...result.metrics, reportValidation: result.reportValidation }, null, 2),
    'utf-8',
  );

  const screenshotErrors: string[] = [...result.screenshotErrors];
  const sources = result.journey.rows
    .map((r) => r.screenshotPath)
    .filter((p): p is string => typeof p === 'string');

  if (sources.length > 0) {
    const shotDir = path.join(dir, 'screenshots');
    await mkdir(shotDir, { recursive: true });
    for (const src of sources) {
      const dest = path.join(shotDir, path.basename(src));
      if (path.resolve(src) === path.resolve(dest)) continue;
      try {
        await copyFile(src, dest);
      } catch (err) {
        screenshotErrors.push(
          `could not copy ${src}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return { dir, screenshotErrors };
}
