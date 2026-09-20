import { describe, it, expect, afterEach } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  decisionFileName,
  writeDecisionRecord,
  writeDecisionRecordSafely,
  type RecordedDecision,
} from './record-decisions';
import type { Element as UxElement, PageState, PersonaProfile } from './types';

const PERSONA: PersonaProfile = {
  name: 'Oksana',
  description: 'Tapped an ad.',
  languages: { native: 'uk', reads: { uk: 'fluent' } },
  device: 'mobile',
  techLiteracy: 'medium',
  domainLiteracy: 'low',
  patience: 'low',
  intent: 'low',
  facts: { givenName: 'Oksana', email: 'o@example.com' },
};

const EMAIL_ELEMENT: UxElement = {
  id: 'el_02',
  role: 'textbox',
  name: 'Email',
  inputType: 'email',
  hasValue: true,
  value: 'o@example.com',
  y: 200,
  inViewport: true,
  landmark: 'form',
  sticky: false,
  inAriaLive: false,
  overlay: false,
  dismissesOverlay: false,
  unnamed: false,
  disabled: false,
  match: {
    autocomplete: 'email',
    name: 'email',
    id: '',
    label: 'Email',
    placeholder: '',
    required: true,
  },
};

const STATE: PageState = {
  elements: [EMAIL_ELEMENT],
  meta: {
    url: 'https://dopomo.pl/uk/landing',
    title: 'Landing',
    lang: 'uk',
    scrollY: 0,
    scrollMax: 800,
    viewport: { width: 390, height: 844 },
    h1: 'Landing',
    mainText: 'text',
    visibleText: [{ text: '[h1] Landing', landmark: 'main', inAriaLive: false }],
    visibleTextDigest: '',
    belowFoldTextChars: 420,
    nonResponsive: false,
    validationMessages: [],
    langSwitcher: [],
    droppedElements: 0,
    belowFoldSample: [],
    disabledControls: [],
    skippedFrames: 0,
    closedRoots: 0,
  },
  stateHash: 'hash-a',
  viewHash: 'view-a',
};

const record = (step: number): RecordedDecision => ({
  runId: '2026-09-20T10-00-00-abcd',
  step,
  persona: PERSONA,
  goal: 'Understand what this costs',
  state: STATE,
  options: [
    {
      id: 'el_01',
      kind: 'element',
      description: 'button "Перевірте →" (visible)',
      elementId: 'el_01',
    },
    {
      id: 'el_02',
      kind: 'element',
      description: 'textbox "Email" (visible) (filled: "o@example.com")',
      elementId: 'el_02',
    },
    {
      id: 'type:el_02',
      kind: 'type',
      description: 'type "o@example.com" into textbox "Email"',
      elementId: 'el_02',
      value: 'o@example.com',
    },
  ],
  history: [],
  repeats: [],
  seenText: [],
  stateText: 'You are on https://dopomo.pl/uk/landing',
  jevDistribution: { el_01: 1 },
});

describe('record-decisions', () => {
  it('names files so a lexical sort is a step sort', () => {
    expect(decisionFileName(1)).toBe('step-01.json');
    expect(decisionFileName(12)).toBe('step-12.json');
  });

  it('writes one readable JSON file per step, creating the directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ux-decisions-'));
    const dir = path.join(root, 'run', 'decisions');
    await writeDecisionRecord(dir, record(1));
    await writeDecisionRecord(dir, record(2));

    expect((await readdir(dir)).sort()).toEqual(['step-01.json', 'step-02.json']);
    const parsed = JSON.parse(
      await readFile(path.join(dir, 'step-02.json'), 'utf-8'),
    ) as RecordedDecision;
    expect(parsed.step).toBe(2);
    expect(parsed.persona.name).toBe('Oksana');
    expect(parsed.persona.intent).toBe('low');
    expect(parsed.state.meta.visibleText).toEqual([
      { text: '[h1] Landing', landmark: 'main', inAriaLive: false },
    ]);
    expect(parsed.options[0]!.id).toBe('el_01');
  });

  it('never writes the persona facts to disk', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ux-decisions-'));
    const dir = path.join(root, 'decisions');
    await writeDecisionRecord(dir, record(1));

    const raw = await readFile(path.join(dir, 'step-01.json'), 'utf-8');
    // Facts must not survive anywhere in the record: not in persona.facts, not in a filled
    // element's value, not in a `(filled: "...")` description fragment, and not in a `type:`
    // option's value or description, which otherwise carries the fact in plain text.
    expect(raw).not.toContain('o@example.com');
    const parsed = JSON.parse(raw) as RecordedDecision;
    expect(parsed.persona.facts).toEqual({});
    expect(parsed.state.elements[0]!.value).toBeUndefined();
    expect(parsed.options[1]!.description).toBe('textbox "Email" (visible) (filled)');
    expect(parsed.options[2]!.value).toBeUndefined();
    expect(parsed.options[2]!.description).toBe('type (filled) into textbox "Email"');
  });
});

describe('writeDecisionRecordSafely', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirs.splice(0).map(async (d) => {
        await chmod(d, 0o700).catch(() => {});
        await rm(d, { recursive: true, force: true }).catch(() => {});
      }),
    );
  });

  it('converts a write failure into a record-failed RunIssue instead of throwing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ux-decisions-unwritable-'));
    cleanupDirs.push(root);
    const dir = path.join(root, 'decisions');
    // Step 1 succeeds while the directory is still writable, so the failure below is provably
    // about the write, not about a directory that never existed.
    await writeDecisionRecord(dir, record(1));
    await chmod(dir, 0o500); // read + execute only: no write permission left

    const issue = await writeDecisionRecordSafely(dir, record(2));

    expect(issue?.kind).toBe('record-failed');
    expect(issue?.step).toBe(2);
    expect(issue?.message).toBeTruthy();
    expect((await readdir(dir)).sort()).toEqual(['step-01.json']);
  });

  it('returns undefined when the write succeeds', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ux-decisions-'));
    cleanupDirs.push(root);
    const dir = path.join(root, 'decisions');

    const issue = await writeDecisionRecordSafely(dir, record(1));

    expect(issue).toBeUndefined();
    expect(await readdir(dir)).toEqual(['step-01.json']);
  });
});
