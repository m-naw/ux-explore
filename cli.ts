// cli.ts
// Standalone CLI entry point for ux-explore.

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(scriptDir, '.env.local') });
dotenv.config({ path: path.join(scriptDir, '.env') });

import { explore, type ExploreDeps } from './index';
import { writeReport } from './report';
import { parseCliFlags, validateFlags, buildConfig, USAGE, type ParsedFlags } from './cli-config';
import { logStep, printSummary } from './cli-output';

export { parseCliFlags, validateFlags, buildConfig } from './cli-config';
export type { ParsedFlags } from './cli-config';

/**
 * Both keys must be present before any work starts; an injected pipeline calls neither API.
 * `--no-report` skips the single Sonnet call, so ANTHROPIC_API_KEY is not required for it.
 */
export function missingKey(flags: ParsedFlags, deps?: ExploreDeps): string | undefined {
  if (deps) return undefined;
  if (!process.env['TYPESAFE_API_KEY'])
    return 'TYPESAFE_API_KEY is not set. The Jev decide engine needs it.';
  if (!flags['no-report'] && !process.env['ANTHROPIC_API_KEY']) {
    return 'ANTHROPIC_API_KEY is not set. The Sonnet report call needs it.';
  }
  return undefined;
}

/** Pulls the file path out of a "could not read/copy <path>: <cause>" screenshot error. */
function screenshotErrorPath(message: string): string {
  const match = /^could not (?:read|copy) (.+?): /.exec(message);
  return match?.[1] ?? message;
}

/**
 * `explore()` and `writeReport()` each fail independently on the same missing screenshot
 * (one reading it for the report call, the other copying it into the output dir), so the
 * combined list is deduplicated by path before it reaches the user.
 */
function mergeScreenshotErrors(...lists: string[][]): string[] {
  const byPath = new Map<string, string>();
  for (const list of lists) {
    for (const message of list) {
      const key = screenshotErrorPath(message);
      if (!byPath.has(key)) byPath.set(key, message);
    }
  }
  return [...byPath.values()];
}

export async function main(args?: string[], deps?: ExploreDeps): Promise<void> {
  let flags: ParsedFlags;
  try {
    flags = parseCliFlags(args);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (flags.help) {
    console.log(USAGE);
    return;
  }

  const validationError = validateFlags(flags);
  if (validationError) {
    console.error(`Error: ${validationError}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const keyError = missingKey(flags, deps);
  if (keyError) {
    console.error(`Error: ${keyError}`);
    process.exitCode = 1;
    return;
  }

  try {
    const config = await buildConfig(flags);
    console.log(`Exploring ${config.url} as ${config.persona.name} (${config.persona.device})`);
    console.log(`Goal: ${config.need}`);
    console.log(`Steps: ${config.maxSteps}  Seed: ${config.seed}\n`);

    const result = await explore(config, deps, flags.verbose ? { onStep: logStep } : undefined);
    if (flags.verbose) console.log(`  report call: ${(result.reportMs / 1000).toFixed(1)}s`);
    const { dir, screenshotErrors } = await writeReport(result, flags.output, flags.format);
    printSummary(
      result,
      dir,
      mergeScreenshotErrors(result.screenshotErrors, screenshotErrors),
      flags.verbose,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Executable doesn't exist") || message.includes('browserType.launch')) {
      console.error(
        '\nError: Playwright browser not installed. Run:  npx playwright install chromium',
      );
    } else {
      console.error(`\nExploration failed: ${message}`);
    }
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('cli.ts') || process.argv[1].endsWith('cli.js'));

if (isDirectRun) {
  main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exitCode = 1;
  });
}
