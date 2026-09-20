// engine/loop-detector.ts
// The three loop rules, evaluated over the trace.

import type { TraceRow } from './types';
import { normalizeUrl } from './url-normalize';

/** Same action on the same state this many times in a row. */
export const REPEAT_LIMIT = 3;

/** Unchanged viewHash for this many consecutive steps. */
export const STUCK_VIEW_LIMIT = 4;

export type LoopReason = 'repeat-action' | 'stuck-view' | 'scroll-oscillation';

export interface LoopSignal {
  looped: boolean;
  reason?: LoopReason;
}

const NO_LOOP: LoopSignal = { looped: false };

/** The spec's `name|href` action identity. Handles are per-step, so this never uses element ids. */
function actionKey(row: TraceRow): string {
  return `${row.sampledName}|${row.sampledHref ?? ''}`;
}

export function detectLoop(rows: TraceRow[]): LoopSignal {
  if (rows.length === 0) return NO_LOOP;

  const lastThree = rows.slice(-REPEAT_LIMIT);
  if (
    lastThree.length === REPEAT_LIMIT &&
    lastThree.every((r) => r.stateHash === lastThree[0]!.stateHash) &&
    lastThree.every((r) => actionKey(r) === actionKey(lastThree[0]!))
  ) {
    return { looped: true, reason: 'repeat-action' };
  }

  const lastFour = rows.slice(-STUCK_VIEW_LIMIT);
  if (lastFour.length === STUCK_VIEW_LIMIT) {
    if (lastFour.every((r) => r.viewHash === lastFour[0]!.viewHash)) {
      return { looped: true, reason: 'stuck-view' };
    }
    // Every scroll changes stateHash (and usually viewHash), so oscillation is keyed on the
    // normalized URL — the page identity — rather than on either hash.
    const samePage = lastFour.every((r) => normalizeUrl(r.url) === normalizeUrl(lastFour[0]!.url));
    const pattern = lastFour.map((r) => r.sampled).join(',');
    if (samePage && pattern === 'scroll_down,scroll_up,scroll_down,scroll_up') {
      return { looped: true, reason: 'scroll-oscillation' };
    }
  }

  return NO_LOOP;
}
