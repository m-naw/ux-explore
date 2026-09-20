# Contributing

## Setup

```bash
npm install
cp .env.example .env.local   # fill in TYPESAFE_API_KEY and ANTHROPIC_API_KEY
```

## Checks

```bash
npm run typecheck
npm test
```

`npm test` runs two Vitest projects: `unit` (no browser) and `browser` (real Chromium via
Playwright). The browser project needs a local Chromium install once:

```bash
npx playwright install chromium
```

To skip the browser project (for example, no network access to install Chromium):

```bash
UX_EXPLORE_SKIP_BROWSER=1 npm test
```

## Test-first

Write a failing test before writing the fix or feature it covers. Fixtures live under
`test/fixtures/`; follow the existing naming and directory conventions there rather than
inventing new ones. Keep unit tests free of real network calls and API keys — mock the Jev
and Sonnet clients as the existing tests do.

## Commits and PRs

Never commit API keys, `.env` files, or real report output (`reports/` is gitignored).
Keep commits focused and use conventional commit messages (`fix:`, `feat:`, `docs:`, etc.).
