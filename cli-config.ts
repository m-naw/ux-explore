// cli-config.ts
// CLI flag parsing, validation and ExploreConfig building.

import { parseArgs } from 'node:util';
import type { ExploreConfig } from './engine/types';
import { loadPersona } from './personas';

export interface ParsedFlags {
  url: string;
  need: string;
  persona: string;
  'max-steps': number;
  seed: number;
  'success-url'?: string;
  'success-text'?: string;
  output: string;
  format: 'yaml' | 'json';
  verbose: boolean;
  'no-screenshots': boolean;
  'record-decisions': boolean;
  'no-report': boolean;
  help: boolean;
}

export const USAGE = `
Usage: npx tsx cli.ts --url <url> --need <goal> --persona <path/to/persona.yaml> [options]

Setup (first time only):
  npx playwright install chromium
  export TYPESAFE_API_KEY=...     # the Jev decide engine
  export ANTHROPIC_API_KEY=...    # the single Sonnet report call

Options:
  --url <url>             Target site URL (required)
  --need <string>         The persona's goal in plain language (required)
  --persona <path>        Path to a persona YAML file (required)
  --max-steps <n>         Step budget for the journey (default: 25)
  --seed <n>              PRNG seed for sampling (default: 1)
  --success-url <regex>   Journey succeeds when the URL matches this regex
  --success-text <string> Journey succeeds when this text is visible
  --output <dir>          Output directory (default: ./reports/)
  --format <fmt>          Structured output format: yaml|json (default: yaml)
  --verbose               Print each step as it happens
  --no-screenshots        Skip screenshot capture
  --record-decisions      Write decisions/step-NN.json per step, for scripts/bench-decide.ts
  --no-report             Skip the single Sonnet report call (journey and metrics are still
                          written); also drops the ANTHROPIC_API_KEY requirement
  --help                  Show this message

  UX_EXPLORE_REPORT_MODEL overrides the report model id.
`.trim();

export function parseCliFlags(args: string[] = process.argv.slice(2)): ParsedFlags {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: 'string' },
      need: { type: 'string' },
      persona: { type: 'string' },
      'max-steps': { type: 'string', default: '25' },
      seed: { type: 'string', default: '1' },
      'success-url': { type: 'string' },
      'success-text': { type: 'string' },
      output: { type: 'string', default: './reports/' },
      format: { type: 'string', default: 'yaml' },
      verbose: { type: 'boolean', default: false },
      'no-screenshots': { type: 'boolean', default: false },
      'record-decisions': { type: 'boolean', default: false },
      'no-report': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const format = values.format ?? 'yaml';
  if (format !== 'yaml' && format !== 'json') {
    throw new Error(`Invalid --format value "${format}". Must be: yaml, json`);
  }

  const maxSteps = Number.parseInt(values['max-steps'] ?? '25', 10);
  if (Number.isNaN(maxSteps) || maxSteps < 1)
    throw new Error('--max-steps must be a positive integer');

  const seed = Number.parseInt(values.seed ?? '1', 10);
  if (Number.isNaN(seed)) throw new Error('--seed must be an integer');

  return {
    url: values.url ?? '',
    need: values.need ?? '',
    persona: values.persona ?? '',
    'max-steps': maxSteps,
    seed,
    ...(values['success-url'] !== undefined ? { 'success-url': values['success-url'] } : {}),
    ...(values['success-text'] !== undefined ? { 'success-text': values['success-text'] } : {}),
    output: values.output ?? './reports/',
    format,
    verbose: values.verbose ?? false,
    'no-screenshots': values['no-screenshots'] ?? false,
    'record-decisions': values['record-decisions'] ?? false,
    'no-report': values['no-report'] ?? false,
    help: values.help ?? false,
  };
}

export function validateFlags(flags: ParsedFlags): string | undefined {
  if (!flags.url) return 'Missing required flag: --url';
  try {
    new URL(flags.url);
  } catch {
    return `Invalid URL: "${flags.url}". Must be a valid URL (e.g. https://example.com)`;
  }
  if (!flags.need) return 'Missing required flag: --need';
  if (!flags.persona) return 'Missing required flag: --persona <path to a persona YAML file>';
  if (flags['success-text'] !== undefined && flags['success-text'] === '') {
    return 'Invalid --success-text: must not be empty';
  }
  if (flags['success-url'] !== undefined) {
    try {
      new RegExp(flags['success-url']);
    } catch {
      return `Invalid --success-url regex: "${flags['success-url']}"`;
    }
  }
  return undefined;
}

export async function buildConfig(flags: ParsedFlags): Promise<ExploreConfig> {
  return {
    url: flags.url,
    need: flags.need,
    persona: await loadPersona(flags.persona),
    maxSteps: flags['max-steps'],
    seed: flags.seed,
    engine: 'jev',
    ...(flags['success-url'] !== undefined ? { successUrl: new RegExp(flags['success-url']) } : {}),
    ...(flags['success-text'] !== undefined ? { successText: flags['success-text'] } : {}),
    output: flags.output,
    format: flags.format,
    verbose: flags.verbose,
    screenshots: !flags['no-screenshots'],
    recordDecisions: flags['record-decisions'],
    report: !flags['no-report'],
  };
}
