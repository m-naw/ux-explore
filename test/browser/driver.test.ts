import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeBrowser,
  getBrowser,
  closeBrowser,
  startFixtureServer,
  stopFixtureServer,
  type FixtureServer,
} from './harness';
import { drive, SEEN_TEXT_CHARS } from '../../engine/driver';
import { JevEngine, JevParseError, JevUnavailableError } from '../../engine/jev-engine';
import type {
  DecideEngine,
  DecideInput,
  ExploreConfig,
  Journey,
  PersonaProfile,
  RawDecision,
} from '../../engine/types';

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await closeBrowser();
  await stopFixtureServer();
});

const ANNA: PersonaProfile = {
  name: 'Anna',
  description: 'HR manager, fluent Polish.',
  languages: { native: 'pl', reads: { pl: 'fluent', en: 'ok' } },
  device: 'desktop',
  techLiteracy: 'high',
  domainLiteracy: 'high',
  patience: 'medium',
  intent: 'high',
  facts: {},
};

function config(overrides: Partial<ExploreConfig> = {}): ExploreConfig {
  return {
    url: server.url('below-fold.html'),
    need: 'Find the terms of service',
    persona: ANNA,
    maxSteps: 6,
    seed: 1,
    engine: 'jev',
    output: './reports/',
    format: 'yaml',
    verbose: false,
    screenshots: false,
    recordDecisions: false,
    report: true,
    ...overrides,
  };
}

/** Spreads mass over every offered option, so the seeded draw actually matters. */
function spreadEngine(): DecideEngine {
  return {
    async decide(input: DecideInput): Promise<RawDecision> {
      const ids = input.options.map((o) => o.id);
      const weights = ids.map((_, i) => 1 / (i + 1));
      const total = weights.reduce((s, w) => s + w, 0);
      const distribution: Record<string, number> = {};
      ids.forEach((id, i) => {
        distribution[id] = weights[i]! / total;
      });
      return {
        distribution,
        goalMet: 0,
        confusion: 1,
        latencyMs: 5,
        stateChars: 500,
        inputTokens: 160,
        offeredOptions: input.options,
        stateText: 'state text',
      };
    },
  };
}

/** Always picks the named option, so a stop rule can be exercised. */
function fixedEngine(pick: (input: DecideInput) => string, goalMet = 0): DecideEngine {
  return {
    async decide(input: DecideInput): Promise<RawDecision> {
      const id = pick(input);
      return {
        distribution: { [id]: 1 },
        goalMet,
        confusion: 1,
        latencyMs: 5,
        stateChars: 500,
        inputTokens: 160,
        offeredOptions: input.options,
        stateText: 'state text',
      };
    },
  };
}

const sequence = (j: Journey): string => j.rows.map((r) => r.sampled).join(',');

/** Walks a script of option pickers, one per step, holding the last one once it runs out. */
function scriptedEngine(
  script: Array<(input: DecideInput) => string>,
  confusion = 1,
  goalMet = 0,
): DecideEngine {
  let step = 0;
  return {
    async decide(input: DecideInput): Promise<RawDecision> {
      const pick = script[Math.min(step, script.length - 1)]!;
      step += 1;
      const id = pick(input);
      return {
        distribution: { [id]: 1 },
        goalMet,
        confusion,
        latencyMs: 5,
        stateChars: 500,
        inputTokens: 160,
        offeredOptions: input.options,
        stateText: 'state text',
      };
    },
  };
}

const byDescription =
  (needle: string) =>
  (input: DecideInput): string =>
    input.options.find((o) => o.description.includes(needle))!.id;

const byId =
  (id: string) =>
  (input: DecideInput): string =>
    input.options.find((o) => o.id === id)!.id;

