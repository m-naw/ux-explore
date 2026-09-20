import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  REPORT_MODEL,
  REPORT_MAX_TOKENS,
  REPORT_TIMEOUT_MS,
  REPORT_MAX_RETRIES,
  MAX_SCREENSHOTS,
  SYSTEM_PROMPT,
  reportModel,
  compactRow,
  selectScreenshotRows,
  buildReportContent,
  parseReport,
  generateReport,
  ReportParseError,
} from './report-llm';
import type { Journey, Outcome, TraceRow } from '../engine/types';

const OUTCOME: Outcome = {
  urlChanged: true,
  stateChanged: true,
  consoleErrors: [],
  failedRequests: [],
  validationMessages: [],
  durationMs: 40,
};

function row(overrides: Partial<TraceRow>): TraceRow {
  return {
    step: 1,
    timestamp: 0,
    url: 'https://dopomo.pl/pl',
    stateHash: 'h1',
    viewHash: 'v1',
    viewport: { width: 1280, height: 720 },
    elementsCount: 12,
    droppedElements: 3,
    options: [],
    distribution: { a: 0.5, b: 0.3, c: 0.15, d: 0.05 },
    pruned: { a: 0.5, b: 0.3, c: 0.15, d: 0.05 },
    sampled: 'a',
    sampledName: 'Karta CUKR',
    argmax: 'a',
    exploration: false,
    confidence: 0.5,
    entropy: 1.7,
    goalMet: 0.1,
    confusion: 1,
    outcome: OUTCOME,
    timing: { extractMs: 90, decideMs: 320, decideRetryMs: 0, executeMs: 210, settleMs: 300 },
    flags: [],
    bucket: 'none',
    stateChars: 4200,
    inputTokens: 1400,
    visibleTextChars: 0,
    seenTextChars: 0,
    scrollOnly: false,
    ...overrides,
  };
}

function journey(rows: TraceRow[], toolIssues: TraceRow[] = []): Journey {
  return {
    summary: {
      runId: 'run-1',
      persona: { name: 'Olena' },
      browserLocale: 'uk-UA',
      device: 'mobile',
      seed: 1,
      outcome: {
        needMet: false,
        gaveUp: false,
        left: false,
        believedDone: false,
        reason: 'step budget exhausted',
        bucket: 'ux',
        totalSteps: rows.length,
        totalDurationMs: 9000,
        outcomeFindings: [],
      },
      perUrl: [],
    },
    rows,
    toolIssues,
  };
}

const PERSONA = {
  name: 'Olena',
  description: 'Ukrainian, phone only.',
  languages: { native: 'uk', reads: { uk: 'fluent' as const, pl: 'weak' as const } },
  device: 'mobile' as const,
  techLiteracy: 'low' as const,
  domainLiteracy: 'low' as const,
  patience: 'low' as const,
  intent: 'high' as const,
  facts: {},
};

afterEach(() => {
  delete process.env['UX_EXPLORE_REPORT_MODEL'];
});

describe('reportModel', () => {
  it('defaults to the single model constant and honours the env override', () => {
    expect(REPORT_MODEL).toBe('claude-sonnet-5');
    expect(reportModel()).toBe('claude-sonnet-5');
    process.env['UX_EXPLORE_REPORT_MODEL'] = 'claude-sonnet-5-test';
    expect(reportModel()).toBe('claude-sonnet-5-test');
  });
});

describe('compactRow', () => {
  it('keeps only the top three pruned probabilities', () => {
    const compact = compactRow(row({}));
    expect(Object.keys(compact.topPruned)).toEqual(['a', 'b', 'c']);
    expect(compact.step).toBe(1);
    expect(compact.sampledName).toBe('Karta CUKR');
  });

  it('carries where the step landed, so the model cannot invent a loop', () => {
    const compact = compactRow(
      row({ url: 'https://dopomo.pl/uk', nextUrl: 'https://dopomo.pl/uk/register?step=1' }),
    );
    expect(compact.nextUrl).toBe('https://dopomo.pl/uk/register?step=1');
    expect(compact.urlChanged).toBe(true);
  });

  it('omits nextUrl on a step that never got to act', () => {
    expect(compactRow(row({})).nextUrl).toBeUndefined();
  });
});

describe('selectScreenshotRows', () => {
  it('takes flagged rows with screenshots, at most eight', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ step: i + 1, flags: ['confused'], screenshotPath: `/tmp/step-${i + 1}.jpg` }),
    );
    rows.push(row({ step: 99, flags: [], screenshotPath: '/tmp/clean.jpg' }));
    const picked = selectScreenshotRows(rows);
    expect(picked).toHaveLength(MAX_SCREENSHOTS);
    expect(picked.every((r) => r.flags.length > 0)).toBe(true);
  });

  it('never sends a screenshot of a tool or stale step', () => {
    const picked = selectScreenshotRows([
      row({ step: 1, flags: ['failed-action'], bucket: 'tool', screenshotPath: '/tmp/1.jpg' }),
      row({ step: 2, flags: ['failed-action'], bucket: 'stale', screenshotPath: '/tmp/2.jpg' }),
      row({ step: 3, flags: ['confused'], bucket: 'ux', screenshotPath: '/tmp/3.jpg' }),
    ]);
    expect(picked.map((r) => r.step)).toEqual([3]);
  });
});

