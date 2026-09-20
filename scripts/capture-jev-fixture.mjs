// scripts/capture-jev-fixture.mjs
// Re-records test/fixtures/jev-response.json from the live Jev API.
// Usage: TYPESAFE_API_KEY=... node scripts/capture-jev-fixture.mjs
// The committed fixture is already valid; run this only to refresh it.
// The key is read from the environment and is never written to the fixture.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error('TYPESAFE_API_KEY is not set. Export it and rerun, or keep the committed fixture.');
  process.exit(1);
}

const body = {
  state: [
    'Anna',
    '34, Polish, HR manager. Fluent in Polish, works on a laptop.',
    'Native language: pl. Reads: en ok.',
    '',
    'Your goal: buy a travel book under 20 pounds',
    '',
    'You are on https://books.toscrape.com/',
    'Page title: Books to Scrape',
  ].join('\n'),
  model: 'jev-latest',
  questions: {
    next: {
      type: 'choice',
      instructions:
        'You are the persona. Pick the single option you would take next toward the goal, ' +
        'given what you can see and read, and your history on this page.',
      criteria: {
        el_01: 'link "Travel" -> /catalogue/category/books/travel_2/index.html (visible)',
        el_02: 'link "Fiction" -> /catalogue/category/books/fiction_10/index.html (visible)',
      },
    },
    goalMet: {
      type: 'noul',
      instructions: 'As far as the persona can tell, the goal is already achieved on this page.',
    },
    confusion: {
      type: 'score',
      instructions: 'How confusing is this page for this persona, given their goal?',
      criteria: ['obvious what to do', 'mostly clear', 'some hesitation', 'confusing', 'lost'],
    },
  },
};

const response = await fetch('https://api.typesafe.ai/v1/systemone', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

if (!response.ok) {
  console.error(`Jev returned ${response.status}: ${await response.text()}`);
  process.exit(1);
}

const json = await response.json();
const out = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'jev-response.json',
);
await writeFile(out, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
console.log(`Wrote ${out}`);
