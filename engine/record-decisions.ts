// engine/record-decisions.ts
// Per-step decide inputs written to disk for scripts/bench-decide.ts.
// Enabled only by `--record-decisions`; the files land under `reports/`, which is gitignored.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Element as UxElement,
  HistoryEntry,
  Option,
  OptionId,
  PageState,
  PersonaProfile,
  RunIssue,
} from './types';

/**
 * One step, replayable offline and completely: everything `buildRequest` reads is here, so a
 * benchmark can rebuild the identical Jev request and hand the identical text to any other
 * model. `stateText` is kept alongside so a replay can be asserted byte-identical rather than
 * assumed to be.
 */
export interface RecordedDecision {
  runId: string;
  step: number;
  /** The profile as rendered, with `facts` emptied — see `writeDecisionRecord`. */
  persona: PersonaProfile;
  goal: string;
  /** The full page state, including `meta.visibleText`, `meta.belowFoldTextChars` and elements. */
  state: PageState;
  options: Option[];
  history: HistoryEntry[];
  repeats: string[];
  seenText: string[];
  /** Exactly what `renderStateText` produced for this step. */
  stateText: string;
  /** The live Jev distribution, kept as the reference the bench compares its own calls to. */
  jevDistribution: Record<OptionId, number>;
}

/** `step-01.json`, so `readdir().sort()` is already in step order. */
export function decisionFileName(step: number): string {
  return `step-${String(step).padStart(2, '0')}.json`;
}

/** Drops a filled control's current value, which is a persona fact once one has been typed in. */
function redactElement(el: UxElement): UxElement {
  return el.value === undefined ? el : { ...el, value: undefined };
}

/**
 * Drops a persona fact from one option: a `type:` option's `value` is the fact itself, and its
 * description quotes it verbatim (`type "…" into …`); an element option's description carries
 * the same fact through the `(filled: "…")` fragment `describeOption` appends. Both become
 * generic markers so the shape of the record survives without the fact.
 */
function redactOption(option: Option): Option {
  if (option.kind === 'type' && option.value !== undefined) {
    return {
      ...option,
      value: undefined,
      description: option.description.replace(`"${option.value}"`, '(filled)'),
    };
  }
  if (option.description.includes('(filled: "')) {
    return {
      ...option,
      description: option.description.replace(/\(filled: "[^"]*"\)/, '(filled)'),
    };
  }
  return option;
}

/**
 * Write one step's record. `persona.facts` is emptied first: facts are never rendered into the
 * state text and never reach a decide engine, so recording them would put a fake identity on
 * disk for no benchmark benefit. Dropping them cannot change a replay. The same facts can still
 * leak in through a filled control's `value` or a `(filled: "…")`/`type "…"` description, so
 * `state.elements` and `options` are redacted too before anything is written.
 */
export async function writeDecisionRecord(dir: string, record: RecordedDecision): Promise<void> {
  const safe: RecordedDecision = {
    ...record,
    persona: { ...record.persona, facts: {} },
    state: { ...record.state, elements: record.state.elements.map(redactElement) },
    options: record.options.map(redactOption),
  };
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, decisionFileName(safe.step)),
    `${JSON.stringify(safe, null, 2)}\n`,
    'utf-8',
  );
}

/**
 * Write one step's record, converting any failure (an unwritable directory, a full disk) into
 * a `record-failed` RunIssue instead of letting it escape. Recording is a benchmark
 * convenience, never a reason to lose a step or the journey it belongs to, so the caller only
 * needs to decide what to do with the issue, never to catch anything itself.
 */
export async function writeDecisionRecordSafely(
  dir: string,
  record: RecordedDecision,
): Promise<RunIssue | undefined> {
  try {
    await writeDecisionRecord(dir, record);
    return undefined;
  } catch (err) {
    return {
      kind: 'record-failed',
      step: record.step,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
