# Architecture

## What the tool does

Give it a URL, a persona YAML, and a goal in plain language. A synthetic persona walks the
site in a real Chromium toward that goal. No scripted scenario. Each step is one typed
decision by the typesafe.ai Jev engine over the page's interactive elements; the walk ends
when the goal criteria match, the persona believes it is done, gives up, loops, leaves, or
exhausts the step budget. One Claude Sonnet call at the end writes a narrative and findings.
Output is a journey trace, findings, screenshots, and metrics.

```
TYPESAFE_API_KEY=... ANTHROPIC_API_KEY=... npx tsx cli.ts \
  --url https://example.gov.pl --persona personas/olena.yaml \
  --need "start a residence-permit application and reach the signup screen" \
  --success-url 'step=positive|/register' --max-steps 25 --output reports --verbose
npx tsx scripts/metrics.ts reports/
```

## Design choices and their measured effect

Each row is a choice this design makes, next to the obvious alternative it rejects.

|                            | Alternative: an LLM rewrites the page each step | This design: a typed loop                                                         |
| -------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| LLM calls per step         | 2 (Sonnet translator + Haiku decide)            | 1 (Jev, typed)                                                                    |
| Median step time           | ~28 s                                           | 0.72 to 1.08 s                                                                    |
| Decide latency             | 2 to 5 s                                        | 0.26 to 0.32 s                                                                    |
| 25-step journey, loop only | 5 to 20 min                                     | ~21 to 25 s                                                                       |
| Cost per journey           | ~$2                                             | ~$0.10 (Jev cents, one Sonnet report)                                             |
| Perception                 | Sonnet rewrites page into prose YAML            | Deterministic accessibility-tree extraction                                       |
| Element targeting          | Fuzzy role+name string, `.first()` fallback     | Element handles, ids regenerated each step                                        |
| Goal detection             | LLM self-report `needMet`                       | Objective `--success-url` / `--success-text`, persona belief as a separate signal |
| Failure attribution        | None                                            | Buckets: tool, stale, product, ux, persona                                        |
| Hesitation signal          | None                                            | Probability distribution, entropy, confidence per step                            |
| Real-browser tests         | 0                                               | 78 on 40+ fixtures                                                                |

## What was tuned from live runs, and why

Values that changed after measurement against real sites:

- Jev state limit: 45,000 chars, down from an initial 80,000. Measured 1.7 to 2.0 chars per
  token on Polish and Ukrainian pages against Jev's 32k-token limit.
- Reserved options (nav, header, form controls, language switch, key footer links) are never
  capped; the 30-option cap applies to the rest.
- Jev gets viewport-bounded text, not a fixed heading-plus-300-chars snippet — `On screen
now:` (2,500 chars, 400 per block) and `Seen earlier on this page:` (1,000 chars, reset on
  URL change); nothing below the fold is ever sent. See `README.md`.
- Step timing is bounded rather than open-ended: one step spends at most a 12s click phase
  (`CLICK_PHASE_BUDGET_MS`, covering the first click, the retry on a re-extracted handle and
  every role+name locator attempt, each capped at the 4s `CLICK_TIMEOUT_MS`), then up to a 5s
  navigation wait and a 4s settle. A click on a link, button or submit that has not moved the
  page keeps polling to that 4s (`SETTLE_LATE_MS`); everything else stops at 1.5s.
- Report call runs at `effort: medium`; it was 50 to 70 s at default effort and is still the
  only wall-time overage (25 to 45 s).
- Progress counts a successful form fill; backtrack ignores the immediately preceding step.
  Without this, filling three fields on one page looked like being stuck.
- State hash includes disabled and checked state so a radio click registers as progress.
- Disabled controls are detected (`:disabled`, `aria-disabled`, `fieldset[disabled]`, legend
  exempt) and never offered; Jev sees a "Disabled right now" line instead.
- Filled fields are described as filled and not re-typed when they already hold the persona
  fact.
- Persona belief of completion never sets success; only objective criteria do. Belief still
  stops the journey and the gap becomes a finding.
- Sticky-header rescue picks direction from which viewport edge the occluder hugs.
- `type:` clicks go through the same occlusion and overlay checks as any click.
- Fact matching uses a leading word boundary (`hotel` no longer matches `tel`).

## Module map

```
engine/extract.ts      accessibility-derived elements, handles, geometry, iframes, shadow DOM, disabled/value state, state hash
engine/overlay.ts      cookie banners and modals, PL/UK/RU dismiss words
engine/options.ts      reserved slots, cap, meta actions (scroll, back, switch_language, leave on every step)
engine/typed-input.ts  persona facts -> type:/select: options, required-field detection
engine/jev-engine.ts   one POST per step, size fitting, retries, timeout, parser
engine/decide.ts       top-p 0.9, floor 0.03, seeded sampling, entropy
engine/execute.ts      click with pre-checks, scroll, settle, back, typed input
engine/page-monitor.ts console errors and failed requests, same-origin, baselined
engine/trace.ts        flags, per-URL aggregates, metrics
engine/attribution.ts  step and journey buckets
engine/goal.ts         criteria, persona-believes-done hysteresis, outcome
engine/loop-detector.ts repeat action, stuck view, scroll oscillation
engine/driver.ts       the loop, context/locale/device setup, tool-failure rows
engine/state-diff.ts   change detection between two page states
engine/url-normalize.ts URL normalization shared by extraction, trace and perUrl aggregation
engine/timing.ts       sub-millisecond elapsed-time measurement
journey/report-llm.ts  Sonnet structured-output report
personas.ts + personas/*.yaml   schema-validated persona profiles
cli.ts, cli-config.ts  CLI entrypoint and flag parsing/validation
cli-output.ts          verbose step logging and end-of-run summary
index.ts, report.ts    programmatic entrypoint and report formatting
scripts/metrics.ts     run-set metrics across report directories (--order sets the ordinal check)
scripts/bench-decide.ts replays recorded decisions across engines for cost/latency comparison
```

## Known limits and follow-ups

- Divergence ratio between personas is unmeasurable when a site redirects every persona to
  its own locale, since no two personas then share a state hash. Needs a locale-pinned run
  mode (force one `browserLocale` for all personas) or a locale-independent signature.
- Report call dominates wall time. Options: lower effort further, stream partial narrative,
  or make the report optional for CI gating.
- Settle signature ignores shadow DOM and iframes; canvas and icon-only controls are
  invisible to the accessibility path and surface as `unlabeled-control` findings.
- `switch_language` options need `hreflang` links; dropdown switchers go through the generic
  click path.
- Login flows, Matomo calibration, factored decision engine, persona drafting command remain
  open — see `docs/ROADMAP.md`.
- `scripts/capture-jev-fixture.mjs` refreshes the Jev fixture live; a zero-probability option
  in a fresh capture breaks one exact-equality parser test, so review before committing a
  refresh.

## Keys and safety

Keys come only from `TYPESAFE_API_KEY` and `ANTHROPIC_API_KEY` in the environment or
`.env.local` (gitignored, along with `reports/`). No key appears in any tracked file.
`TYPESAFE_API_KEY` is always required; `ANTHROPIC_API_KEY` is required unless `--no-report`
is passed, which skips the end-of-journey Sonnet report.

## Roadmap

Analytics feedback loop, persona calibration, and other open items:
`docs/ROADMAP.md`.