describe('buildReportContent', () => {
  it('keeps tool and stale rows out of the findings input and sends them separately', () => {
    const content = buildReportContent({
      persona: PERSONA,
      goal: 'Get a CUKR card',
      journey: journey([row({})], [row({ step: 2, bucket: 'tool', sampledName: 'broken' })]),
      screenshots: [{ step: 1, base64: 'AAAA' }],
    });
    const text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    expect(text).toContain('Get a CUKR card');
    expect(text).toContain('Karta CUKR');
    expect(text).toContain('toolIssues');
    expect(content.some((b) => b.type === 'image')).toBe(true);
    // The instructions live in `system`, not in the user turn.
    expect(text).not.toContain(SYSTEM_PROMPT);
  });
});

const VALID_FINDING = {
  findingId: 'f1',
  category: 'navigation',
  severity: 'high',
  confidence: 'medium',
  bucket: 'ux',
  issue: 'i',
  evidence: 'e',
  evidenceSteps: [1],
  recommendation: 'r',
  analyticsCheck: 'a',
};

function textMessage(body: unknown, overrides: Record<string, unknown> = {}) {
  return {
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: 'internal' },
      { type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body) },
    ],
    ...overrides,
  };
}

describe('parseReport', () => {
  it('parses the text block as JSON, past a thinking block', () => {
    const message = textMessage({
      narrative: '# Olena\nShe stalled.',
      findings: [VALID_FINDING],
    });
    const out = parseReport(message as never);
    expect(out.narrative).toContain('She stalled.');
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]!.bucket).toBe('ux');
  });

  it('throws when there is no text block', () => {
    expect(() =>
      parseReport({
        stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: 'x' }],
      } as never),
    ).toThrow(/no text block/i);
  });

  it('throws a typed error naming the refusal, including stop_details.category when present', () => {
    const message = {
      stop_reason: 'refusal',
      stop_details: { category: 'dangerous_content' },
      content: [{ type: 'text', text: '' }],
    };
    expect(() => parseReport(message as never)).toThrow(ReportParseError);
    expect(() => parseReport(message as never)).toThrow(/refus/i);
    expect(() => parseReport(message as never)).toThrow(/dangerous_content/);
  });

  it('throws a typed error naming the refusal when stop_details is absent', () => {
    const message = { stop_reason: 'refusal', content: [{ type: 'text', text: '' }] };
    expect(() => parseReport(message as never)).toThrow(ReportParseError);
    expect(() => parseReport(message as never)).toThrow(/refus/i);
  });

  it('throws a typed error saying the report was truncated on max_tokens', () => {
    const message = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{}' }] };
    expect(() => parseReport(message as never)).toThrow(ReportParseError);
    expect(() => parseReport(message as never)).toThrow(/truncat/i);
  });

  it('throws a typed error on invalid JSON text', () => {
    const message = textMessage('not json {');
    expect(() => parseReport(message as never)).toThrow(ReportParseError);
    expect(() => parseReport(message as never)).toThrow(/json/i);
  });

  it('throws a typed error when the top level is not an object', () => {
    const message = textMessage(['narrative', 'findings']);
    expect(() => parseReport(message as never)).toThrow(ReportParseError);
    expect(() => parseReport(message as never)).toThrow(/object/i);
  });

  it('throws a typed error when narrative is missing', () => {
    const message = textMessage({ findings: [] });
    expect(() => parseReport(message as never)).toThrow(ReportParseError);
    expect(() => parseReport(message as never)).toThrow(/narrative/i);
  });

  it('throws a typed error when narrative is not a string', () => {
    const message = textMessage({ narrative: 42, findings: [] });
    expect(() => parseReport(message as never)).toThrow(ReportParseError);
    expect(() => parseReport(message as never)).toThrow(/narrative/i);
  });

  it('throws a typed error when findings is not an array', () => {
    const message = textMessage({ narrative: 'n', findings: 'nope' });
    expect(() => parseReport(message as never)).toThrow(ReportParseError);
    expect(() => parseReport(message as never)).toThrow(/findings/i);
  });

  it('throws a typed error when a finding is missing a required field', () => {
    const { analyticsCheck: _analyticsCheck, ...incomplete } = VALID_FINDING;
    const message = textMessage({ narrative: 'n', findings: [incomplete] });
    expect(() => parseReport(message as never)).toThrow(ReportParseError);
    expect(() => parseReport(message as never)).toThrow(/analyticsCheck/);
  });

  it('throws a typed error when evidenceSteps is not an array of integers', () => {
    for (const bad of ['1', [1, 'two'], [1.5], null]) {
      const message = textMessage({
        narrative: 'n',
        findings: [{ ...VALID_FINDING, evidenceSteps: bad }],
      });
      expect(() => parseReport(message as never)).toThrow(ReportParseError);
      expect(() => parseReport(message as never)).toThrow(/evidenceSteps/);
    }
  });

  it('throws a typed error when a finding has an invalid enum value', () => {
    const message = textMessage({
      narrative: 'n',
      findings: [{ ...VALID_FINDING, severity: 'urgent' }],
    });
    expect(() => parseReport(message as never)).toThrow(ReportParseError);
    expect(() => parseReport(message as never)).toThrow(/severity/i);
  });
});

