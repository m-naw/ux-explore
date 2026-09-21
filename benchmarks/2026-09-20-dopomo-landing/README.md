# 2026-09-20 — dopomo.pl landing page, live data

Live journeys and Decide-engine benchmark data behind the methodology post. No network access or API calls were made to produce this package; it repackages one live session's output.

dopomo.pl is the author's own product (RunProven AI); it was used here because the author has access to its real analytics, letting synthetic persona behaviour be compared against live user behaviour.

**Measured:** `https://dopomo.pl/uk/pathfinder/case/cukr/landing?ads` (CUKR residence-card ad-clicker landing flow), plus `https://books.toscrape.com/` for the smoke journey. Personas: `Oksana` + `Sergei` (`personas/*-ad-clicker.yaml`, low-intent/low-patience mobile), `Anna` for smoke. Seeds 1-3 per persona. Flags: `--max-steps 12 --no-report --record-decisions --verbose`.

## Commands (`$TYPESAFE_API_KEY`, `$ANTHROPIC_API_KEY` as env)

```bash
for P in sergei oksana; do for SEED in 1 2 3; do
  TYPESAFE_API_KEY=$TYPESAFE_API_KEY npx tsx cli.ts \
    --url 'https://dopomo.pl/uk/pathfinder/case/cukr/landing?ads' \
    --need "you tapped an ad; look around and decide whether this is worth your time" \
    --persona "personas/$P-ad-clicker.yaml" --max-steps 12 --seed "$SEED" \
    --success-url 'step=positive|/register' --format json --output ./reports/ \
    --record-decisions --no-report --verbose
done; done

TYPESAFE_API_KEY=$TYPESAFE_API_KEY ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  npx tsx scripts/bench-decide.ts ./reports --states 30 --out ./bench --e2e
```

**Leave rate method:** share of journeys ending on a page (by normalized URL) that ended with a `leave` decision (`computeMetrics`, `engine/trace.ts`) — the counterpart of a Matomo exit rate.

**Bench design:** 30 recorded decision states replayed sequentially (no concurrency) through Jev (3 calls: distribution + 3-way repeat), Claude Haiku 4.5 (5 calls), Claude Sonnet 5 (5 calls, no `temperature` — Sonnet 5 rejects it, samples at `effort: 'low'`). Reference argmax = mode of Sonnet's 5 samples (itself stochastic). All engines get the identical `DecideInput`. Full per-state table: `bench/bench.md`; raw: `bench/bench.json`.

### Cost and latency

| engine | states | median ms | p95 ms | input tok | output tok | invalid | cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| jev | 30 | 602 | 641 | 203334 | 0 | 0 | $0.0085 |
| haiku | 30 | 1092 | 1569 | 277285 | 3986 | 0 | $0.2972 |
| sonnet | 30 | 1683 | 2483 | 313910 | 4295 | 0 | $0.6708 |

### Repeat stability / agreement with Sonnet reference (jev vs haiku: 0.464 mean L1, 87% argmax agreement)

| engine | mean repeat L1 | argmax agreement vs Sonnet | mean L1 vs Sonnet | hand-label acc. |
| --- | --- | --- | --- | --- |
| jev | 0.060 | 83% | 0.602 | n/a |
| haiku | n/a | 77% | 0.400 | n/a |
| sonnet | n/a | 100% | 0.000 | n/a |

### Leave rate, run 2 (per persona)

| persona | runs | left | leave rate | threshold |
|---|---|---|---|---|
| Sergei | 3 | 3 | **1.00** | > 0.50 PASS |
| Oksana | 3 | 2 | **0.67** | > 0.50 PASS |
| combined (ad clickers) | 6 | 5 | **0.83** | > 0.50 PASS |
| Olena (strong goal) | 3 | 0 | **0.00** | < 0.20 PASS |

Olena's 3 seeds are **run-1** journeys (`journeys/olena-seed{1,2,3}.journey.json`) — the `makeRng` seed-diffusion fix landed after this run, but her 0% leave rate is unaffected by seeding: her step-1 CTA probability was 1.0 in every seed, so there was never a live alternative to sample.

### End to end (books.toscrape smoke, 6 steps, seed 1)

| engine | needMet | steps | wall ms | cost |
| --- | --- | --- | --- | --- |
| jev | true | 2 | 3416 | $0.0002 |
| haiku | true | 4 | 28297 | $0.0522 |
| sonnet | false | 5 | 58567 | $0.1767 |

One journey per engine — an anecdote, not a measurement. Sonnet is the agreement reference and the only engine that missed the goal here: agreement with Sonnet != being right.

## Caveats

- **Sonnet reference is stochastic**, not ground truth; `hand-label accuracy` reads `n/a` everywhere (no hand labels were supplied).
- **Seeds:** an earlier run had correlated RNG draws across seeds 1-3 (a since-fixed `makeRng` bug); this package is post-fix, with genuinely independent seeds.
- **Single site, small n** — 6 ad-clicker journeys across 2 personas plus 1 smoke journey; a worked example, not a statistically powered study.
- **Real exit rate for comparison:** Matomo reports **87%** exit rate on this landing page vs. Jev's measured `leave` probability of 0.40 at the same decision point.
- **Decision records omitted** to keep this folder small — `journeys/*.journey.json` has the full step trace; per-step `decisions/` and `screenshots/` are available on request or reproducible with `--record-decisions`.

See `benchmarks/` for this and future benchmark data drops — pointer from the root [README's "Decide benchmark" section](../../README.md#decide-benchmark).
