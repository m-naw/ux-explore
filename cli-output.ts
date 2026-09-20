// cli-output.ts
// Verbose step logging and the end-of-run summary.

import type { ExploreResult, TraceRow } from './engine/types';

export function logStep(row: TraceRow): void {
  const status = row.outcome.error ? '\x1b[31mFAIL\x1b[0m' : '\x1b[32m OK \x1b[0m';
  const probability = (row.pruned[row.sampled] ?? 0).toFixed(2);
  console.log(
    `  [${String(row.step).padStart(2, ' ')}] ${status} ${row.sampled} "${row.sampledName}" p=${probability}` +
      `${row.exploration ? ' (explored)' : ''}`,
  );
  console.log(
    `       \x1b[90mconf ${row.confidence.toFixed(2)}  entropy ${row.entropy.toFixed(2)}  ` +
      `confusion ${row.confusion.toFixed(2)}  goalMet ${row.goalMet.toFixed(2)}  ${row.timing.decideMs}ms\x1b[0m`,
  );
  // Worth seeing as it happens: a run that keeps falling back to a re-extract or a locator is
  // fighting the page, even when every step reports OK.
  if (row.clickPath && row.clickPath !== 'handle')
    console.log(`       \x1b[90mreached the target via: ${row.clickPath}\x1b[0m`);
  if (row.flags.length > 0)
    console.log(`       \x1b[33mflags: ${row.flags.join(', ')} -> ${row.bucket}\x1b[0m`);
  if (row.outcome.error)
    console.log(`       \x1b[31m${row.outcome.errorClass}: ${row.outcome.error}\x1b[0m`);
  console.log(`       \x1b[90m${row.url}\x1b[0m`);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function printSummary(
  result: ExploreResult,
  reportDir: string,
  screenshotErrors: string[],
  verbose = false,
): void {
  const { outcome } = result;
  const verdict =
    outcome.needMet === true ? 'NEED MET' : outcome.needMet === null ? 'UNVERIFIED' : 'NOT MET';

  console.log('\n=== ux-explore run complete ===\n');
  console.log(`Run:         ${result.journey.summary.runId}`);
  console.log(
    `Persona:     ${result.journey.summary.persona.name} (${result.journey.summary.device}, ${result.journey.summary.browserLocale})`,
  );
  const suffix =
    outcome.left && outcome.gaveUp ? ' (left, gave up)' : outcome.left ? ' (left)' : '';
  console.log(`Outcome:     ${verdict}${suffix}`);
  console.log(`Reason:      ${outcome.reason}`);
  console.log(`Bucket:      ${outcome.bucket}`);
  if (outcome.outcomeFindings.length > 0)
    console.log(`Outcome flags: ${outcome.outcomeFindings.join(', ')}`);
  console.log(`Steps:       ${outcome.totalSteps}`);
  console.log(`Duration:    ${(outcome.totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`Exploration: ${(result.metrics.explorationRate * 100).toFixed(0)}%`);
  console.log(`Findings:    ${result.findings.length}`);
  for (const severity of ['high', 'medium', 'low'] as const) {
    const count = result.findings.filter((f) => f.severity === severity).length;
    if (count > 0) console.log(`  ${severity.padEnd(7)} ${count}`);
  }
  const { droppedFindings, downgradedFindings } = result.reportValidation;
  if (verbose || droppedFindings > 0 || downgradedFindings > 0) {
    console.log(
      `Report check: ${plural(droppedFindings, 'finding')} dropped, ${downgradedFindings} downgraded ` +
        'out of product (see metrics.json)',
    );
  }
  const toolIssues = result.journey.toolIssues.length + result.runIssues.length;
  if (toolIssues > 0) console.log(`Tool issues: ${toolIssues} (see tool-issues.json)`);
  for (const issue of result.runIssues)
    console.log(`\x1b[33mTool issue: ${issue.kind}: ${issue.message}\x1b[0m`);
  for (const error of screenshotErrors) console.log(`\x1b[33mTool issue: ${error}\x1b[0m`);
  console.log(`\nReport:      ${reportDir}`);
}