describeBrowser('drive', () => {
  it('produces an identical action sequence for the same seed', async () => {
    const browser = await getBrowser();
    const one = await drive(config(), { browser, engine: spreadEngine() });
    const two = await drive(config(), { browser, engine: spreadEngine() });
    expect(sequence(one)).toBe(sequence(two));
    expect(one.rows.length).toBeGreaterThan(1);
    expect(one.rows[0]!.elementsCount).toBeGreaterThan(0);
    expect(one.rows[0]!.options.length).toBeGreaterThan(5);
    expect(one.rows[0]!.timing.decideMs).toBeGreaterThanOrEqual(0);
  });

  it('records the sampled name and href so the loop detector can compare actions', async () => {
    const browser = await getBrowser();
    const journey = await drive(config({ maxSteps: 1 }), {
      browser,
      engine: fixedEngine(
        (input) => input.options.find((o) => o.description.includes('Terms of Service'))!.id,
      ),
    });
    expect(journey.rows[0]!.sampledName).toBe('Terms of Service');
    expect(journey.rows[0]!.sampledHref).toBe('/terms');
  });

  it('stops on the success url and reports needMet', async () => {
    const browser = await getBrowser();
    const journey = await drive(config({ successUrl: /terms/, maxSteps: 4 }), {
      browser,
      engine: fixedEngine(
        (input) => input.options.find((o) => o.description.includes('Terms of Service'))!.id,
      ),
    });
    expect(journey.summary.outcome.needMet).toBe(true);
    expect(journey.summary.outcome.reason).toBe('criteria matched');
    expect(journey.summary.outcome.outcomeFindings).toEqual(['unrecognized-success']);
    expect(journey.summary.perUrl.length).toBeGreaterThan(0);
  });

  it('stops on a repeat-action loop', async () => {
    const browser = await getBrowser();
    const journey = await drive(config({ url: server.url('spa-tabs.html'), maxSteps: 10 }), {
      browser,
      engine: fixedEngine(
        (input) => input.options.find((o) => o.description.includes('Overview link one'))!.id,
      ),
    });
    expect(journey.rows.length).toBeLessThanOrEqual(4);
    expect(journey.summary.outcome.reason).toBe('loop detected');
  });

  it('stops on a scroll oscillation', async () => {
    const browser = await getBrowser();
    let toggle = false;
    const journey = await drive(config({ maxSteps: 10 }), {
      browser,
      engine: fixedEngine((input) => {
        toggle = !toggle;
        const wanted = toggle ? 'scroll_down' : 'scroll_up';
        return input.options.find((o) => o.id === wanted)?.id ?? input.options[0]!.id;
      }),
    });
    expect(journey.summary.outcome.reason).toBe('loop detected');
  });

  it('stops when the persona believes the goal is met twice in a row', async () => {
    const browser = await getBrowser();
    const journey = await drive(config({ maxSteps: 8 }), {
      browser,
      engine: fixedEngine((input) => input.options[0]!.id, 0.95),
    });
    expect(journey.rows).toHaveLength(2);
    expect(journey.summary.outcome.needMet).toBeNull();
    expect(journey.summary.outcome.reason).toBe('unverified');
  });

  it('calls a believed completion without a criteria match a false completion', async () => {
    const browser = await getBrowser();
    const journey = await drive(config({ maxSteps: 8, successUrl: /never-matches/ }), {
      browser,
      engine: fixedEngine((input) => input.options[0]!.id, 0.95),
    });
    expect(journey.summary.outcome.needMet).toBe(false);
    expect(journey.summary.outcome.bucket).toBe('ux');
    expect(journey.summary.outcome.outcomeFindings).toEqual(['false-completion']);
  });

  it('ends the journey on a final Jev failure and files the step under tool issues', async () => {
    const browser = await getBrowser();
    const failing: DecideEngine = {
      async decide(): Promise<RawDecision> {
        throw new JevUnavailableError('Jev returned 500', 500);
      },
    };
    const journey = await drive(config({ maxSteps: 5 }), { browser, engine: failing });
    expect(journey.rows).toHaveLength(1);
    expect(journey.rows[0]!.bucket).toBe('tool');
    expect(journey.toolIssues).toHaveLength(1);
    expect(journey.summary.outcome.bucket).toBe('tool');
    expect(journey.summary.outcome.reason).toContain('jev-failure');
  });

  it('ends the journey on an unusable Jev answer too', async () => {
    const browser = await getBrowser();
    const garbled: DecideEngine = {
      async decide(): Promise<RawDecision> {
        throw new JevParseError('Jev answer has no usable distribution');
      },
    };
    const journey = await drive(config({ maxSteps: 5 }), { browser, engine: garbled });
    expect(journey.rows).toHaveLength(1);
    expect(journey.rows[0]!.bucket).toBe('tool');
    expect(journey.summary.outcome.reason).toContain('jev-failure');
  });

  it('closes the context when the first navigation fails', async () => {
    const browser = await getBrowser();
    const before = browser.contexts().length;
    // Port 1 is never listening, so goto rejects before the loop ever starts.
    await expect(
      drive(config({ url: 'http://127.0.0.1:1/' }), { browser, engine: spreadEngine() }),
    ).rejects.toThrow();
    expect(browser.contexts().length).toBe(before);
  });

  it('reports a leave taken in exhaustion as a give-up as well', async () => {
    const browser = await getBrowser();
    // Confusion at 3 or above is what makes a leave read as exhaustion rather than a choice.
    const journey = await drive(config({ maxSteps: 8 }), {
      browser,
      engine: scriptedEngine([byId('scroll_down'), byId('leave')], 3),
    });
    expect(journey.rows).toHaveLength(2);
    expect(journey.rows[1]!.sampled).toBe('leave');
    expect(journey.summary.outcome.gaveUp).toBe(true);
    expect(journey.summary.outcome.left).toBe(true);
    expect(journey.summary.outcome.needMet).toBe(false);
    expect(journey.summary.outcome.reason).toBe('left the site');
    expect(journey.summary.outcome.bucket).toBe('bounce');
  });

  it('does not call a leave a give-up when the persona was neither confused nor stuck', async () => {
    const browser = await getBrowser();
    const journey = await drive(config({ maxSteps: 8 }), {
      browser,
      engine: scriptedEngine([byId('scroll_down'), byId('leave')], 1),
    });
    expect(journey.summary.outcome.left).toBe(true);
    expect(journey.summary.outcome.gaveUp).toBe(false);
  });

  it('buckets a zero-elements step tool and keeps going', async () => {
    const browser = await getBrowser();
    // Two steps: a third scroll on an unchanged state would stop the run as a loop instead.
    const journey = await drive(config({ url: server.url('text-only-scroll.html'), maxSteps: 2 }), {
      browser,
      engine: fixedEngine(
        (input) => input.options.find((o) => o.id === 'scroll_down')?.id ?? input.options[0]!.id,
      ),
    });
    expect(journey.rows[0]!.elementsCount).toBe(0);
    expect(journey.rows[0]!.bucket).toBe('tool');
    expect(journey.rows.length).toBeGreaterThan(1);
    expect(journey.rows[1]!.elementsCount).toBeGreaterThan(0);
    expect(journey.summary.outcome.reason).toBe('step budget exhausted');
  });

  it('buckets a Playwright timeout tool and keeps going', async () => {
    const browser = await getBrowser();
    const journey = await drive(config({ url: server.url('unstable-control.html'), maxSteps: 2 }), {
      browser,
      engine: scriptedEngine([byDescription('Apply now'), byDescription('Help')]),
    });
    expect(journey.rows[0]!.outcome.errorClass).toBe('timeout');
    expect(journey.rows[0]!.bucket).toBe('tool');
    expect(journey.rows).toHaveLength(2);
    expect(journey.toolIssues).toHaveLength(1);
    expect(journey.summary.outcome.reason).toBe('step budget exhausted');
  });

  it('offers only leave on a page with nothing to act on, and records the tool problem', async () => {
    const browser = await getBrowser();
    const journey = await drive(config({ url: server.url('text-only.html'), maxSteps: 5 }), {
      browser,
      engine: fixedEngine((input) => input.options[0]!.id),
    });

    // One option, and it is the way out.
    expect(journey.rows).toHaveLength(1);
    expect(journey.rows[0]!.options.map((o) => o.id)).toEqual(['leave']);
    expect(journey.rows[0]!.flags).toContain('left');
    expect(journey.rows[0]!.sampled).toBe('leave');
    // The page gave the harness nothing to act on: still a tool row, still excluded from findings.
    expect(journey.rows[0]!.bucket).toBe('tool');
    expect(journey.toolIssues).toHaveLength(1);
    // But the journey has a verdict now, instead of ending as a tool failure.
    expect(journey.summary.outcome.left).toBe(true);
    expect(journey.summary.outcome.bucket).toBe('bounce');
    expect(journey.summary.outcome.reason).toBe('left the site');
    expect(journey.summary.outcome.totalSteps).toBe(1);
  });

  it('records the backoff Jev spent before it gave up', async () => {
    const browser = await getBrowser();
    const engine = new JevEngine({
      apiKey: 'test-key',
      fetchImpl: async () => new Response(null, { status: 500 }),
      sleep: async () => {},
    });
    const journey = await drive(config({ maxSteps: 2 }), { browser, engine });
    expect(journey.rows).toHaveLength(1);
    expect(journey.rows[0]!.bucket).toBe('tool');
    // 500 + 1000 + 2000 of backoff, kept out of the latency target.
    expect(journey.rows[0]!.timing.decideRetryMs).toBe(3500);
  });

  it('tells Jev where a repeated click actually went', async () => {
    const browser = await getBrowser();
    let seen: string[] = [];
    // Click a link, come back to the identical state, and read the repeat hint the third
    // step is handed: it has to name the page the click reached, not the page it left.
    await drive(config({ url: server.url('broken-link.html'), maxSteps: 3 }), {
      browser,
      engine: scriptedEngine([
        byDescription('Download the form'),
        byId('back'),
        (input) => {
          seen = input.repeats;
          return input.options[0]!.id;
        },
      ]),
    });
    expect(seen.join(' ')).toContain('"Download the form"');
    expect(seen.join(' ')).toContain('/definitely-missing.html');
  });

  it('stops at maxSteps and records the run id, locale, device and seed', async () => {
    const browser = await getBrowser();
    const journey = await drive(config({ maxSteps: 3 }), {
      browser,
      engine: fixedEngine(
        (input) => input.options.find((o) => o.id === 'scroll_down')?.id ?? input.options[0]!.id,
      ),
    });
    expect(journey.summary.seed).toBe(1);
    expect(journey.summary.browserLocale).toBe('pl-PL');
    expect(journey.summary.device).toBe('desktop');
    expect(journey.summary.runId).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(journey.summary.outcome.totalSteps).toBeLessThanOrEqual(3);
  });

  it('survives a click that starts a redirect chain and keeps the journey going', async () => {
    const browser = await getBrowser();
    const journey = await drive(config({ url: server.url('delayed-redirect.html'), maxSteps: 2 }), {
      browser,
      engine: fixedEngine(
        (input) =>
          input.options.find((o) => o.description.includes('Continue'))?.id ?? input.options[0]!.id,
      ),
    });
    // Without the guard this run throws "Execution context was destroyed": the extractor
    // reads the document while the next hop replaces it. The wait-and-retry rides it out,
    // so every step still produces a row and the journey reaches its step budget. Which
    // control each step sampled is left unasserted: the point is that the run survives.
    expect(journey.rows).toHaveLength(2);
    expect(journey.rows.some((r) => r.bucket === 'tool')).toBe(false);
    expect(journey.summary.outcome.reason).not.toContain('tool failure');
    expect(journey.summary.outcome.reason).not.toContain('extract-failed');
  });

  it('does not report the third-party load error as a product problem', async () => {
    const browser = await getBrowser();
    const journey = await drive(
      config({ url: server.url('broken-link.html', { alt: server.altOrigin }), maxSteps: 1 }),
      {
        browser,
        engine: fixedEngine(
          (input) => input.options.find((o) => o.id === 'scroll_down')?.id ?? input.options[0]!.id,
        ),
      },
    );
    expect(journey.rows[0]!.outcome.consoleErrors.join(' ')).not.toContain('third-party boom');
  });
});

