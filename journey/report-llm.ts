// journey/report-llm.ts
// The single Claude Sonnet call that turns a journey into findings and a narrative.

import Anthropic from '@anthropic-ai/sdk';
import type { Finding, Journey, PersonaProfile, TraceRow } from '../engine/types';

/**
 * Reasoning effort for the report call. `medium` is what the journey needs: the trace is
 * already reduced to compact rows, so the model is reading evidence rather than searching.
 */
export const REPORT_EFFORT = 'medium' as const;

/** The one place the report model id lives. */
export const REPORT_MODEL = 'claude-sonnet-5';
export const REPORT_MAX_TOKENS = 16_000;
export const REPORT_TIMEOUT_MS = 120_000;
export const REPORT_MAX_RETRIES = 2;
export const MAX_SCREENSHOTS = 8;

export function reportModel(): string {
  return process.env['UX_EXPLORE_REPORT_MODEL'] ?? REPORT_MODEL;
}

export const SYSTEM_PROMPT = [
  'You analyse a recorded synthetic-persona journey through a website and produce UX findings.',
  'Every finding must be anchored to a measured signal in the trace, cited by step number in evidenceSteps.',
  'Do not produce findings for the toolIssues rows: those are harness problems, not site problems.',
  'Bucket a finding `product` when the site errored or did nothing, `ux` when the persona could read',
  'the page but could not act on it, and `persona` when the persona lacked information a real user',
  'would have had. `analyticsCheck` names the real-analytics number that would confirm the finding.',
  '',
  'Evidence rules, which override any impression the narrative gives you:',
  '1. Never claim that the persona looped, went back to the same page, got no navigation, or that',
  '   a page or element "reappears", unless the rows you cite show it: read each cited row\'s `url`,',
  '   `nextUrl` and `urlChanged`. A row whose `nextUrl` differs from its `url` navigated, whatever',
  '   the page looked like afterwards.',
  '2. A finding bucketed `product` must cite at least one row that carries a product signal: bucket',
  '   `product`, a non-empty `outcome.consoleErrors`, or a non-empty `outcome.failedRequests`. The',
  '   flags `no-change` and `validation-error` are not product signals on their own; bucket such a',
  '   finding `ux` instead.',
  '3. Every finding must cite evidenceSteps, and every step number it cites must be the `step` of a',
  '   row that is actually in the trace. Never cite a step you did not see.',
  '',
  'Write the narrative in the persona voice, in markdown.',
].join('\n');

export const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    narrative: {
      type: 'string',
      description: 'Markdown narrative of the journey from the persona point of view.',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          findingId: { type: 'string' },
          category: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          bucket: { type: 'string', enum: ['product', 'ux', 'persona'] },
          issue: { type: 'string' },
          evidence: { type: 'string' },
          evidenceSteps: { type: 'array', items: { type: 'integer' } },
          recommendation: { type: 'string' },
          analyticsCheck: { type: 'string' },
        },
        required: [
          'findingId',
          'category',
          'severity',
          'confidence',
          'bucket',
          'issue',
          'evidence',
          'evidenceSteps',
          'recommendation',
          'analyticsCheck',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['narrative', 'findings'],
  additionalProperties: false,
} as const;

export interface CompactRow {
  step: number;
  url: string;
  sampledName: string;
  sampledHref?: string;
  topPruned: Record<string, number>;
  exploration: boolean;
  confidence: number;
  entropy: number;
  goalMet: number;
  confusion: number;
  outcome: TraceRow['outcome'];
  flags: TraceRow['flags'];
  bucket: TraceRow['bucket'];
  droppedElements: number;
  /** How much page copy the persona could actually read this step. */
  visibleTextChars: number;
  seenTextChars: number;
  /** URL after the action. Absent on a step that never got to act. */
  nextUrl?: string;
  /** Repeated out of `outcome` so "did this step navigate?" sits next to `url`/`nextUrl`. */
  urlChanged: boolean;
  missingFactLabel?: string;
}

/** Trace row with `pruned` reduced to its top three entries. */
export function compactRow(row: TraceRow): CompactRow {
  const topPruned: Record<string, number> = {};
  for (const [id, p] of Object.entries(row.pruned)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)) {
    topPruned[id] = p;
  }
  return {
    step: row.step,
    url: row.url,
    sampledName: row.sampledName,
    ...(row.sampledHref ? { sampledHref: row.sampledHref } : {}),
    topPruned,
    exploration: row.exploration,
    confidence: row.confidence,
    entropy: row.entropy,
    goalMet: row.goalMet,
    confusion: row.confusion,
    outcome: row.outcome,
    flags: row.flags,
    bucket: row.bucket,
    droppedElements: row.droppedElements,
    visibleTextChars: row.visibleTextChars,
    seenTextChars: row.seenTextChars,
    // Without these the model cannot see where a step landed, and read a CTA that navigated
    // to /uk/register as one that "loops back" to the page it started on.
    ...(row.nextUrl ? { nextUrl: row.nextUrl } : {}),
    urlChanged: row.outcome.urlChanged,
    ...(row.missingFactLabel ? { missingFactLabel: row.missingFactLabel } : {}),
  };
}