describe('SYSTEM_PROMPT evidence rules', () => {
  it('forbids loop and no-navigation claims the rows do not support', () => {
    expect(SYSTEM_PROMPT).toMatch(/nextUrl/);
    expect(SYSTEM_PROMPT).toMatch(/loop/i);
    expect(SYSTEM_PROMPT).toMatch(/evidenceSteps/);
  });
});

/** A fake report client that returns exactly these findings. */
function clientReturning(findings: unknown[]) {
  const finalMessage = vi.fn(async () => ({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({ narrative: 'n', findings }) }],
  }));
  return { messages: { stream: vi.fn(() => ({ finalMessage })) } } as never;
}

const PRODUCT_FINDING = {
  ...VALID_FINDING,
  bucket: 'product',
  confidence: 'high',
  evidenceSteps: [1],
};

describe('generateReport evidence validation', () => {
  it('drops a finding whose evidenceSteps do not exist in the trace', async () => {
    const client = clientReturning([
      VALID_FINDING,
      { ...VALID_FINDING, findingId: 'f2', evidenceSteps: [1, 9] },
    ]);
    const out = await generateReport(
      { persona: PERSONA, goal: 'g', journey: journey([row({ step: 1 })]), screenshots: [] },
      { client },
    );
    expect(out.findings.map((f) => f.findingId)).toEqual(['f1']);
    expect(out.droppedFindings).toBe(1);
  });

  it('drops a finding that cites no evidence at all', async () => {
    const client = clientReturning([{ ...VALID_FINDING, evidenceSteps: [] }]);
    const out = await generateReport(
      { persona: PERSONA, goal: 'g', journey: journey([row({ step: 1 })]), screenshots: [] },
      { client },
    );
    expect(out.findings).toEqual([]);
    expect(out.droppedFindings).toBe(1);
    expect(out.downgradedFindings).toBe(0);
  });

  it('downgrades a product finding whose evidence carries no product signal', async () => {
    const client = clientReturning([PRODUCT_FINDING]);
    // `no-change` and `validation-error` alone are not product signals.
    const rows = [row({ step: 1, bucket: 'ux', flags: ['no-change', 'validation-error'] })];
    const out = await generateReport(
      { persona: PERSONA, goal: 'g', journey: journey(rows), screenshots: [] },
      { client },
    );
    expect(out.droppedFindings).toBe(0);
    expect(out.findings[0]!.bucket).toBe('ux');
    expect(out.findings[0]!.confidence).toBe('low');
  });

  it('keeps a product finding backed by a product row, console errors or failed requests', async () => {
    const backings = [
      row({ step: 1, bucket: 'product' }),
      row({ step: 1, bucket: 'ux', outcome: { ...OUTCOME, consoleErrors: ['boom'] } }),
      row({ step: 1, bucket: 'ux', outcome: { ...OUTCOME, failedRequests: ['/x (500)'] } }),
    ];
    for (const backing of backings) {
      const out = await generateReport(
        { persona: PERSONA, goal: 'g', journey: journey([backing]), screenshots: [] },
        { client: clientReturning([PRODUCT_FINDING]) },
      );
      expect(out.findings[0]!.bucket).toBe('product');
      expect(out.findings[0]!.confidence).toBe('high');
    }
  });
});

describe('generateReport', () => {
  it('streams one request with the spec parameters, a system prompt and no assistant prefill', async () => {
    const finalMessage = vi.fn(async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ narrative: 'n', findings: [] }) }],
    }));
    const stream = vi.fn((_body: Record<string, unknown>, _options?: Record<string, unknown>) => ({
      finalMessage,
    }));
    const client = { messages: { stream } } as never;

    const out = await generateReport(
      { persona: PERSONA, goal: 'g', journey: journey([row({})]), screenshots: [] },
      { client },
    );

    expect(out.narrative).toBe('n');
    expect(out.findings).toEqual([]);
    // The call is measured so a slow report is visible next to the step timings.
    expect(typeof out.reportMs).toBe('number');
    expect(out.reportMs).toBeGreaterThanOrEqual(0);
    expect(stream).toHaveBeenCalledTimes(1);
    const [body, options] = stream.mock.calls[0]!;
    expect(body['model']).toBe(REPORT_MODEL);
    expect(body['max_tokens']).toBe(REPORT_MAX_TOKENS);
    expect(body['thinking']).toEqual({ type: 'adaptive' });
    expect(body['system']).toBe(SYSTEM_PROMPT);
    const outputConfig = body['output_config'] as { format: { type: string }; effort: string };
    expect(outputConfig.format.type).toBe('json_schema');
    expect(outputConfig.effort).toBe('medium');
    const messages = body['messages'] as Array<{ role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
    expect(options).toEqual({ timeout: REPORT_TIMEOUT_MS, maxRetries: REPORT_MAX_RETRIES });
  });
});
