// engine/state-diff.ts
// Change detection between two PageStates.

import type { PageState } from './types';
import { viewportSignature } from './extract';
import { normalizeUrl } from './url-normalize';

/** Jaccard distance above which the in-viewport content counts as changed. */
export const STATE_CHANGE_THRESHOLD = 0.1;

export function jaccardDistance(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const v of setA) if (setB.has(v)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : 1 - intersection / union;
}

export function hasStateChanged(before: PageState, after: PageState): boolean {
  if (normalizeUrl(before.meta.url) !== normalizeUrl(after.meta.url)) return true;
  // Tested on its own rather than left to the Jaccard ratio over the whole signature: on a
  // page with thirty controls a single changed entry falls under the threshold, and a changed
  // wizard question is the one difference that most needs to register.
  if (before.meta.visibleTextDigest !== after.meta.visibleTextDigest) return true;
  return (
    jaccardDistance(viewportSignature(before), viewportSignature(after)) > STATE_CHANGE_THRESHOLD
  );
}
