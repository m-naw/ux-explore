// Sub-millisecond elapsed time measurement utility.

/**
 * Creates a timer and returns a stop function.
 * The stop function returns the elapsed milliseconds (rounded) since the timer was created.
 *
 * @example
 * const stop = timer();
 * await doWork();
 * const elapsedMs = stop();
 */
export function timer(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}
