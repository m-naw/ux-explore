# Handoff: Jev demo gif + overlay fixes

Written 2026-09-21. Branch `demo/journey-render`, PR #1 (draft, do not merge until the fixes below are in and the demo is re-rendered).

## Goal

A social-media post about Jev in ux-explore. Assets: a gif (phone screenshot left, Jev decision panel right) of a synthetic persona on dopomo.pl, plus a comparison card of two personas. Positioning vs `browser-use/jev-ultrafast` (same TypeSafe Jev model, 15k stars in 5 days): they optimise the fastest path to DONE (argmax every step); ux-explore samples like a human, carries a persona, and reports where *she* hesitates, loops, gives up. Post angle now: "synthetic user found 3 bugs in my own tool before finding any in the site" — record, show, fix.

## What exists on this branch

- `scripts/render-journey/frame.html` — 1280x720 frame: screenshot (phone bezel if portrait) left; right: persona name + one-line description, `Step N/M`, `Action: …`, option rows with probability bars (pruned = grey/strikethrough, `argmax` tag, `picked` highlight, "Exploration" callout when picked ≠ argmax), goal-confidence meter (grey <50%, amber 50–80%, green ≥80% = engine `BELIEVES_DONE_THRESHOLD`, `engine/goal.ts:36`), confusion flag. Final outcome card: GOAL MET / GOAL NOT MET / GAVE UP / STUCK, steps, findings (hidden when `--no-report`).
- `scripts/render-journey/render.ts <runDir> [--out docs/demo] [--steps 1,3] [--short] [--hold 2.5] [--persona-line "…"] [--ffmpeg path]` — Playwright renders frames, ffmpeg builds `journey.mp4` + `journey.gif`. `--short` picks ≤14 steps: first, last, every picked≠argmax, every confused, one per distinct screen, then top entropy; chronological.
- `scripts/render-journey/compare.ts <runA> <runB> --out docs/demo/compare.png --line-a "…" --line-b "…"` — static comparison card.
- `personas/olena-careful.yaml` (not tech-savvy AND unsure of her own legal status), `personas/olena-techsavvy.yaml`, `personas/richard.yaml` (unused now).
- `docs/demo/` — `journey.gif`, `journey.mp4`, `journey-full-careful.mp4`, `journey-full-techsavvy.mp4`, `compare.png`, `sample-run/careful/` (run data). `docs/demo/frames/` gitignored.
- ffmpeg is NOT installed system-wide. Playwright's bundled ffmpeg lacks libx264/palettegen/concat `-safe`. A static build was downloaded into the session scratchpad (`/tmp/claude-1000/-home-milosz-projects-ux-explore/*/scratchpad`); it may be gone. Either `apt install ffmpeg` or download a static build and pass `--ffmpeg`.
- Keys: this checkout had no `.env`; `.env.local` (gitignored) was copied from `../runproven-ai-ux-explore/.env`. TYPESAFE key works. The Anthropic key there returned "credit balance too low" → all demo runs used `--no-report` (no `findings.yaml` / `narrative.md`). Owner says Jev balance is fine; the Anthropic key may just be a different account.
- Repo uses `package-lock.json`. Do not create pnpm lockfiles. `npx playwright install chromium` was needed once.

## Command that produced the current demo

```
npx tsx cli.ts --url https://dopomo.pl/en/cukr-card-application \
  --need "Check whether I qualify for the CUKR residence card in Poland." \
  --persona personas/olena-careful.yaml --seed 1 --no-report --output ./reports/ \
  --success-url 'pathfinder/case/cukr/qual'
```
(mobile device flag as defined in `cli-config.ts`; same for `olena-techsavvy.yaml`). Result: tech-savvy 15 steps GOAL MET on "Great — you qualify for CUKR"; careful 25 steps STUCK on `?step=negative` thrashing between chat bottom sheet, consent modal and signup.

Why `--success-url`: the engine only marks `needMet` via `GoalCriteria` (`engine/goal.ts:51-56,106`); a high `goalMet` score alone is "believes done", not success. The original two-part goal ("…and what I would need to apply") drove personas past the result page into registration, where Cloudflare Turnstile blocks headless → email-field loops. That is a test-env artifact, not a finding.

## Three tool bugs found by the demo (investigated, not fixed)

Investigation was read-only; verdicts with pointers:

