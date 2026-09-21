/**
 * Render a Jev run (journey.yaml + screenshots) into per-step PNG frames, then an
 * mp4 and a social-sized gif via ffmpeg.
 *
 *   pnpm tsx scripts/render-journey/render.ts <runDir> [--out docs/demo] [--steps 1,3,5]
 *       [--hold 2.5] [--width 1280] [--ffmpeg /path/to/ffmpeg] [--goal "..."] [--persona Olena]
 *       [--persona-line "45, British, speaks only English"] [--short]
 *
 * --short auto-selects at most 14 steps: first, last, one representative per distinct screen
 * (state hash / url change, falling back to a sampledName run-length grouping), every step
 * where the sampled option differs from the argmax, any step flagged `confused`, then the
 * highest-entropy rest.
 * A final outcome card (GOAL MET / GOAL NOT MET / GAVE UP / STUCK) is always appended and held 4s.
 *
 * ffmpeg is looked up as: --ffmpeg, then $FFMPEG, then `ffmpeg` on PATH.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { parse } from 'yaml';

type Row = {
  step: number;
  url: string;
  stateHash?: string;
  screenshotPath?: string;
  options: { id: string; kind: string; description: string }[];
  distribution: Record<string, number>;
  pruned: Record<string, number>;
  sampled: string;
  sampledName: string;
  argmax: string;
  confidence: number;
  entropy: number;
  goalMet: number;
  confusion: number;
  flags?: string[];
};

type Summary = {
  persona?: { name?: string; description?: string };
  outcome?: { needMet?: boolean | null; gaveUp?: boolean; left?: boolean; reason?: string; totalSteps?: number };
};

type Args = {
  runDir: string;
  out: string;
  steps: number[] | null;
  hold: number;
  width: number;
  ffmpeg: string | null;
  goal: string | null;
  persona: string | null;
  personaLine: string | null;
  short: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { runDir: '', out: 'docs/demo', steps: null, hold: 2.5, width: 1280, ffmpeg: null, goal: null, persona: null, personaLine: null, short: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i] ?? '';
    const next = (): string => {
      const n = argv[++i];
      if (n === undefined) throw new Error(`${v} needs a value`);
      return n;
    };
    if (v === '--out') a.out = next();
    else if (v === '--steps') a.steps = next().split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    else if (v === '--hold') a.hold = Number(next());
    else if (v === '--width') a.width = Number(next());
    else if (v === '--ffmpeg') a.ffmpeg = next();
    else if (v === '--goal') a.goal = next();
    else if (v === '--persona') a.persona = next();
    else if (v === '--persona-line') a.personaLine = next();
    else if (v === '--short') a.short = true;
    else if (!a.runDir && !v.startsWith('--')) a.runDir = v;
    else throw new Error(`unknown arg: ${v}`);
  }
  if (!a.runDir) throw new Error('usage: render.ts <runDir> [--out dir] [--steps 1,2] [--hold s] [--width px] [--ffmpeg bin] [--persona-line "..."] [--short]');
  return a;
}

function findFfmpeg(explicit: string | null): string | null {
  for (const cand of [explicit, process.env.FFMPEG, 'ffmpeg']) {
    if (!cand) continue;
    const r = spawnSync(cand, ['-version'], { encoding: 'utf8' });
    if (r.status === 0) return cand;
  }
  return null;
}

function run(bin: string, args: string[]) {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${basename(bin)} ${args.slice(0, 4).join(' ')} … failed:\n${(r.stderr || '').slice(-1500)}`);
}

function readGoal(runDir: string): string | null {
  const p = join(runDir, 'narrative.md');
  if (!existsSync(p)) return null;
  const first = readFileSync(p, 'utf8').split('\n')[0] ?? '';
  // "# Olena's journey: шукаю кар'єру CUKR"
  const m = first.match(/journey:\s*(.+)$/i);
  return m?.[1] ? m[1].trim() : null;
}

function pad(n: number) { return String(n).padStart(2, '0'); }

/** First sentence of the persona's YAML description, when the run carried one. */
function personaLineFrom(summary: Summary | undefined): string | null {
  const d = summary?.persona?.description?.trim();
  if (!d) return null;
  return (d.split(/(?<=\.)\s+|\n/)[0] ?? d).trim();
}

