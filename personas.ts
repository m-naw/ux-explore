// personas.ts
// Persona YAML loading and schema validation.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { FACT_KEYS, type Facts, type PersonaProfile, type ReadingLevel } from './engine/types';

export const PERSONA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'personas');

export class PersonaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersonaValidationError';
  }
}

const TOP_LEVEL_KEYS = [
  'name',
  'description',
  'languages',
  'browserLocale',
  'device',
  'techLiteracy',
  'domainLiteracy',
  'patience',
  'intent',
  'facts',
] as const;

const DEVICES = ['desktop', 'mobile'] as const;
const LEVELS = ['low', 'medium', 'high'] as const;
const READING: readonly ReadingLevel[] = ['none', 'weak', 'ok', 'fluent'];
const BCP47 = /^[a-z]{2}(-[A-Z]{2})?$/;

function fail(label: string, message: string): never {
  throw new PersonaValidationError(`${label}: ${message}`);
}

function requireString(value: unknown, label: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(label, `${field} is required`);
  return value.trim();
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  field: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    if (value === undefined || value === null) fail(label, `${field} is required`);
    fail(label, `${field} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
  }
  return value as T;
}

/** Parse and validate one persona YAML document. `label` prefixes every error message. */
export function parsePersona(source: string, label: string): PersonaProfile {
  let doc: unknown;
  try {
    doc = parse(source);
  } catch (err) {
    fail(label, `is not valid YAML (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof doc !== 'object' || doc === null) fail(label, 'must be a YAML mapping');
  const raw = doc as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      fail(label, `${key} is not a known persona field (allowed: ${TOP_LEVEL_KEYS.join(', ')})`);
    }
  }

  const name = requireString(raw['name'], label, 'name');
  const description = requireString(raw['description'], label, 'description');

  const languagesRaw = raw['languages'];
  if (typeof languagesRaw !== 'object' || languagesRaw === null)
    fail(label, 'languages.native is required');
  const languages = languagesRaw as Record<string, unknown>;
  const native = requireString(languages['native'], label, 'languages.native');

  const readsRaw = languages['reads'];
  if (typeof readsRaw !== 'object' || readsRaw === null) fail(label, 'languages.reads is required');
  const reads: Record<string, ReadingLevel> = {};
  for (const [code, level] of Object.entries(readsRaw as Record<string, unknown>)) {
    reads[code] = requireEnum(level, READING, label, `languages.reads.${code}`);
  }

  const browserLocale = raw['browserLocale'];
  if (
    browserLocale !== undefined &&
    (typeof browserLocale !== 'string' || !BCP47.test(browserLocale))
  ) {
    fail(
      label,
      `browserLocale must look like "pl" or "pl-PL" (got ${JSON.stringify(browserLocale)})`,
    );
  }

  const device = requireEnum(raw['device'], DEVICES, label, 'device');
  const techLiteracy = requireEnum(raw['techLiteracy'], LEVELS, label, 'techLiteracy');
  const domainLiteracy = requireEnum(raw['domainLiteracy'], LEVELS, label, 'domainLiteracy');
  const patience = requireEnum(raw['patience'], LEVELS, label, 'patience');
  const intent = requireEnum(raw['intent'], LEVELS, label, 'intent');

  const factsRaw = raw['facts'] ?? {};
  if (typeof factsRaw !== 'object' || factsRaw === null) fail(label, 'facts must be a mapping');
  const facts: Facts = {};
  for (const [key, value] of Object.entries(factsRaw as Record<string, unknown>)) {
    if (!(FACT_KEYS as readonly string[]).includes(key)) {
      fail(label, `facts.${key} is not a known fact key (allowed: ${FACT_KEYS.join(', ')})`);
    }
    if (typeof value !== 'string') fail(label, `facts.${key} must be a string`);
    facts[key] = value;
  }

  return {
    name,
    description,
    languages: { native, reads },
    ...(typeof browserLocale === 'string' ? { browserLocale } : {}),
    device,
    techLiteracy,
    domainLiteracy,
    patience,
    intent,
    facts,
  };
}

/** Load a persona from a YAML file path. */
export async function loadPersona(filePath: string): Promise<PersonaProfile> {
  let source: string;
  try {
    source = await readFile(filePath, 'utf-8');
  } catch {
    throw new PersonaValidationError(`Persona file not found: ${filePath}`);
  }
  return parsePersona(source, path.basename(filePath));
}
