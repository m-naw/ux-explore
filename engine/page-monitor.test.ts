import { describe, it, expect } from 'vitest';
import { createPageMonitor } from './page-monitor';
import type { Page } from 'playwright';

type Handler = (arg: unknown) => void;

/** Minimal fake of the Playwright Page event surface the monitor uses. */
function fakePage(url: string = 'http://127.0.0.1:5173/a'): {
  page: Page;
  emit: (event: string, arg: unknown) => void;
} {
  const handlers = new Map<string, Set<Handler>>();
  const page = {
    url: () => url,
    on(event: string, handler: Handler) {
      handlers.set(event, (handlers.get(event) ?? new Set()).add(handler));
      return page;
    },
    off(event: string, handler: Handler) {
      handlers.get(event)?.delete(handler);
      return page;
    },
  } as unknown as Page;
  return {
    page,
    emit(event, arg) {
      for (const handler of handlers.get(event) ?? []) handler(arg);
    },
  };
}

function consoleMessage(type: string, text: string, locationUrl: string): unknown {
  return { type: () => type, text: () => text, location: () => ({ url: locationUrl }) };
}

describe('createPageMonitor', () => {
  it('reports only errors seen after the most recent mark', () => {
    const { page, emit } = fakePage('https://site.test/a');
    const monitor = createPageMonitor(page);
    emit('console', consoleMessage('error', 'load-time boom', 'https://site.test/app.js'));
    monitor.mark();
    emit('console', consoleMessage('error', 'step boom', 'https://site.test/app.js'));
    const drained = monitor.drain();
    expect(drained.consoleErrors.some((e) => e.includes('step boom'))).toBe(true);
    expect(drained.consoleErrors.some((e) => e.includes('load-time boom'))).toBe(false);
    monitor.dispose();
  });

  it('suppresses a repeat of a baseline error even when it fires again', () => {
    const { page, emit } = fakePage('https://site.test/a');
    const monitor = createPageMonitor(page);
    emit('console', consoleMessage('error', 'recurring', 'https://site.test/app.js'));
    monitor.mark();
    emit('console', consoleMessage('error', 'recurring', 'https://site.test/app.js'));
    expect(monitor.drain().consoleErrors).toEqual([]);
    monitor.dispose();
  });

  it('drops console errors from another origin', () => {
    const { page, emit } = fakePage('https://site.test/a');
    const monitor = createPageMonitor(page);
    monitor.mark();
    emit('console', consoleMessage('error', 'third-party boom', 'https://cdn.other.test/x.js'));
    emit('console', consoleMessage('error', 'ours', 'https://site.test/app.js'));
    const drained = monitor.drain();
    expect(drained.consoleErrors.join(' ')).toContain('ours');
    expect(drained.consoleErrors.join(' ')).not.toContain('third-party');
    monitor.dispose();
  });

  it('drops a pageerror whose stack points at another origin', () => {
    const { page, emit } = fakePage('https://site.test/a');
    const monitor = createPageMonitor(page);
    monitor.mark();
    const foreign = new Error('third-party boom');
    foreign.stack = 'Error: third-party boom\n    at https://cdn.other.test/x.js:1:7';
    const ours = new Error('our boom');
    ours.stack = 'Error: our boom\n    at https://site.test/app.js:3:1';
    // A stack from a port-bearing origin must still match, which is why the regex keeps `:`.
    emit('pageerror', foreign);
    emit('pageerror', ours);
    const drained = monitor.drain();
    expect(drained.consoleErrors).toEqual(['our boom']);
    monitor.dispose();
  });

  it('ignores non-error console output', () => {
    const { page, emit } = fakePage('https://site.test/a');
    const monitor = createPageMonitor(page);
    monitor.mark();
    emit('console', consoleMessage('log', 'hello', 'https://site.test/app.js'));
    expect(monitor.drain().consoleErrors).toEqual([]);
    monitor.dispose();
  });

  it('keeps a pageerror from a same-origin url that carries a port', () => {
    const { page, emit } = fakePage('http://127.0.0.1:5173/a');
    const monitor = createPageMonitor(page);
    monitor.mark();
    const ours = new Error('ported boom');
    ours.stack = 'Error: ported boom\n    at http://127.0.0.1:5173/app.js:3:1';
    emit('pageerror', ours);
    expect(monitor.drain().consoleErrors).toEqual(['ported boom']);
    monitor.dispose();
  });
});
