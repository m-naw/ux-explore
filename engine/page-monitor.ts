// engine/page-monitor.ts
// Collects same-origin console errors and failed requests, windowed per step.
// Create it BEFORE the first page.goto so load-time noise lands in the baseline.

import type { ConsoleMessage, Page, Request, Response } from 'playwright';
import { originOf } from './util';

export interface PageMonitor {
  /** Start a new window. Everything already recorded becomes the baseline. */
  mark(): void;
  /** Everything recorded since the last mark(), minus the baseline. */
  drain(): { consoleErrors: string[]; failedRequests: string[] };
  dispose(): void;
}

const WATCHED_RESOURCES = new Set(['document', 'xhr', 'fetch']);

/**
 * Origin of the first absolute URL in a stack trace, used to attribute an uncaught error.
 * The character class must allow `:` so the port survives: `127.0.0.1:5173` and
 * `127.0.0.1` are different origins, and stripping the port would reject every
 * same-origin error the fixture server produces.
 */
function stackOrigin(stack: string | undefined): string | undefined {
  const match = stack ? /(https?:\/\/[^/\s]+)/.exec(stack) : null;
  return match ? originOf(match[1]!) : undefined;
}

export function createPageMonitor(page: Page): PageMonitor {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const baseline = new Set<string>();
  let consoleMark = 0;
  let requestMark = 0;

  // The page may still be on about:blank when the monitor is created, so the
  // origin is read at event time, not at construction time.
  const pageOrigin = (): string => originOf(page.url());

  const onConsole = (msg: ConsoleMessage): void => {
    if (msg.type() !== 'error') return;
    const location = msg.location().url || page.url();
    if (originOf(location) !== pageOrigin()) return;
    consoleErrors.push(`${msg.text()} (${location})`);
  };

  const onPageError = (error: Error): void => {
    const origin = stackOrigin(error.stack);
    if (origin !== undefined && origin !== pageOrigin()) return;
    consoleErrors.push(error.message);
  };

  const onRequestFailed = (request: Request): void => {
    if (!WATCHED_RESOURCES.has(request.resourceType())) return;
    if (originOf(request.url()) !== pageOrigin()) return;
    failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? 'failed'})`);
  };

  const onResponse = (response: Response): void => {
    if (!WATCHED_RESOURCES.has(response.request().resourceType())) return;
    if (originOf(response.url()) !== pageOrigin()) return;
    if (response.status() < 400) return;
    failedRequests.push(`${response.url()} (${response.status()})`);
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);

  return {
    mark(): void {
      for (const e of consoleErrors) baseline.add(e);
      consoleMark = consoleErrors.length;
      requestMark = failedRequests.length;
    },
    drain(): { consoleErrors: string[]; failedRequests: string[] } {
      return {
        consoleErrors: [
          ...new Set(consoleErrors.slice(consoleMark).filter((e) => !baseline.has(e))),
        ],
        failedRequests: [...new Set(failedRequests.slice(requestMark))],
      };
    },
    dispose(): void {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
    },
  };
}
