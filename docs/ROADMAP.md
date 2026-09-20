# Roadmap

## Done

- **Leave and intent.** Every step offers `leave this site`, weighed by the decide engine
  against the persona's `intent` (low/medium/high) and patience lines. Journeys that end this
  way report `left: true`, bucket `bounce`; `leaveRateByPersona` and per-URL `leaveRate` give
  a direct counterpart to a real analytics exit rate. See `README.md` for the mechanics.

## Calibration loop (analytics feedback)

v1 proved speed and cost, not that the personas behave like real users. The plan is a
`calibrate` command that pulls Matomo (`Actions.getPageUrls`, `Transitions.getTransitionsForPageUrl`,
goal funnels) segmented by browser language and device, runs the existing tool for the same
segments, and joins on normalized URL to score three signals:

- **Exit agreement** — Spearman correlation between synthetic and real exit share per URL.
- **Transition agreement** — L1 distance between synthetic and real next-page distributions.
- **Funnel agreement** — synthetic completion vs. real drop-off per step.

### Go/no-go experiment (build first, 1-2 weeks, under $10)

| Metric                             | Go        | Tune first | No-go                |
| ---------------------------------- | --------- | ---------- | -------------------- |
| Exit rank correlation, per segment | above 0.5 | 0.3-0.5    | below 0.3 everywhere |
| Transition L1, median top 30 URLs  | below 0.6 | 0.6-0.9    | above 0.9            |
| Funnel steps off by >30 points     | 0-1       | 2          | 3+                   |

Go means invest in the tuning loop (hill-climb persona text and weights against these
metrics, up to three rounds, history recorded per candidate). No-go means the current persona
representation isn't capturing human behaviour on that site, so tuning is not the next move.
Segments under ~500 visits/month are reported but excluded from the decision (too noisy).

## Still open

- **OTP hook** — no way to carry a persona through a one-time-passcode step today.
- **Hosted service** — the tool is CLI-only; no API/service wrapper yet.
- **Cached vision line per page state** — a screenshot-derived context line, cached per
  state hash, to help option descriptions without spending a vision call every step.
- **Factored decision engine** — split today's single Jev call into composable stages
  (perception / policy) so an alternate decide engine can be swapped in per stage rather than
  whole-call.
- **`dismissOverlay` after language switch** — after `switch_language`, the reloaded page's
  cookie/consent banner should be dismissed by finding its own dismiss control, not by
  falling back to `Escape`.
- **Persona drafting from real sessions** — cluster real visitor paths into archetypes;
  draft personas for archetypes with no match, retire personas matching nobody.
- **Login flows** — not modeled by the current typed-input / options path.
