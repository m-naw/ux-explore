// engine/util.ts
// Small helpers several engine modules need. Nothing here imports another engine module, so
// anything may import it without risking a cycle.

/**
 * Playwright timeout for a click, fill or select. Shared with overlay dismissal so a stubborn
 * consent banner cannot hold a step open longer than the click it is blocking would have.
 */
export const CLICK_TIMEOUT_MS = 4000;

/** Origin of a URL, or `'null'` for anything unparseable, matching how browsers report it. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'null';
  }
}

/** Escape a literal so it can be embedded in a RegExp source string. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Arithmetic mean; 0 for an empty list, so a missing sample never skews a ratio. */
export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** L1 distance between two distributions, treating a key missing from either as 0. */
export function l1Distance(a: Record<string, number>, b: Record<string, number>): number {
  let total = 0;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    total += Math.abs((a[key] ?? 0) - (b[key] ?? 0));
  }
  return total;
}

/** Nearest-rank percentile, so p50 of an even-length list is the lower of the two middles. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

/**
 * Does a viewport-relative rect show any pixel on screen? All four edges are tested: a closed
 * off-canvas drawer sits at `right === 0` and is as unread as something below the fold.
 */
export function inViewport(
  rect: { top: number; bottom: number; left: number; right: number },
  viewport: { width: number; height: number },
): boolean {
  return (
    rect.top < viewport.height && rect.bottom > 0 && rect.left < viewport.width && rect.right > 0
  );
}
