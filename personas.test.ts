import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadPersona, parsePersona, PersonaValidationError, PERSONA_DIR } from './personas';

const GOOD = `
name: Test
description: |
  Line one.
  Line two.
  Line three.
languages: { native: uk, reads: { uk: fluent, pl: weak } }
device: mobile
techLiteracy: low
domainLiteracy: low
patience: low
intent: medium
facts: { givenName: Test, email: t@example.com }
`;

describe('parsePersona', () => {
  it('parses a valid persona', () => {
    const p = parsePersona(GOOD, 'inline');
    expect(p.name).toBe('Test');
    expect(p.description).toContain('Line two.');
    expect(p.languages.reads['pl']).toBe('weak');
    expect(p.device).toBe('mobile');
    expect(p.patience).toBe('low');
    expect(p.facts['givenName']).toBe('Test');
  });

  it('names the bad field when a value is invalid', () => {
    expect(() => parsePersona(GOOD.replace('device: mobile', 'device: tablet'), 'inline')).toThrow(
      /inline: device must be one of desktop, mobile \(got "tablet"\)/,
    );
    expect(() =>
      parsePersona(GOOD.replace('patience: low', 'patience: infinite'), 'inline'),
    ).toThrow(/patience must be one of low, medium, high/);
    expect(() => parsePersona(GOOD.replace('pl: weak', 'pl: rusty'), 'inline')).toThrow(
      /languages\.reads\.pl must be one of none, weak, ok, fluent/,
    );
  });

  it('names the missing field', () => {
    expect(() => parsePersona(GOOD.replace('name: Test\n', ''), 'inline')).toThrow(
      /inline: name is required/,
    );
    expect(() => parsePersona(GOOD.replace(/languages:.*\n/, ''), 'inline')).toThrow(
      /inline: languages\.native is required/,
    );
  });

  it('rejects unknown top-level keys and unknown fact keys', () => {
    expect(() =>
      parsePersona(`${GOOD}\nsystemPrompt: you are a helpful assistant\n`, 'inline'),
    ).toThrow(/inline: systemPrompt is not a known persona field/);
    expect(() =>
      parsePersona(GOOD.replace('email: t@example.com', 'favouriteColour: blue'), 'inline'),
    ).toThrow(/facts\.favouriteColour is not a known fact key/);
  });

  it('validates browserLocale as BCP 47', () => {
    expect(parsePersona(`${GOOD}\nbrowserLocale: pl-PL\n`, 'inline').browserLocale).toBe('pl-PL');
    expect(parsePersona(`${GOOD}\nbrowserLocale: uk\n`, 'inline').browserLocale).toBe('uk');
    expect(() => parsePersona(`${GOOD}\nbrowserLocale: Polish\n`, 'inline')).toThrow(
      /browserLocale must look like "pl" or "pl-PL"/,
    );
  });

  it('is a PersonaValidationError', () => {
    expect(() => parsePersona('name: x', 'inline')).toThrow(PersonaValidationError);
  });

  it('names the fact key when a fact value is not a string', () => {
    expect(() =>
      parsePersona(
        GOOD.replace(
          'facts: { givenName: Test, email: t@example.com }',
          'facts: { givenName: Test, email: t@example.com, pesel: 12345 }',
        ),
        'inline',
      ),
    ).toThrow(/facts\.pesel must be a string/);
  });

  it('names an enum field as required when it is missing entirely', () => {
    expect(() => parsePersona(GOOD.replace('device: mobile\n', ''), 'inline')).toThrow(
      /inline: device is required/,
    );
  });

  it('names languages.reads.pl when its value is not a valid reading level', () => {
    expect(() => parsePersona(GOOD.replace('pl: weak', 'pl: 3'), 'inline')).toThrow(
      /languages\.reads\.pl must be one of none, weak, ok, fluent/,
    );
  });
});

describe('the shipped personas', () => {
  it.each([
    ['olena.yaml', 'Olena', 'uk', 'mobile', 'low'],
    ['dmitry.yaml', 'Dmitry', 'ru', 'desktop', 'low'],
    ['james.yaml', 'James', 'en', 'desktop', 'high'],
    ['anna.yaml', 'Anna', 'pl', 'desktop', 'medium'],
  ])('loads %s', async (file, name, native, device, patience) => {
    const p = await loadPersona(path.join(PERSONA_DIR, file));
    expect(p.name).toBe(name);
    expect(p.languages.native).toBe(native);
    expect(p.device).toBe(device);
    expect(p.patience).toBe(patience);
    expect(p.description.split('\n').filter((l) => l.trim()).length).toBeGreaterThanOrEqual(3);
  });

  it('gives James no Polish and Dmitry workable Polish', async () => {
    const james = await loadPersona(path.join(PERSONA_DIR, 'james.yaml'));
    const dmitry = await loadPersona(path.join(PERSONA_DIR, 'dmitry.yaml'));
    expect(james.languages.reads['pl']).toBe('none');
    expect(dmitry.languages.reads['pl']).toBe('ok');
    expect(dmitry.languages.reads['en']).toBe('fluent');
  });

  it('reports a missing file clearly', async () => {
    await expect(loadPersona(path.join(PERSONA_DIR, 'nobody.yaml'))).rejects.toThrow(
      /Persona file not found/,
    );
  });
});

describe('persona intent', () => {
  const base = `
name: Test
description: A test persona.
languages: { native: uk, reads: { uk: fluent } }
device: mobile
techLiteracy: low
domainLiteracy: low
patience: low
`;

  it('accepts low, medium and high', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      expect(parsePersona(`${base}intent: ${level}\n`, 'test.yaml').intent).toBe(level);
    }
  });

  it('rejects a persona with no intent', () => {
    expect(() => parsePersona(base, 'test.yaml')).toThrow(/intent is required/);
  });

  it('rejects an intent outside the three levels', () => {
    expect(() => parsePersona(`${base}intent: curious\n`, 'test.yaml')).toThrow(
      /intent must be one of low, medium, high/,
    );
  });

  it('loads both ad-clicker fixtures with low intent and low patience', async () => {
    for (const file of ['oksana-ad-clicker.yaml', 'sergei-ad-clicker.yaml']) {
      const persona = await loadPersona(path.join(PERSONA_DIR, file));
      expect(persona.intent).toBe('low');
      expect(persona.patience).toBe('low');
      expect(persona.device).toBe('mobile');
    }
  });

  it('gives every shipped persona an intent', async () => {
    for (const file of ['olena.yaml', 'dmitry.yaml', 'anna.yaml']) {
      expect((await loadPersona(path.join(PERSONA_DIR, file))).intent).toBe('high');
    }
    expect((await loadPersona(path.join(PERSONA_DIR, 'james.yaml'))).intent).toBe('medium');
  });
});
