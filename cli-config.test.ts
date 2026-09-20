import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { parseCliFlags, validateFlags, buildConfig, USAGE } from './cli-config';
import { PERSONA_DIR } from './personas';

const OLENA = path.join(PERSONA_DIR, 'olena.yaml');

describe('parseCliFlags', () => {
  it('parses every supported flag and rejects the removed ones', () => {
    const flags = parseCliFlags([
      '--url',
      'https://dopomo.pl',
      '--need',
      'Get a CUKR card',
      '--persona',
      OLENA,
      '--max-steps',
      '25',
      '--seed',
      '4',
      '--success-url',
      '/signup$',
      '--success-text',
      'Załóż konto',
      '--output',
      './out/',
      '--format',
      'json',
      '--verbose',
      '--no-screenshots',
    ]);
    expect(flags.url).toBe('https://dopomo.pl');
    expect(flags['max-steps']).toBe(25);
    expect(flags.seed).toBe(4);
    expect(flags['success-url']).toBe('/signup$');
    expect(flags.format).toBe('json');
    expect(flags.verbose).toBe(true);
    expect(flags['no-screenshots']).toBe(true);

    expect(() => parseCliFlags(['--url', 'x', '--perception', 'hybrid'])).toThrow();
    expect(() => parseCliFlags(['--url', 'x', '--arrival', 'targeted'])).toThrow();
    expect(() => parseCliFlags(['--url', 'x', '--translator-model', 'y'])).toThrow();
    expect(() => parseCliFlags(['--url', 'x', '--analyzer-model', 'y'])).toThrow();
  });

  it('defaults max-steps to 25, seed to 1 and format to yaml', () => {
    const flags = parseCliFlags(['--url', 'https://x.test', '--need', 'n', '--persona', OLENA]);
    expect(flags['max-steps']).toBe(25);
    expect(flags.seed).toBe(1);
    expect(flags.format).toBe('yaml');
  });

  it('rejects a non-numeric or non-positive max-steps', () => {
    expect(() => parseCliFlags(['--url', 'x', '--max-steps', 'many'])).toThrow(/--max-steps/);
    expect(() => parseCliFlags(['--url', 'x', '--max-steps', '0'])).toThrow(/--max-steps/);
  });

  it('documents only the supported flags', () => {
    expect(USAGE).toContain('--success-url');
    expect(USAGE).toContain('--seed');
    expect(USAGE).not.toContain('--perception');
    expect(USAGE).not.toContain('--analyzer-model');
  });
});

describe('validateFlags', () => {
  it('requires url, need and persona', () => {
    expect(validateFlags(parseCliFlags(['--need', 'n', '--persona', OLENA]))).toMatch(/--url/);
    expect(validateFlags(parseCliFlags(['--url', 'https://x.test', '--persona', OLENA]))).toMatch(
      /--need/,
    );
    expect(validateFlags(parseCliFlags(['--url', 'https://x.test', '--need', 'n']))).toMatch(
      /--persona/,
    );
  });

  it('rejects an unparseable url and an invalid success-url regex', () => {
    expect(
      validateFlags(parseCliFlags(['--url', 'not a url', '--need', 'n', '--persona', OLENA])),
    ).toMatch(/Invalid URL/);
    expect(
      validateFlags(
        parseCliFlags([
          '--url',
          'https://x.test',
          '--need',
          'n',
          '--persona',
          OLENA,
          '--success-url',
          '(',
        ]),
      ),
    ).toMatch(/--success-url/);
  });

  it('accepts a complete flag set', () => {
    expect(
      validateFlags(parseCliFlags(['--url', 'https://x.test', '--need', 'n', '--persona', OLENA])),
    ).toBeUndefined();
  });

  it('rejects an empty --success-text', () => {
    expect(
      validateFlags(
        parseCliFlags([
          '--url',
          'https://x.test',
          '--need',
          'n',
          '--persona',
          OLENA,
          '--success-text',
          '',
        ]),
      ),
    ).toMatch(/--success-text/);
  });
});

describe('buildConfig', () => {
  it('loads the persona from the given path and compiles the success regex', async () => {
    const config = await buildConfig(
      parseCliFlags([
        '--url',
        'https://dopomo.pl',
        '--need',
        'Get a CUKR card',
        '--persona',
        OLENA,
        '--success-url',
        '/signup$',
        '--no-screenshots',
      ]),
    );
    expect(config.persona.name).toBe('Olena');
    expect(config.persona.device).toBe('mobile');
    expect(config.engine).toBe('jev');
    // RegExp.prototype.source escapes unescaped "/" so the source could be safely
    // reinterpolated into a literal; the compiled pattern still matches "/signup" at the end.
    expect(config.successUrl?.source).toBe('\\/signup$');
    expect(config.successUrl?.test('https://dopomo.pl/signup')).toBe(true);
    expect(config.screenshots).toBe(false);
    expect(config.maxSteps).toBe(25);
    expect(config.seed).toBe(1);
  });
});

describe('--record-decisions and --no-report', () => {
  const base = ['--url', 'https://x.test', '--need', 'g', '--persona', 'p.yaml'];

  it('defaults to recording nothing and reporting normally', () => {
    const flags = parseCliFlags(base);
    expect(flags['record-decisions']).toBe(false);
    expect(flags['no-report']).toBe(false);
  });

  it('turns recording on and reporting off', () => {
    const flags = parseCliFlags([...base, '--record-decisions', '--no-report']);
    expect(flags['record-decisions']).toBe(true);
    expect(flags['no-report']).toBe(true);
  });

  it('reaches the config', async () => {
    const flags = parseCliFlags([
      '--url',
      'https://x.test',
      '--need',
      'g',
      '--persona',
      path.join(PERSONA_DIR, 'olena.yaml'),
      '--record-decisions',
      '--no-report',
    ]);
    const config = await buildConfig(flags);
    expect(config.recordDecisions).toBe(true);
    expect(config.report).toBe(false);
  });
});