describeBrowser('seen text memory', () => {
  /** Records what each step was told it had seen, and scrolls whenever it can. */
  function scrollingEngine(seen: string[][]): DecideEngine {
    return {
      async decide(input: DecideInput): Promise<RawDecision> {
        seen.push([...input.seenText]);
        const down = input.options.find((o) => o.id === 'scroll_down');
        const id = down
          ? down.id
          : (input.options.find((o) => o.kind === 'element')?.id ?? 'leave');
        return {
          distribution: { [id]: 1 },
          goalMet: 0,
          confusion: 1,
          latencyMs: 5,
          stateChars: 500,
          inputTokens: 160,
          offeredOptions: input.options,
          stateText: 'state text',
        };
      },
    };
  }

  it('remembers blocks it scrolled past', async () => {
    const seen: string[][] = [];
    const journey = await drive(
      config({ url: server.url('long-article.html'), maxSteps: 4, need: 'Read the guide' }),
      { browser: await getBrowser(), engine: scrollingEngine(seen) },
    );

    // Step 1 has seen nothing yet; a later step remembers the intro it scrolled past.
    expect(seen[0]).toEqual([]);
    expect(seen.slice(1).flat().join('\n')).toContain('A residence card proves your right to stay');
    expect(journey.rows[0]!.seenTextChars).toBe(0);
    expect(journey.rows[0]!.visibleTextChars).toBeGreaterThan(0);
    expect(journey.rows.some((r) => r.seenTextChars > 0)).toBe(true);
  });

  it('caps the memory at 1,000 characters on a page with far more than that', async () => {
    const seen: string[][] = [];
    const journey = await drive(
      config({ url: server.url('wall-of-text.html'), maxSteps: 5, need: 'Read the wall' }),
      { browser: await getBrowser(), engine: scrollingEngine(seen) },
    );

    // 6,000 chars on the first screen alone, so by step 3 the memory is far over budget.
    const biggest = Math.max(...seen.map((blocks) => blocks.join('\n').length));
    expect(biggest).toBeGreaterThan(SEEN_TEXT_CHARS - 400);
    expect(biggest).toBeLessThanOrEqual(SEEN_TEXT_CHARS);
    for (const row of journey.rows) expect(row.seenTextChars).toBeLessThanOrEqual(SEEN_TEXT_CHARS);
    // The count on the row is the joined length the state text actually carries.
    const withMemory = journey.rows.findIndex((r) => r.seenTextChars > 0);
    expect(journey.rows[withMemory]!.seenTextChars).toBe(seen[withMemory]!.join('\n').length);
  });

  it('forgets the page when the URL changes', async () => {
    const seen: string[][] = [];
    const engine: DecideEngine = {
      async decide(input: DecideInput): Promise<RawDecision> {
        seen.push([...input.seenText]);
        // Scroll until there is nothing left to scroll, then take the link to the next page.
        const down = input.options.find((o) => o.id === 'scroll_down');
        const link = input.options.find((o) => o.description.includes('Next page'));
        const id = down ? down.id : (link?.id ?? 'leave');
        return {
          distribution: { [id]: 1 },
          goalMet: 0,
          confusion: 1,
          latencyMs: 5,
          stateChars: 500,
          inputTokens: 160,
          offeredOptions: input.options,
          stateText: 'state text',
        };
      },
    };

    const journey = await drive(
      config({ url: server.url('seen-memory-a.html'), maxSteps: 6, need: 'Read both pages' }),
      { browser: await getBrowser(), engine },
    );

    const navigated = journey.rows.findIndex((r) => r.url.includes('seen-memory-b.html'));
    expect(navigated).toBeGreaterThan(0);
    // The first step on the new page has no memory at all, even though the old page had one.
    expect(seen[navigated]).toEqual([]);
    expect(journey.rows[navigated]!.seenTextChars).toBe(0);
    expect(seen.slice(0, navigated).flat().join('\n')).toContain('PAGE A PARAGRAPH');
    expect(seen.flat().join('\n')).not.toMatch(/PAGE A PARAGRAPH[\s\S]*seen-memory-b/);
  });
});

