import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeBrowser,
  openPage,
  closePage,
  closeBrowser,
  startFixtureServer,
  stopFixtureServer,
  type FixtureServer,
} from './harness';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await closeBrowser();
  await stopFixtureServer();
});

describeBrowser('browser harness', () => {
  it('serves fixtures over http at the default desktop viewport', async () => {
    const page = await openPage();
    try {
      await page.goto(server.url('smoke.html'));
      expect(await page.textContent('h1')).toBe('Smoke fixture');
      expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
      expect(new URL(page.url()).origin).toBe(server.origin);
    } finally {
      await closePage(page);
    }
  });

  it('uses the spec mobile viewport and the requested locale', async () => {
    const page = await openPage({ device: 'mobile', locale: 'uk-UA' });
    try {
      await page.goto(server.url('smoke.html'));
      expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
      expect(await page.evaluate(() => navigator.language)).toBe('uk-UA');
      expect(await page.evaluate(() => navigator.maxTouchPoints > 0)).toBe(true);
    } finally {
      await closePage(page);
    }
  });

  it('serves the same files from a second, genuinely different origin', async () => {
    expect(server.altOrigin).not.toBe(server.origin);
    const page = await openPage();
    try {
      await page.goto(server.altUrl('smoke.html'));
      expect(await page.textContent('h1')).toBe('Smoke fixture');
    } finally {
      await closePage(page);
    }
  });

  it('passes query parameters through to the fixture', async () => {
    const page = await openPage();
    try {
      await page.goto(server.url('smoke.html', { mode: 'once' }));
      expect(await page.evaluate(() => new URLSearchParams(location.search).get('mode'))).toBe(
        'once',
      );
    } finally {
      await closePage(page);
    }
  });
});