### A. Engine silently accepts cookie consent (bug, high impact)
`engine/overlay.ts:14-20` `DISMISS_KEYWORDS` includes `accept`/`agree`; `isDismissName` (line 46) marks any such button as an overlay-dismiss control. When a click target is occluded by a fixed/overlay ancestor, `execute.ts:471-477` calls `dismissOverlay()` (`overlay.ts:302-316`), which clicks the first dismiss control → "Accept all". Evidence: every run, step 2 row has `overlayDismissal: {dismissed: true, method: control}` while `sampled` is something else; step 3 options no longer contain consent, `elementsCount` 14→10. The persona never chose; a real UX decision point is erased.
Fix: remove accept/agree from dismiss keywords (keep close/×/dismiss/skip). If the target is occluded and there is no plain close control, end the step as `overlay-blocked` and let the next step's options be the overlay's own controls (Accept / Reject / Manage) so consent becomes a persona choice.

### B. No screenshot of the final state (by design, easy)
`engine/driver.ts:372-376` screenshots before `execute()`, so `step-NN.jpg` = state before action N. Loop exits at `driver.ts:563` (criteriaMatched / believesDone / gaveUp / left / looped / maxSteps) with no capture; `context.close()` at 566. The "you qualify" page never appears in the video.
Fix: capture `screenshots/final.jpg` after the last `execute()` resolves, before break. Renderer: outcome card shows `final.jpg` on the left.

### C. Elements behind open sheets/modals are offered as options (gap)
`engine/overlay.ts` `annotateInFrame` only tags elements *inside* a fixed/sticky ancestor as `overlay`; occlusion is checked only at click time (`execute.ts:678` `checkOcclusion`), never at extraction (`engine/extract.ts`). Careful run steps 13-14, 23-24: "Yes/No" radios under the open chat bottom sheet listed as ordinary options with no covering tag; step 14 picked a radio, engine auto-dismissed the sheet to reach it. `stateHash`/`viewHash` do include overlay state (`extract.ts:704`). `overlay-blocked` / `overlay-undismissed` flags: `trace.ts:96-99`.
Fix: in the extraction `page.evaluate`, run an `elementFromPoint` check at each candidate's centre; drop candidates whose top-most hit is not the element/descendant and lies inside a fixed/dialog/aria-modal container. When such a container is open, options = its own controls (+ close). Keep the click-time check as a fallback.

### Related, not bugs
- Jev can only type values that match persona Facts (`engine/typed-input.ts:70-116`, `FACT_KEYS` `engine/types.ts:240-251`). Free-text inputs (dopomo's AI chat "Type your message") get no `type` option → chat is unusable. Future feature: LLM-generated free text for open inputs, gated by persona.
- Email-field "loop" in earlier runs was 2× focus-only clicks then a real type; `stuck-view` (`engine/loop-detector.ts:39-42`) killed it right after. Not Turnstile-related in itself.
- `confused` = Jev-model 0-4 confusion score (`engine/jev-engine.ts:336`) thresholded at ≥3 (`engine/goal.ts:10`, `trace.ts:80`).

### Site observations worth telling dopomo (from careful run)
- Chat drawer first shows input disabled with "Give consent" bar; input label reads "Limit reached" while showing 0/3 messages (`sample-run/careful/screenshots/step-13.jpg` in the previous run set; re-check on the current one).
- Eligibility flow: a user unsure of her UKR status answers "No / not sure" and lands on the negative branch with only chat/signup as exits.

## Plan for the next session

1. Branch `fix/overlay-handling` from `main` (not from the demo branch). TDD; repo has tests (`vitest`).
2. Fix A, C, B in that order (A and C together define overlay semantics; B is independent). Keep the click-time occlusion check.
3. Run the existing suite; add tests for: consent not auto-accepted; overlay-open extraction returns only overlay controls; `final.jpg` written on every exit path.
4. PR, review, merge to main.
5. Rebase `demo/journey-render` on main; renderer: outcome card uses `final.jpg` when present.
6. Rerun both Olenas with the command above (drop nothing; add the Anthropic key to `.env.local` if available so findings/narrative exist and the outcome card can show a findings count). Expect consent to appear as a real step now.
7. Re-render gif/mp4s/compare.png, update PR #1 body, un-draft when the owner approves.
8. Then the post: gif + compare card + three-bugs story; tag browser-use.

## Token discipline (owner's standing rule)
Delegate anything with >5 lines of output to a subagent (haiku for commands, sonnet for investigation/fixes, opus for design/new code), ask for ≤10-line structured summaries, never run Jev or renders inline. Previous session lost one cycle to a subagent that spawned background runs and waited on nothing: run Jev in foreground with a timeout and verify a new `reports/` dir exists after each run.