describeBrowser('leaving the site', () => {
  it('ends the journey as a bounce when the persona leaves on step 1', async () => {
    const journey = await drive(
      config({
        url: server.url('ad-landing.html'),
        maxSteps: 6,
        need: 'Understand what this costs',
      }),
      { browser: await getBrowser(), engine: scriptedEngine([() => 'leave']) },
    );

    expect(journey.rows).toHaveLength(1);
    expect(journey.rows[0]!.sampled).toBe('leave');
    expect(journey.rows[0]!.flags).toContain('bounce-on-entry');
    expect(journey.rows[0]!.flags).toContain('left');
    // Leaving touches nothing, so the step neither settles nor re-reads the page.
    expect(journey.rows[0]!.timing.settleMs).toBe(0);
    expect(journey.summary.outcome).toMatchObject({
      needMet: false,
      gaveUp: false,
      left: true,
      reason: 'left the site',
      bucket: 'bounce',
    });
    // A bounce is a verdict about the persona, never a harness problem.
    expect(journey.toolIssues).toEqual([]);
    expect(journey.summary.perUrl[0]!.exits).toBe(1);
    expect(journey.summary.perUrl[0]!.leaveRate).toBe(1);
  });

  it('does not flag bounce-on-entry when the persona leaves later', async () => {
    const journey = await drive(
      config({
        url: server.url('ad-landing.html'),
        maxSteps: 6,
        need: 'Understand what this costs',
      }),
      {
        browser: await getBrowser(),
        engine: scriptedEngine([
          (input) => input.options.find((o) => o.description.includes('Перевірте'))?.id ?? 'leave',
          () => 'leave',
        ]),
      },
    );

    expect(journey.rows).toHaveLength(2);
    expect(journey.rows[1]!.flags).not.toContain('bounce-on-entry');
    expect(journey.summary.outcome.left).toBe(true);
    expect(journey.summary.outcome.bucket).toBe('bounce');
  });
});

