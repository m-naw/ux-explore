/**
 * Render a Jev run (journey.yaml + screenshots) into per-step PNG frames, then an
 * mp4 and a social-sized gif via ffmpeg.
 *
 *   pnpm tsx scripts/render-journey/render.ts <runDir> [--out docs/demo] [--steps 1,3,5]
 *       [--hold 1.4] [--width 1280] [--ffmpeg /path/to/ffmpeg] [--goal "..."] [--persona Olena]
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
};

function parseArgs(argv: string[]): Args {
  const a: Args = { runDir: '', out: 'docs/demo', steps: null, hold: 1.4, width: 1280, ffmpeg: null, goal: null, persona: null };
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
    else if (!a.runDir && !v.startsWith('--')) a.runDir = v;
    else throw new Error(`unknown arg: ${v}`);
  }
  if (!a.runDir) throw new Error('usage: render.ts <runDir> [--out dir] [--steps 1,2] [--hold s] [--width px] [--ffmpeg bin]');
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

  const doc = parse(readFileSync(join(runDir, 'journey.yaml'), 'utf8')) as { summary?: any; rows: Row[] };
  const rows = doc.rows ?? [];
  if (!rows.length) throw new Error('journey.yaml has no rows');
  const persona = args.persona ?? doc.summary?.persona?.name ?? 'Persona';
  const goal = args.goal ?? readGoal(runDir) ?? '';

  const wanted = args.steps ? rows.filter((r) => args.steps!.includes(r.step)) : rows;
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
      [row, row.step, total, pathToFileURL(shotFile).href, { persona, goal }] as const,
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
  await browser.close();

  // concat demuxer list: each still held for --hold seconds; last entry repeated so its duration applies.
  const list = join(framesDir, 'list.txt');
  const lines = framePaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'\nduration ${args.hold}`);
  lines.push(`file '${(framePaths.at(-1) ?? '').replace(/'/g, "'\\''")}'`);
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
    `done: ${framePaths.length} frames -> ${mp4} (${mp4Mb} MB), ${gif} (${gifInfo})\n` +
    `sampled != argmax at steps: ${diverged.length ? diverged.join(', ') : 'none'}\n`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
