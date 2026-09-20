# Changelog

## 0.2.0

First public release.

- **One typed decision per step.** A single Jev call chooses from options built by
  deterministic accessibility-tree extraction, with no LLM in the perception path. Median
  step time is ~1s and a 25-step journey costs ~$0.10. See `docs/ARCHITECTURE.md`.
- **Leaving and persona intent.** Every step offers `leave this site`, weighed against a new
  `intent` field on the persona (low/medium/high). Journeys that end this way report
  `bucket: bounce` and feed `leaveRateByPersona` / per-URL `leaveRate`, a direct counterpart
  to a real analytics exit rate.
- **Viewport-bounded page text.** The persona reads only what's on screen now or was seen
  earlier on the current page, with per-option surrounding context (heading, nearby text,
  price), instead of a fixed heading-plus-snippet extract.
- **Failure attribution and hesitation signal.** Steps and journeys are bucketed (tool,
  stale, product, ux, persona); each step carries a probability distribution, entropy and
  confidence.
- **Objective goal detection.** Success is `--success-url` / `--success-text` matching, with
  persona belief of completion tracked as a separate, non-authoritative signal.
- **Report evidence enforcement.** The end-of-journey Sonnet report must cite real steps;
  findings citing none are rejected, and product findings without product-bucket evidence are
  downgraded, both counted in `metrics.json`.
- **Decide benchmark.** `scripts/bench-decide.ts` replays recorded decision states across the
  Jev, Haiku and Sonnet engines for latency, cost and agreement comparison (see README).
- **Run-set metrics.** `scripts/metrics.ts` aggregates a directory of runs; `--order`
  declares the persona difficulty ranking the ordinal check measures the run set against.
- **Framework-tolerant clicking.** A control that re-renders while the step acts on it is
  reached by role and name when no handle survives, and a transition that lands after the
  normal settle window is waited out rather than reported as a dead button; both are visible
  in the trace as `clickPath` and the `late-transition` flag.
- **Real-browser test suite.** Tests run against real Chromium fixtures alongside the
  mocked unit suite.
