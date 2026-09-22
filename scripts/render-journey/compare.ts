/**
 * Render two Jev runs of the same goal into one 1280x720 comparison card.
 *
 *   pnpm tsx scripts/render-journey/compare.ts <runDirA> <runDirB> --out docs/demo/compare.png
 *       [--title "..."] [--goal "..."] [--line-a "..."] [--line-b "..."]
 *
 * Per run: persona name + one-line description (persona.yaml in the run dir, or --line-a/b),
 * outcome label (same mapping as the outcome card), steps, sampled≠argmax count, confused-step
 * count and an entropy-per-step strip. Uses frame.html's `renderCompare` mode.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { parse } from 'yaml';

type Row = {
  step: number;
  sampled: string;
  argmax: string;
  entropy: number;
  goalMet: number;
  flags?: string[];
};
type Summary = {
  persona?: { name?: string; description?: string };
  outcome?: {
    needMet?: boolean | null;
    gaveUp?: boolean;
    left?: boolean;
    reason?: string;
    totalSteps?: number;
  };
};

function outcomeLabel(summary: Summary | undefined, last: Row | undefined) {
  const o = summary?.outcome ?? {};
  if (o.needMet === true || (o.needMet == null && (last?.goalMet ?? 0) >= 0.5)) return 'GOAL MET';
  if (o.gaveUp || o.left || /gave up|left the site/i.test(o.reason ?? '')) return 'GAVE UP';
  if (/loop|budget|stuck|tool failure/i.test(o.reason ?? '')) return 'STUCK';
  return 'GOAL NOT MET';
}

function firstSentence(d: string | undefined) {
  const t = d?.trim();
  return t ? (t.split(/(?<=\.)\s+|\n/)[0] ?? t).trim() : '';
}

function load(runDir: string, line: string | null) {
  const doc = parse(readFileSync(join(runDir, 'journey.yaml'), 'utf8')) as {
    summary?: Summary;
    rows: Row[];
  };
  const rows = doc.rows ?? [];
  if (!rows.length) throw new Error(`${runDir}: journey.yaml has no rows`);
  const personaFile = join(runDir, 'persona.yaml');
  const persona = existsSync(personaFile)
    ? (parse(readFileSync(personaFile, 'utf8')) as { name?: string; description?: string })
    : {};
  const expl = rows
    .filter((r) => r.sampled && r.argmax && r.sampled !== r.argmax)
    .map((r) => r.step);
  const conf = rows.filter((r) => r.flags?.includes('confused')).map((r) => r.step);
  return {
    persona: doc.summary?.persona?.name ?? persona.name ?? 'Persona',
    personaLine:
      line ??
      firstSentence(persona.description) ??
      firstSentence(doc.summary?.persona?.description),
    label: outcomeLabel(doc.summary, rows.at(-1)),
    reason: doc.summary?.outcome?.reason ?? '',
    steps: doc.summary?.outcome?.totalSteps ?? rows.length,
    exploration: expl.length,
    confusion: conf.length,
    entropy: rows.map((r) => r.entropy ?? 0),
    expl,
    conf,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const dirs: string[] = [];
  const opt: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v.startsWith('--')) {
      const n = argv[++i];
      if (n === undefined) throw new Error(`${v} needs a value`);
      opt[v.slice(2)] = n;
    } else dirs.push(v);
  }
  if (dirs.length !== 2 || !opt['out'])
    throw new Error(
      'usage: compare.ts <runDirA> <runDirB> --out <png> [--title ..] [--goal ..] [--line-a ..] [--line-b ..]',
    );

  const runs = [
    load(resolve(dirs[0]!), opt['line-a'] ?? null),
    load(resolve(dirs[1]!), opt['line-b'] ?? null),
  ];
  const meta = {
    title: opt['title'] ?? 'Same site, same goal, two Olenas',
    goal: opt['goal'] ?? '',
    runs,
  };

  const frameHtml = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'frame.html')).href;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(frameHtml);
  await page.evaluate((m) => (window as any).renderCompare(m), meta);
  const out = resolve(opt['out']);
  await page.screenshot({ path: out, type: 'png' });
  await browser.close();
  for (const r of runs)
    process.stdout.write(
      `${r.persona}: ${r.label}, ${r.steps} steps, ${r.exploration} exploration, ${r.confusion} confused\n`,
    );
  process.stdout.write(`wrote ${out}\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
