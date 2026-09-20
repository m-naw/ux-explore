// engine/trace.ts
// Flag rules, perUrl aggregation and run-set metrics.

import type {
  Flag,
  Journey,
  Option,
  Outcome,
  OverlayDismissal,
  PerUrlRow,
  MetricsReport,
  TraceRow,
} from './types';
import { CONFUSED_AT } from './goal';
import { l1Distance, mean } from './util';
import { normalizeUrl } from './url-normalize';

export const ENTROPY_FLAG_BITS = 2.0;
export const ENTROPY_FLAG_MIN_OPTIONS = 5;
export const LOW_CONFIDENCE = 0.5;
/**
 * How many previous steps a `backtrack` looks back over. The most recent of them is skipped,
 * so the rule spans the three steps before the immediately preceding one.
 */
export const BACKTRACK_WINDOW = 4;

/** Confidence at or above which a no-progress run counts as a lost persona. */
export const LOST_CONFIDENCE = 0.7;

/** Consecutive no-progress steps needed for `lost`. */
export const LOST_NO_PROGRESS = 4;

/** Option kinds that count as "the persona clicked something". */
const CLICK_KINDS = new Set<Option['kind']>(['element', 'switch_language']);

/** Roles for which "nothing happened" is a product problem, not a persona mistake. */
const NO_CHANGE_ROLES = new Set(['link', 'button']);

export interface FlagContext {
  optionCount: number;
  entropy: number;
  confidence: number;
  confusion: number;
  outcome: Outcome;
  sampledOption: Option;
  sampledRole?: string;
  sampledInputType?: string;
  sampledUnnamed: boolean;
  overlayBlocked: boolean;
  /** How the step tried to dismiss that overlay, which decides which of the two flags fires. */
  overlayDismissMethod?: OverlayDismissal['method'];
  stateHash: string;
  /**
   * stateHashes of the previous steps, oldest first. Only the previous 4 are considered,
   * and the immediately preceding one is excluded: repeating the state
   * you were just on is standing still — which `lost` is for — not going back.
   */
  recentStateHashes: string[];
  /** Whether the sampled element was a submit control. */
  wasSubmit: boolean;
  /** A required input on this page had no matching persona fact. */
  missingFact: boolean;
  /** Consecutive steps that produced no new stateHash, including this one. */
  noProgressSteps: number;
  /** Whether this is the first row of the journey, so an entry bounce can be told from a later one. */
  firstRow: boolean;
  /** The persona's device, because a desktop layout only hurts on a phone. */
  device: 'desktop' | 'mobile';
  /** `meta.nonResponsive`: the page laid itself out wider than the device it was opened on. */
  nonResponsive: boolean;
  /** The page moved only after every handle had gone; see the `late-transition` flag. */
  lateTransition: boolean;
}