/**
 * Flagged rows that have a screenshot, at most MAX_SCREENSHOTS.
 * Tool and stale rows are excluded: the model is forbidden to write findings about them,
 * so sending their pictures would only waste tokens and invite a rule violation.
 */
export function selectScreenshotRows(rows: TraceRow[]): TraceRow[] {
  return rows
    .filter(
      (r) => r.flags.length > 0 && r.screenshotPath && r.bucket !== 'tool' && r.bucket !== 'stale',
    )
    .slice(0, MAX_SCREENSHOTS);
}

export interface ReportInput {
  persona: PersonaProfile;
  goal: string;
  journey: Journey;
  /** Viewport JPEGs for the flagged steps, already base64 encoded. */
  screenshots: Array<{ step: number; base64: string }>;
}

/** What the model's JSON body carries, before the call itself is measured. */
export interface ParsedReport {
  narrative: string;
  findings: Finding[];
}

export interface ReportOutput extends ParsedReport {
  /** Wall-clock milliseconds the single report call took, logged by the CLI under `--verbose`. */
  reportMs: number;
  /** Findings thrown away by `applyEvidenceRules` because they cited steps that do not exist. */
  droppedFindings: number;
  /** Findings `applyEvidenceRules` moved out of the `product` bucket for lack of evidence. */
  downgradedFindings: number;
}

/**
 * Does this row carry a signal that makes a `product` finding legitimate? `no-change` and `validation-error` do not qualify on their own: a tap that
 * changed nothing can equally be an overlay the harness left standing or a form the persona
 * filled wrong, and calling that a site defect is how the report invented product bugs.
 */
function hasProductSignal(row: TraceRow): boolean {
  return (
    row.bucket === 'product' ||
    row.outcome.consoleErrors.length > 0 ||
    row.outcome.failedRequests.length > 0
  );
}

export interface EvidenceCheckedFindings {
  findings: Finding[];
  droppedFindings: number;
  downgradedFindings: number;
}

/**
 * Hold the model to the evidence rules its system prompt states, because a prompt is not an
 * enforcement mechanism. A finding citing no steps, or a step that is not in the trace, is
 * unverifiable and goes; a `product` finding whose own evidence shows no product signal is kept, but as a
 * low-confidence `ux` finding, which is what the rows actually support.
 *
 * `toolIssues` steps count as existing — the model is sent them, labelled — but never as
 * product evidence, since the model may not write findings about them at all.
 */
export function applyEvidenceRules(findings: Finding[], journey: Journey): EvidenceCheckedFindings {
  const byStep = new Map(journey.rows.map((r) => [r.step, r]));
  const knownSteps = new Set<number>([...byStep.keys(), ...journey.toolIssues.map((r) => r.step)]);

  const kept: Finding[] = [];
  let droppedFindings = 0;
  let downgradedFindings = 0;

  for (const finding of findings) {
    // A finding with no evidence at all cannot be checked against the trace, and the system
    // prompt requires every finding to cite the rows it rests on.
    if (
      finding.evidenceSteps.length === 0 ||
      finding.evidenceSteps.some((step) => !knownSteps.has(step))
    ) {
      droppedFindings += 1;
      continue;
    }
    const evidence = finding.evidenceSteps
      .map((step) => byStep.get(step))
      .filter((r): r is TraceRow => !!r);
    if (finding.bucket === 'product' && !evidence.some(hasProductSignal)) {
      kept.push({ ...finding, bucket: 'ux', confidence: 'low' });
      downgradedFindings += 1;
      continue;
    }
    kept.push(finding);
  }

  return { findings: kept, droppedFindings, downgradedFindings };
}

export function buildReportContent(input: ReportInput): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [
    {
      type: 'text',
      text: [
        `Persona: ${input.persona.name} (${input.persona.device}, native ${input.persona.languages.native})`,
        input.persona.description.trim(),
        '',
        `Goal: ${input.goal}`,
        '',
        'Journey summary:',
        JSON.stringify(input.journey.summary, null, 2),
        '',
        'Trace rows:',
        JSON.stringify(input.journey.rows.map(compactRow), null, 2),
        '',
        'toolIssues (harness problems, excluded from findings):',
        JSON.stringify(input.journey.toolIssues.map(compactRow), null, 2),
      ].join('\n'),
    },
  ];

  for (const shot of input.screenshots) {
    blocks.push({ type: 'text', text: `Screenshot of step ${shot.step}:` });
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: shot.base64 },
    });
  }

  return blocks;
}

/** Thrown when the report response does not have the shape a Finding report requires. */
export class ReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportParseError';
  }
}

const FINDING_FIELDS: Array<keyof Finding> = [
  'findingId',
  'category',
  'severity',
  'confidence',
  'bucket',
  'issue',
  'evidence',
  'evidenceSteps',
  'recommendation',
  'analyticsCheck',
];

