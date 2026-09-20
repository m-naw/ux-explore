// scripts/metrics.ts
// Run-set metrics across several report directories.
// Usage: npx tsx scripts/metrics.ts ./reports [--order Anna,Dmitry] > metrics-run-set.json

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import type { Journey, MetricsReport } from '../engine/types';
import { computeMetrics } from '../engine/trace';

/**
 * The persona ranking `ordinalCheck` compares the run set against, easiest first, from
 * `--order Anna,Dmitry,...` anywhere in the arguments. Undefined when the flag is absent,
 * and then no ordinal check is reported: there is no ranking to measure the run set against,
 * and inventing one out of the order the runs happen to load would always pass.
 */
export function parseOrderFlag(argv: readonly string[]): string[] | undefined {
  const at = argv.indexOf('--order');
  if (at === -1) return undefined;
  const value = argv[at + 1];
  const names = (value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (value === undefined || value.startsWith('--') || names.length === 0) {
    throw new Error(
      '--order needs a comma-separated list of persona names, e.g. --order Anna,Dmitry',
    );
  }
  return names;
}

/** The report root: the first argument that is neither a flag nor a flag's value. */
export function parseRootArg(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--order') {
      i += 1;
      continue;
    }
    if (!arg.startsWith('--')) return arg;
  }
  return './reports';
}

/** Read every `<runId>/journey.{yaml,json}` under a report root. */
export async function loadJourneys(reportRoot: string): Promise<Journey[]> {
  const entries = await readdir(reportRoot, { withFileTypes: true });
  const journeys: Journey[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const name of ['journey.yaml', 'journey.json']) {
      const file = path.join(reportRoot, entry.name, name);
      let source: string;
      try {
        source = await readFile(file, 'utf-8');
      } catch {
        continue;
      }
      const body = (name.endsWith('.yaml') ? parse(source) : JSON.parse(source)) as Pick<
        Journey,
        'summary' | 'rows'
      >;
      journeys.push({ summary: body.summary, rows: body.rows, toolIssues: [] });
      break;
    }
  }

  return journeys.sort((a, b) => (a.summary.runId < b.summary.runId ? -1 : 1));
}

export async function runSetMetrics(
  reportRoot: string,
  expectedOrder?: readonly string[],
): Promise<MetricsReport> {
  const journeys = await loadJourneys(reportRoot);
  return computeMetrics(journeys, expectedOrder ? [...expectedOrder] : undefined);
}

const isDirectRun = process.argv[1] !== undefined && process.argv[1].endsWith('metrics.ts');
if (isDirectRun) {
  const args = process.argv.slice(2);
  const root = parseRootArg(args);
  runSetMetrics(root, parseOrderFlag(args))
    .then((metrics) => {
      console.log(JSON.stringify(metrics, null, 2));
    })
    .catch((err: unknown) => {
      console.error(
        `Could not compute run-set metrics for ${root}: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    });
}