export function computeFlags(ctx: FlagContext): Flag[] {
  const flags: Flag[] = [];
  if (ctx.entropy > ENTROPY_FLAG_BITS && ctx.optionCount > ENTROPY_FLAG_MIN_OPTIONS)
    flags.push('high-entropy');
  if (ctx.confidence < LOW_CONFIDENCE) flags.push('low-confidence');
  if (ctx.confusion >= CONFUSED_AT) flags.push('confused');
  if (ctx.outcome.error) flags.push('failed-action');

  const isClickable =
    CLICK_KINDS.has(ctx.sampledOption.kind) &&
    (NO_CHANGE_ROLES.has(ctx.sampledRole ?? '') || ctx.sampledInputType === 'submit');
  // A submit the form rejected did change something; it simply did not navigate.
  const rejected = ctx.outcome.validationMessages.length > 0;
  if (isClickable && !ctx.outcome.urlChanged && !ctx.outcome.stateChanged && !rejected)
    flags.push('no-change');

  if (ctx.wasSubmit && rejected) flags.push('validation-error');
  if (ctx.recentStateHashes.slice(-BACKTRACK_WINDOW, -1).includes(ctx.stateHash))
    flags.push('backtrack');
  // A dismiss control was clicked and the overlay stayed: the site really does trap the
  // persona. Escape (or nothing at all) proves nothing about the site — most consent banners
  // ignore it — so that is a tool problem, flagged apart and bucketed `tool`.
  if (ctx.overlayBlocked) {
    flags.push(ctx.overlayDismissMethod === 'control' ? 'overlay-blocked' : 'overlay-undismissed');
  }
  if (ctx.sampledUnnamed) flags.push('unlabeled-control');
  if (ctx.missingFact) flags.push('missing-fact');

  // A page that never fitted the phone: the persona reads a desktop layout zoomed out, which
  // is a property of the page rather than of the step. It fires once per page (by normalized
  // URL) rather than on every step, so a persona bouncing between pages doesn't drown other
  // flags in repeats — `ctx.nonResponsive` is already gated to the first step on each URL.
  if (ctx.device === 'mobile' && ctx.nonResponsive) flags.push('non-responsive');

  // Not a ux flag and not a bucket: the step succeeded, it just succeeded slowly.
  if (ctx.lateTransition) flags.push('late-transition');

  // A leave sampled at confusion 3 or above already picked up `confused` above.
  if (ctx.sampledOption.kind === 'leave') {
    // Not a ux flag and not a bucket: it only puts the row in front of the report, which
    // would otherwise never see an abandonment that carried no other signal.
    flags.push('left');
    // The first ROW, not step 1: a step lost to an unreadable page produced no row, and the
    // persona's first real look at the site is what an entry bounce is about.
    if (ctx.firstRow) flags.push('bounce-on-entry');
  }

  // `lost` is the absence of every other signal, so it is decided last.
  if (
    flags.length === 0 &&
    ctx.confidence >= LOST_CONFIDENCE &&
    ctx.noProgressSteps >= LOST_NO_PROGRESS
  ) {
    flags.push('lost');
  }
  return flags;
}