const SEVERITY_VALUES: Finding['severity'][] = ['low', 'medium', 'high'];
const CONFIDENCE_VALUES: Finding['confidence'][] = ['low', 'medium', 'high'];
const BUCKET_VALUES: Finding['bucket'][] = ['product', 'ux', 'persona'];

function assertFinding(value: unknown, index: number): asserts value is Finding {
  if (typeof value !== 'object' || value === null) {
    throw new ReportParseError(`Report finding ${index} is not an object`);
  }
  for (const field of FINDING_FIELDS) {
    if (!(field in value)) {
      throw new ReportParseError(`Report finding ${index} is missing field "${field}"`);
    }
  }
  const finding = value as Record<string, unknown>;
  if (!SEVERITY_VALUES.includes(finding['severity'] as Finding['severity'])) {
    throw new ReportParseError(
      `Report finding ${index} has invalid severity "${String(finding['severity'])}"`,
    );
  }
  if (!CONFIDENCE_VALUES.includes(finding['confidence'] as Finding['confidence'])) {
    throw new ReportParseError(
      `Report finding ${index} has invalid confidence "${String(finding['confidence'])}"`,
    );
  }
  if (!BUCKET_VALUES.includes(finding['bucket'] as Finding['bucket'])) {
    throw new ReportParseError(
      `Report finding ${index} has invalid bucket "${String(finding['bucket'])}"`,
    );
  }
  // The evidence rules are step lookups, so anything but whole step numbers is unusable.
  const steps = finding['evidenceSteps'];
  if (
    !Array.isArray(steps) ||
    !steps.every((step) => typeof step === 'number' && Number.isInteger(step))
  ) {
    throw new ReportParseError(
      `Report finding ${index} has an evidenceSteps that is not an array of integers`,
    );
  }
}

/**
 * Rejects a message whose `stop_reason` means the content is not a usable report:
 * a `refusal` never produced findings, and `max_tokens` means the JSON is truncated
 * and would fail (or silently corrupt) parsing. Only `end_turn` (and the streaming
 * `null` placeholder, which `finalMessage()` never actually returns) proceed to parse.
 */
function assertUsableStopReason(message: Anthropic.Message): void {
  const stopReason = message.stop_reason;
  if (stopReason === null || stopReason === 'end_turn') return;
  if (stopReason === 'refusal') {
    const category = (message as unknown as { stop_details?: { category?: unknown } }).stop_details
      ?.category;
    throw new ReportParseError(
      `Report request was refused by the model${typeof category === 'string' ? ` (category: ${category})` : ''}`,
    );
  }
  if (stopReason === 'max_tokens') {
    throw new ReportParseError(
      'Report response was truncated: stop_reason was "max_tokens" before the model finished the report',
    );
  }
  throw new ReportParseError(`Report response ended with unexpected stop_reason "${stopReason}"`);
}

export function parseReport(message: Anthropic.Message): ParsedReport {
  assertUsableStopReason(message);

  const block = message.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text')
    throw new ReportParseError('Report response contained no text block');

  let parsed: unknown;
  try {
    parsed = JSON.parse(block.text);
  } catch (err) {
    throw new ReportParseError(
      `Report response text was not valid JSON: ${(err as Error).message}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ReportParseError('Report response JSON was not a plain object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['narrative'] !== 'string') {
    throw new ReportParseError('Report response is missing a string "narrative"');
  }
  if (!Array.isArray(obj['findings'])) {
    throw new ReportParseError('Report response "findings" is not an array');
  }
  obj['findings'].forEach((f, i) => assertFinding(f, i));

  return { narrative: obj['narrative'], findings: obj['findings'] as Finding[] };
}

export function createReportClient(): Anthropic {
  return new Anthropic();
}

export interface ReportDeps {
  client?: Pick<Anthropic, 'messages'>;
}

/** One streamed Sonnet call per journey. Sonnet is never called per step and never steers. */
export async function generateReport(
  input: ReportInput,
  deps: ReportDeps = {},
): Promise<ReportOutput> {
  const client = deps.client ?? createReportClient();
  const started = performance.now();
  const message = await client.messages
    .stream(
      {
        model: reportModel(),
        max_tokens: REPORT_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        thinking: { type: 'adaptive' },
        output_config: {
          format: {
            type: 'json_schema',
            schema: REPORT_SCHEMA as unknown as Record<string, unknown>,
          },
          effort: REPORT_EFFORT,
        },
        messages: [{ role: 'user', content: buildReportContent(input) }],
      } as Anthropic.MessageStreamParams,
      { timeout: REPORT_TIMEOUT_MS, maxRetries: REPORT_MAX_RETRIES },
    )
    .finalMessage();
  const reportMs = Math.round(performance.now() - started);
  const parsed = parseReport(message);
  const checked = applyEvidenceRules(parsed.findings, input.journey);
  return {
    narrative: parsed.narrative,
    findings: checked.findings,
    droppedFindings: checked.droppedFindings,
    downgradedFindings: checked.downgradedFindings,
    reportMs,
  };
}