/** Map a run's outcome to the four demo labels. Order matters: a met goal wins over how it ended. */
function outcomeLabel(summary: Summary | undefined, last: Row | undefined): 'GOAL MET' | 'GOAL NOT MET' | 'GAVE UP' | 'STUCK' {
  const o = summary?.outcome ?? {};
  if (o.needMet === true || (o.needMet == null && (last?.goalMet ?? 0) >= 0.5)) return 'GOAL MET';
  if (o.gaveUp || o.left || /gave up|left the site/i.test(o.reason ?? '')) return 'GAVE UP';
  if (/loop|budget|stuck|tool failure/i.test(o.reason ?? '')) return 'STUCK';
  return 'GOAL NOT MET';
}

/** Findings count, or null when the report call failed or was skipped (a zero would then be a lie). */
function readFindingsCount(runDir: string): number | null {
  const issues = join(runDir, 'tool-issues.json');
  if (existsSync(issues) && /"report-failed"/.test(readFileSync(issues, 'utf8'))) return null;
  const narrative = join(runDir, 'narrative.md');
  if (!existsSync(narrative) || !readFileSync(narrative, 'utf8').trim()) return null; // --no-report
  for (const name of ['findings.yaml', 'findings.json']) {
    const p = join(runDir, name);
    if (!existsSync(p)) continue;
    const v = parse(readFileSync(p, 'utf8'));
    return Array.isArray(v) ? v.length : null;
  }
  return null;
}

/**
 * --short: first, last, one representative per distinct screen, every sampled≠argmax, any
 * confusion, then top entropy; ≤14, chronological.
 */