describeBrowser('leaving after belief, and the non-responsive flag', () => {
  it('calls a leave after the persona believed it was done a bounce, not a false completion', async () => {
    const journey = await drive(
      config({
        url: server.url('ad-landing.html'),
        maxSteps: 6,
        successUrl: /never-matches/,
        need: 'Understand what this costs',
      }),
      {
        browser: await getBrowser(),
        engine: scriptedEngine(
          [
            (input) =>
              input.options.find((o) => o.description.includes('Перевірте'))?.id ?? 'leave',
            () => 'leave',
          ],
          1,
          0.95,
        ),
      },
    );

    expect(journey.rows).toHaveLength(2);
    expect(journey.summary.outcome).toMatchObject({
      needMet: false,
      left: true,
      believedDone: true,
      reason: 'left the site',
      bucket: 'bounce',
    });
    expect(journey.summary.outcome.outcomeFindings).toEqual([]);
  });

  it('lets a matched criterion outrank a leave taken on the same step', async () => {
    const journey = await drive(
      config({
        url: server.url('ad-landing.html'),
        maxSteps: 6,
        successUrl: /ad-landing/,
        need: 'Understand what this costs',
      }),
      { browser: await getBrowser(), engine: scriptedEngine([() => 'leave']) },
    );

    expect(journey.summary.outcome.needMet).toBe(true);
    expect(journey.summary.outcome.reason).toBe('criteria matched');
    // The act is still recorded on the outcome, even though the verdict is a success.
    expect(journey.summary.outcome.left).toBe(true);
  });

  it('flags a non-responsive page on the first step only, not on every step of it', async () => {
    const journey = await drive(
      config({
        url: server.url('long-article.html'),
        persona: { ...ANNA, name: 'Olena', device: 'mobile' },
        maxSteps: 3,
        need: 'Read the guide',
      }),
      {
        browser: await getBrowser(),
        engine: fixedEngine(
          (input) => input.options.find((o) => o.id === 'scroll_down')?.id ?? input.options[0]!.id,
        ),
      },
    );

    // Every row is the same URL, so the page's defect is reported once, not once per step.
    expect(journey.rows.length).toBeGreaterThan(1);
    expect(journey.rows[0]!.flags).toContain('non-responsive');
    for (const later of journey.rows.slice(1)) expect(later.flags).not.toContain('non-responsive');
  });
});
