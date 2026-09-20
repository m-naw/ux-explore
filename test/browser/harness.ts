// test/browser/harness.ts
// Chromium launcher and static fixture server for real-browser tests.
// Set UX_EXPLORE_SKIP_BROWSER=1 to skip every browser test (e.g. no browser binary installed).

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';
import { chromium, devices, type Browser, type Page } from 'playwright';
import { NAME_SHIM } from '../../engine/name-shim';

export const describeBrowser = process.env['UX_EXPLORE_SKIP_BROWSER'] ? describe.skip : describe;

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DIR = path.resolve(HERE, '..', 'fixtures');

/**
 * Installed before any page script runs so serialized `page.evaluate` callbacks work under
 * `tsx`, `vitest` and plain node. The extractor also applies it per frame, so it does not
 * depend on a harness-created context; see engine/name-shim.ts.
 */
export { NAME_SHIM } from '../../engine/name-shim';

let browser: Browser | undefined;

export async function getBrowser(): Promise<Browser> {
  if (!browser) browser = await chromium.launch();
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    const b = browser;
    try {
      await b.close();
    } finally {
      browser = undefined;
    }
  }
}

export interface OpenPageOptions {
  device?: 'desktop' | 'mobile';
  locale?: string;
}

/**
 * Open a page with the spec's viewport and locale contract.
 * Playwright's `locale` also sets Accept-Language, so no extra header is needed.
 * devices['Pixel 5'] is 393x727 in Playwright 1.59.1; the spec mandates 390x844,
 * so the descriptor supplies touch and the mobile UA and the size is overridden.
 */
export async function openPage(options: OpenPageOptions = {}): Promise<Page> {
  const b = await getBrowser();
  const locale = options.locale ?? 'en-GB';
  const context =
    options.device === 'mobile'
      ? await b.newContext({
          ...devices['Pixel 5'],
          viewport: { width: 390, height: 844 },
          screen: { width: 390, height: 844 },
          locale,
        })
      : await b.newContext({ viewport: { width: 1280, height: 720 }, locale });
  await context.addInitScript(NAME_SHIM);
  return context.newPage();
}

/** Close a page and the context it owns, so no context leaks between tests. */
export async function closePage(page: Page): Promise<void> {
  const context = page.context();
  try {
    await page.close();
  } finally {
    await context.close();
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export interface FixtureServer {
  /** http://127.0.0.1:<port> */
  origin: string;
  /** http://localhost:<port> — the same listener, a different browser origin. */
  altOrigin: string;
  url(name: string, query?: Record<string, string>): string;
  altUrl(name: string): string;
}

let server: http.Server | undefined;

export async function startFixtureServer(): Promise<FixtureServer> {
  if (!server) {
    server = http.createServer((req, res) => {
      const name = (req.url ?? '/').split('?')[0]!.replace(/^\//, '') || 'smoke.html';
      const ext = path.extname(name);
      readFile(path.join(FIXTURE_DIR, name))
        .then((body) => {
          res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] ?? 'text/plain; charset=utf-8' });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('not found');
        });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  }
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('fixture server failed to bind');
  const { port } = address;
  const origin = `http://127.0.0.1:${port}`;
  const altOrigin = `http://localhost:${port}`;
  return {
    origin,
    altOrigin,
    url(name, query) {
      const search = query ? `?${new URLSearchParams(query).toString()}` : '';
      return `${origin}/${name}${search}`;
    },
    altUrl(name) {
      return `${altOrigin}/${name}`;
    },
  };
}

export async function stopFixtureServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server!.close((err) => (err ? reject(err) : resolve())),
  );
  server = undefined;
}