/** Per-URL aggregates, so a run set can be compared against site analytics. */
export function aggregatePerUrl(journeys: Journey[]): PerUrlRow[] {
  const byUrl = new Map<string, { rows: TraceRow[]; exits: number; leaves: number }>();
  const entryFor = (url: string) => {
    const key = normalizeUrl(url);
    const entry = byUrl.get(key) ?? { rows: [], exits: 0, leaves: 0 };
    byUrl.set(key, entry);
    return entry;
  };

  for (const journey of journeys) {
    for (const r of journey.rows.filter((r) => !r.scrollOnly)) entryFor(r.url).rows.push(r);
    const last = journey.rows[journey.rows.length - 1];
    if (last) {
      const entry = entryFor(last.url);
      entry.exits += 1;
      if (journey.summary.outcome.left) entry.leaves += 1;
    }
  }

  const out: PerUrlRow[] = [];
  for (const [url, entry] of byUrl) {
    const byName = new Map<string, number[]>();
    for (const r of entry.rows) {
      byName.set(r.sampledName, [...(byName.get(r.sampledName) ?? []), r.pruned[r.sampled] ?? 0]);
    }
    out.push({
      url,
      visits: entry.rows.length,
      meanEntropy: mean(entry.rows.map((r) => r.entropy)),
      meanConfusion: mean(entry.rows.map((r) => r.confusion)),
      exits: entry.exits,
      // The direct counterpart of a Matomo exit rate: of the journeys that ended here, how
      // many ended because the persona chose to go rather than because the budget ran out.
      leaveRate: entry.exits === 0 ? 0 : entry.leaves / entry.exits,
      backtracks: entry.rows.filter((r) => r.flags.includes('backtrack')).length,
      topSampled: [...byName.entries()]
        .map(([name, ps]) => ({ name, meanProbability: mean(ps) }))
        .sort((a, b) => b.meanProbability - a.meanProbability || (a.name < b.name ? -1 : 1))
        .slice(0, 3),
    });
  }
  return out.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

function completionRate(journeys: Journey[]): number | null {
  if (journeys.length === 0) return null;
  return journeys.filter((j) => j.summary.outcome.needMet === true).length / journeys.length;
}

/**
 * Run-set metrics.
 * `divergenceRatio` and `ordinalCheck` need several journeys; over a single journey
 * they are `null` / absent, which is why `scripts/metrics.ts` exists.
 */
export function computeMetrics(journeys: Journey[], expectedOrder?: string[]): MetricsReport {
  const allRows = journeys.flatMap((j) => j.rows);

  const byHash = new Map<
    string,
    Array<{ persona: string; seed: number; dist: Record<string, number> }>
  >();
  for (const journey of journeys) {
    for (const r of journey.rows) {
      const entry = byHash.get(r.stateHash) ?? [];
      entry.push({
        persona: journey.summary.persona.name,
        seed: journey.summary.seed,
        dist: r.distribution,
      });
      byHash.set(r.stateHash, entry);
    }
  }
  const crossPersona: number[] = [];
  const sameRepeat: number[] = [];
  for (const entries of byHash.values()) {
    for (let i = 0; i < entries.length; i += 1) {
      for (let k = i + 1; k < entries.length; k += 1) {
        const a = entries[i]!;
        const b = entries[k]!;
        if (a.persona === b.persona) {
          if (a.seed !== b.seed) sameRepeat.push(l1Distance(a.dist, b.dist));
        } else {
          crossPersona.push(l1Distance(a.dist, b.dist));
        }
      }
    }
  }
  const repeatMean = mean(sameRepeat);
  const divergenceRatio =
    crossPersona.length === 0
      ? null
      : repeatMean > 0
        ? mean(crossPersona) / repeatMean
        : Number.POSITIVE_INFINITY;

  const explored = journeys.filter((j) => j.rows.some((r) => r.exploration));
  const exploited = journeys.filter((j) => !j.rows.some((r) => r.exploration));

  let ordinalCheck: MetricsReport['ordinalCheck'];
  if (expectedOrder && expectedOrder.length > 0 && journeys.length > 1) {
    const byPersona = new Map<string, { steps: number[]; confusion: number[] }>();
    for (const journey of journeys) {
      const name = journey.summary.persona.name;
      const entry = byPersona.get(name) ?? { steps: [], confusion: [] };
      entry.steps.push(journey.summary.outcome.totalSteps);
      entry.confusion.push(mean(journey.rows.map((r) => r.confusion)));
      byPersona.set(name, entry);
    }
    const actual = [...byPersona.entries()]
      .sort(
        (a, b) =>
          mean(a[1].steps) - mean(b[1].steps) ||
          mean(a[1].confusion) - mean(b[1].confusion) ||
          (a[0] < b[0] ? -1 : 1),
      )
      .map(([name]) => name);
    ordinalCheck = {
      expected: expectedOrder,
      actual,
      ordered: expectedOrder.filter((n) => actual.includes(n)).join('|') === actual.join('|'),
    };
  }

  const tokenRows = allRows.filter((r) => r.inputTokens > 0);

  const leaveByPersona = new Map<string, { total: number; left: number }>();
  for (const journey of journeys) {
    const name = journey.summary.persona.name;
    const entry = leaveByPersona.get(name) ?? { total: 0, left: 0 };
    entry.total += 1;
    if (journey.summary.outcome.left) entry.left += 1;
    leaveByPersona.set(name, entry);
  }
  const leaveRateByPersona: Record<string, number> = {};
  for (const [name, entry] of leaveByPersona) leaveRateByPersona[name] = entry.left / entry.total;

  return {
    runIds: journeys.map((j) => j.summary.runId),
    divergenceRatio,
    explorationRate:
      allRows.length === 0 ? 0 : allRows.filter((r) => r.exploration).length / allRows.length,
    completionRateByExploration: {
      explored: completionRate(explored),
      exploited: completionRate(exploited),
    },
    perUrl: aggregatePerUrl(journeys),
    leaveRateByPersona,
    ...(ordinalCheck ? { ordinalCheck } : {}),
    charsPerToken:
      tokenRows.length === 0 ? 0 : mean(tokenRows.map((r) => r.stateChars / r.inputTokens)),
  };
}