function pickShort(rows: Row[], max = 14): Row[] {
  const keep = new Set<number>();
  const add = (r: Row | undefined) => { if (r && keep.size < max) keep.add(r.step); };
  add(rows[0]);
  add(rows.at(-1));
  // One step per distinct screen, before the entropy fill, so --short never skips a whole
  // screen. A screen changes when stateHash (or, lacking that, the url) changes; falls back
  // to a sampledName run-length grouping when neither field is present.
  let prevScreen: string | undefined;
  for (const r of rows) {
    const screen = r.stateHash || r.url || r.sampledName;
    if (screen !== prevScreen) add(r);
    prevScreen = screen;
  }
  for (const r of rows) if (r.sampled && r.argmax && r.sampled !== r.argmax) add(r);
  // `confused` is the engine's flag for confusion above its threshold; every row carries a raw score.
  for (const r of rows) if (r.flags?.includes('confused')) add(r);
  for (const r of [...rows].sort((a, b) => (b.entropy ?? 0) - (a.entropy ?? 0))) add(r);
  return rows.filter((r) => keep.has(r.step));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = resolve(args.runDir);
  const out = resolve(args.out);
  const framesDir = join(out, 'frames');
  mkdirSync(framesDir, { recursive: true });

  const ffmpeg = findFfmpeg(args.ffmpeg);
  if (!ffmpeg) {
    console.error('ffmpeg not found (tried --ffmpeg, $FFMPEG, PATH). Install it or pass --ffmpeg <bin>.');
    process.exit(2);
  }

  const doc = parse(readFileSync(join(runDir, 'journey.yaml'), 'utf8')) as { summary?: Summary; rows: Row[] };
  const rows = doc.rows ?? [];
  if (!rows.length) throw new Error('journey.yaml has no rows');
  const persona = args.persona ?? doc.summary?.persona?.name ?? 'Persona';
  const personaLine = args.personaLine ?? personaLineFrom(doc.summary) ?? '';
  const goal = args.goal ?? readGoal(runDir) ?? '';

  const wanted = args.steps ? rows.filter((r) => args.steps!.includes(r.step)) : args.short ? pickShort(rows) : rows;
  if (!wanted.length) throw new Error('no rows match --steps');
  const total = rows.length;

  const frameHtml = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'frame.html')).href;
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: args.width / 1280,
  });

  const framePaths: string[] = [];
  const diverged: number[] = [];
  for (const row of wanted) {
    const shotFile = join(runDir, 'screenshots', row.screenshotPath ? basename(row.screenshotPath) : `step-${pad(row.step)}.jpg`);
    if (!existsSync(shotFile)) throw new Error(`missing screenshot for step ${row.step}: ${shotFile}`);
    await page.goto(frameHtml);
    await page.evaluate(
      ([r, i, t, s, m]) => (window as any).renderStep(r, i, t, s, m),
      [row, row.step, total, pathToFileURL(shotFile).href, { persona, personaLine, goal }] as const,
    );
    await page.waitForFunction(() => {
      const img = document.getElementById('img') as HTMLImageElement;
      return img.complete && img.naturalWidth > 0;
    });
    const png = join(framesDir, `step-${pad(row.step)}.png`);
    await page.screenshot({ path: png, type: 'png' });
    framePaths.push(png);
    if (row.sampled !== row.argmax) diverged.push(row.step);
    process.stdout.write(`frame ${row.step}/${total}\n`);
  }

  // Outcome card, held longer than a step so the verdict lands.
  const label = outcomeLabel(doc.summary, rows.at(-1));
  const findings = readFindingsCount(runDir);
  await page.goto(frameHtml);
  await page.evaluate(
    ([m]) => (window as any).renderOutcome(m),
    [{ persona, personaLine, goal, label, reason: doc.summary?.outcome?.reason ?? '', steps: doc.summary?.outcome?.totalSteps ?? total, findings }] as const,
  );
  const outcomePng = join(framesDir, 'outcome.png');
  await page.screenshot({ path: outcomePng, type: 'png' });
  await browser.close();

  // concat demuxer list: each still held for --hold seconds, the outcome card for 4s; last entry
  // repeated so its duration applies.
  const HOLD_OUTCOME = 4;
  const list = join(framesDir, 'list.txt');
  const q = (p: string) => `file '${p.replace(/'/g, "'\\''")}'`;
  const lines = framePaths.map((p) => `${q(p)}\nduration ${args.hold}`);
  lines.push(`${q(outcomePng)}\nduration ${HOLD_OUTCOME}`, q(outcomePng));
  writeFileSync(list, lines.join('\n') + '\n');

  const mp4 = join(out, 'journey.mp4');
  run(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
    '-r', '30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart',
    mp4,
  ]);

  const gif = join(out, 'journey.gif');
  const budget = 6 * 1024 * 1024;
  const attempts: { width: number; fps: number }[] = [
    { width: 800, fps: 5 }, { width: 800, fps: 2 }, { width: 640, fps: 2 }, { width: 560, fps: 1 },
  ];
  let gifInfo = '';
  for (const { width, fps } of attempts) {
    run(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      '-loop', '0',
      gif,
    ]);
    const size = statSync(gif).size;
    gifInfo = `${width}px @ ${fps}fps, ${(size / 1024 / 1024).toFixed(2)} MB`;
    if (size <= budget) break;
    process.stdout.write(`gif too big (${gifInfo}), retrying smaller\n`);
  }

  const mp4Mb = (statSync(mp4).size / 1024 / 1024).toFixed(2);
  process.stdout.write(
    `done: ${framePaths.length} frames + outcome (${label}) -> ${mp4} (${mp4Mb} MB), ${gif} (${gifInfo})\n` +
    `steps rendered: ${wanted.map((r) => r.step).join(', ')}\n` +
    `sampled != argmax at steps: ${diverged.length ? diverged.join(', ') : 'none'}\n`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
