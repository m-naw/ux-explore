// engine/attribution.ts
// Step and journey buckets.

import type { Bucket, Flag, Outcome, TraceRow } from './types';

export type ToolFailure =
  | 'zero-elements'
  | 'jev-failure'
  | 'playwright-timeout'
  | 'state-too-large'
  /** The page was replaced twice while the extractor read it. */
  | 'extract-failed';

const UX_FLAGS: readonly Flag[] = [
  'high-entropy',
  'confused',
  'backtrack',
  'overlay-blocked',
  'validation-error',
  'unlabeled-control',
  // A layout that never fitted the phone is the site's defect, not the harness's and not
  // the persona's, so it belongs with the other ux flags.
  'non-responsive',
];

export interface BucketContext {
  flags: Flag[];
  outcome: Outcome;
  /** Handle detached twice. */
  stale: boolean;
  toolFailure?: ToolFailure;
  /** personaBelievesDone fired without the criteria matching. */
  falseCompletion: boolean;
  /** The sampled link's target returned 404. */
  href404: boolean;
}

/**
 * Bucket order: tool, stale, persona-by-missing-fact, product, ux, persona-by-lost, none.
 * `missing-fact` outranks `product` and `ux` because a wizard the persona cannot fill
 * will also produce validation text, and blaming the site for that would be wrong.
 *
 * `bounce` is never returned here. It is a journey verdict from `resolveOutcome`'s
 * `bucketHint`, not a property of the step the persona left on, and it is deliberately not
 * a tool failure: `toolIssues` filters on `tool` and `stale` only, so a bounce reaches the
 * report model as an ordinary journey.
 */
export function bucketStep(ctx: BucketContext): Bucket {
  // `overlay-undismissed` is the harness never having clicked a real dismiss control, so it
  // belongs with the other tool failures rather than with the site's own defects.
  if (ctx.toolFailure || ctx.flags.includes('overlay-undismissed')) return 'tool';
  if (ctx.stale) return 'stale';
  if (ctx.flags.includes('missing-fact')) return 'persona';

  if (
    ctx.outcome.consoleErrors.length > 0 ||
    ctx.outcome.failedRequests.length > 0 ||
    ctx.flags.includes('no-change') ||
    ctx.href404
  ) {
    return 'product';
  }

  if (ctx.falseCompletion || UX_FLAGS.some((f) => ctx.flags.includes(f))) return 'ux';
  if (ctx.flags.includes('lost')) return 'persona';
  return 'none';
}

/** Tie order for the journey bucket. */
const TIE_ORDER: readonly Bucket[] = ['tool', 'product', 'ux', 'persona'];

export function journeyBucket(rows: TraceRow[]): Bucket {
  const flagged = rows.filter(
    (r) => r.flags.length > 0 || r.bucket === 'tool' || r.bucket === 'stale',
  );
  const window = flagged.slice(-3);
  if (window.length === 0) return 'none';

  const counts = new Map<Bucket, number>();
  for (const r of window) counts.set(r.bucket, (counts.get(r.bucket) ?? 0) + 1);

  let best: Bucket = 'none';
  let bestCount = 0;
  for (const [bucket, count] of counts) {
    const rank = TIE_ORDER.indexOf(bucket);
    const bestRank = TIE_ORDER.indexOf(best);
    const better =
      count > bestCount ||
      (count === bestCount && rank !== -1 && (bestRank === -1 || rank < bestRank));
    if (better) {
      best = bucket;
      bestCount = count;
    }
  }
  return best;
}
