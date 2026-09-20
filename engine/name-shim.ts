// engine/name-shim.ts
// tsx (and esbuild with `keepNames: true`) rewrites every function declaration to
// `__name(function ..., "name")`. Playwright serializes `page.evaluate` callbacks as
// source, so the injected `__name` call reaches the browser and throws
// `ReferenceError: __name is not defined`.
//
// This lives in engine/ rather than in the test harness because the extractor itself
// evaluates serialized callbacks: it must work on any page, including contexts the
// production driver creates, not only on harness-created contexts.

/**
 * A no-op `__name` shim. Evaluated as a source string, never as a transformed function,
 * so tsx cannot rewrite it and it is safe to run on a page more than once.
 */
export const NAME_SHIM = 'globalThis.__name = globalThis.__name || ((fn) => fn);';
