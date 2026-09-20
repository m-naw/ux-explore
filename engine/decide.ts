// engine/decide.ts
// Top-p pruning, seeded sampling and Decision assembly.

import type { Decision, OptionId, RawDecision } from './types';

/** Cumulative mass kept by nucleus pruning. */
export const TOP_P = 0.9;

/** Options below this probability are dropped. */
export const PROB_FLOOR = 0.03;

/**
 * One splitmix32 step: advance by the golden-ratio Weyl constant, then run the avalanche
 * finalizer, where one flipped input bit changes about half the output bits. This is
 * splitmix32 as defined, not a tuned constant — it is the standard way to turn a small
 * counter-like seed into well-spread generator state.
 */
function finalizeSeed(seed: number): number {
  let x = (seed + 0x9e3779b9) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x21f0aaad);
  x ^= x >>> 15;
  x = Math.imul(x, 0x735a2d97);
  x ^= x >>> 15;
  return x >>> 0;
}

/**
 * mulberry32 over a seed that is mixed first. mulberry32 adds a fixed constant to its state
 * before the first mix, so unmixed consecutive seeds draw from a narrow band and journeys meant
 * to be independent take the same first action; mixing makes consecutive seeds diverge. Each
 * seed still yields exactly one sequence.
 */
export function makeRng(seed: number): () => number {
  let a = finalizeSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shannon entropy in bits over the raw distribution. */
export function entropyBits(dist: Record<OptionId, number>): number {
  let total = 0;
  for (const p of Object.values(dist)) if (p > 0) total -= p * Math.log2(p);
  return total;
}

/**
 * Descending probability, ties broken by ordinal id order.
 * Ordinal, not localeCompare: collation varies by ICU locale, and the seed must
 * give the same action sequence on every machine.
 */
function ranked(dist: Record<OptionId, number>): Array<[OptionId, number]> {
  return Object.entries(dist).sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
}

export function argmaxOf(dist: Record<OptionId, number>): OptionId {
  const first = ranked(dist)[0];
  if (!first) throw new Error('argmaxOf: empty distribution');
  return first[0];
}

/** Nucleus pruning with a floor, renormalized. The argmax is always kept. */
export function pruneDistribution(dist: Record<OptionId, number>): Record<OptionId, number> {
  const order = ranked(dist);
  const first = order[0];
  if (!first) throw new Error('pruneDistribution: empty distribution');

  const kept: Array<[OptionId, number]> = [];
  let cumulative = 0;
  for (const entry of order) {
    if (cumulative >= TOP_P) break;
    kept.push(entry);
    cumulative += entry[1];
  }

  let floored = kept.filter(([, p]) => p >= PROB_FLOOR);
  if (floored.length === 0) floored = [first];

  const mass = floored.reduce((sum, [, p]) => sum + p, 0);
  const out: Record<OptionId, number> = {};
  for (const [id, p] of floored) out[id] = mass > 0 ? p / mass : 1 / floored.length;
  return out;
}

/** Seeded draw from an already-renormalized distribution. */
export function sampleFrom(pruned: Record<OptionId, number>, rng: () => number): OptionId {
  const order = ranked(pruned);
  const draw = rng();
  let cumulative = 0;
  for (const [id, p] of order) {
    cumulative += p;
    if (draw < cumulative) return id;
  }
  return order[order.length - 1]![0];
}

/** Assemble the full Decision from a raw engine answer and a seeded PRNG. */
export function toDecision(raw: RawDecision, rng: () => number): Decision {
  const pruned = pruneDistribution(raw.distribution);
  const sampled = sampleFrom(pruned, rng);
  const argmax = argmaxOf(raw.distribution);
  return {
    ...raw,
    pruned,
    sampled,
    argmax,
    confidence: Math.max(...Object.values(raw.distribution)),
    entropy: entropyBits(raw.distribution),
    exploration: sampled !== argmax,
  };
}
