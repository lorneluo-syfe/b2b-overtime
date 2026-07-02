# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

This project quantifies **out-of-hours / overtime work** on a *separate* target repo:
`/Users/lorneluo/Workspace/swf/b2bDatafeedIngestorService`
(`git@github.com:SvavaCapital/b2bdatafeedingestorservice.git`).

The intended pipeline — periodically, over the target repo's main directory **and each of its worktrees**:
1. Read Claude Code **session history** → derive when a chat/task started and when it completed.
2. Read **git reflog** → derive commit activity times.
3. Classify all activity against working hours **Mon–Fri 09:00–17:00** (Sydney); anything outside counts
   as overtime. **Activity before 03:00 is attributed to the previous day.**
4. Report as a **table** (CLI + web) and a **colour heatmap** (web dashboard).

Collected data is persisted to **Neon Postgres**; the connection string comes from `.env` (`DATABASE_URL`).

> Status: all four steps are implemented. The **`b2b-overtime` skill**
> (`.claude/skills/b2b-overtime/`) does the collection, working-hours classification, incremental DB
> ingest, and prints the fixed 7-column CLI table. The **web dashboard** (`pnpm dashboard`) reads the
> persisted DB and renders both the per-day table and the day×hour activity heatmap.

## Tech stack & commands

**Node.js ≥22 + TypeScript**, package manager **pnpm**, **Drizzle ORM** over **postgres.js**, **luxon**
for tz-aware time. Everything runs via **`tsx`** — **no build step, no bundler, no framework**. The web
dashboard is a Node **built-in `http`** server serving one **vanilla HTML/JS/CSS** page. No test suite or
linter configured yet; `tsc --noEmit` is the only static check.

```bash
pnpm install                         # install deps (esbuild build script is allowlisted for tsx)
pnpm record-checkpoint               # record a checkpoint (data_timestamp = now)
pnpm record-checkpoint 2026-07-01T00:00:00Z   # explicit data timestamp
```

Schema is created/synced by `ensureSchema()` (idempotent `CREATE TABLE IF NOT EXISTS`), which every
script calls via `initDb()` — there is no separate migrate/push step.

Query the persisted activity tables (also the `query-overtime-db` skill):
```bash
pnpm query <table> [--start T] [--end T] [--field F] [--dir SUBSTR] [--limit N] [--order asc|desc] [--pretty]
# <table>: checkpoint | session_prompt | git_reflog | all
```

Run the collector/reporter (also the `b2b-overtime` skill):
```bash
pnpm overtime [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--no-save] [--since T] [--gap-minutes N] [--verbose]
```

Run the web dashboard (read-only view of the persisted DB — table + heatmap):
```bash
pnpm dashboard                # http://localhost:8787
PORT=9000 pnpm dashboard      # or: pnpm dashboard --port 9000
```

Scripts are also runnable directly, e.g. `npx tsx .claude/skills/b2b-overtime/scripts/analyze-overtime.ts`.

## Architecture

The DB layer lives in `src/db/`, a thin wrapper over Drizzle ORM + postgres.js, imported everywhere via
the Node **subpath import `#db`** (see `package.json` `"imports"`), so scripts avoid deep relative paths:

- **`client.ts`** — the only place that touches connection config. Reads `DATABASE_URL` (loading `.env`
  via `../bootstrap.ts` if unset), **strips libpq-only params (`sslmode`, `channel_binding`) and sets
  `ssl: 'require'`** for Neon. Lazy singletons `getSql()` / `getDb()`; `ensureSchema()` runs idempotent
  `CREATE TABLE IF NOT EXISTS`; `closeDb()` ends the socket so short-lived CLIs can exit.
- **`schema.ts`** — three `pgTable`s, all with **timezone-aware** timestamps, plus `ENSURE_SCHEMA_SQL`
  (the DDL for `ensureSchema`, kept beside the tables so they stay in sync):
  - `checkpoint`: `runTimestamp` (when recorded) + `dataTimestamp` (data high-water mark, caller-supplied).
  - `sessionPrompt` (`session_prompt`): a Claude Code prompt — `directory`, `promptSummary`, `sentAt`, `completedAt`.
  - `gitReflog` (`git_reflog`): a recorded commit — `directory`, `commitHash`, `committedAt`, `message`.
- **`checkpoint.ts`** — the write API: `initDb()` (= `ensureSchema`) and `recordCheckpoint(...)`. There
  are **no migrations** — `ensureSchema` creates missing tables; changing an existing column requires
  editing both `schema.ts` and `ENSURE_SCHEMA_SQL` plus manual DDL against the DB.
- **`bootstrap.ts`** — `loadProjectEnv()` walks up to the project root (dir with both `.env` and
  `package.json`) and loads that `.env`, so any script runs regardless of cwd.

The overtime domain logic lives in `src/overtime/` and is the **single source of truth** for the
local-time rules, shared by the CLI collector and the web dashboard:

- **`rules.ts`** — pure, dependency-light (luxon only, no fs/DB) bucketing primitives + constants:
  `ZONE`, `DAY_ROLLOVER_HOUR` (3), `DEFAULT_GAP_MINUTES` (45), `WD`, and `attributedDay` / `isWorkHours`
  (Mon–Fri 09:00–17:00) / `overtimeMs` (summed span of dense active segments, splitting on idle gaps) /
  `fmtDur`. **`analyze-overtime.ts` imports these** — don't fork the definitions.
- **`report.ts`** — `buildReport({start, end, gap})` reads the **already-ingested** `session_prompt` +
  `git_reflog` from `#db` and buckets them with `rules.ts` into the dashboard's JSON: the 7-column `rows`
  + `total`, `coverage` (per-directory), and `heatmap` (per attributed-day × local-hour counts). It never
  scans disk or runs `git`, so it mirrors the CLI's count columns but its OT-Hrs **density uses only
  prompts + commits** (the DB has no non-commit reflog HEAD movements), so OT Hrs can read slightly lower
  than the CLI.

The web dashboard (`pnpm dashboard`) is:
- **`server/dashboard.ts`** — Node built-in `http` server. `GET /` serves `public/index.html`;
  `GET /api/overtime?start=&end=&gap=` calls `buildReport` and returns JSON (defaults to the past 7 days
  in `ZONE` when params are omitted). Long-lived: it does **not** `closeDb()` per request. Read-only —
  refresh data with `pnpm overtime`, not the dashboard.
- **`public/index.html`** — the entire frontend in one file (no build): date-range picker + presets, the
  7-column table, and a day×hour heatmap. Blue ramp = work-hours activity, red ramp = rest-time activity
  (weekday nights + weekends), idle rest cells get a light warm tint. The default window is seeded from
  the server's Sydney "today" (first load hits `/api/overtime` with no params) so presets stay tz-correct.

CLI/tooling around it:
- **`scripts/record-checkpoint.ts`** — thin CLI over `recordCheckpoint`.
- **`.claude/skills/query-overtime-db/scripts/query.ts`** — reads the three tables filtered by a datetime
  range; JSON output by default, `--pretty` for a table. Self-bootstraps and calls `initDb()` first.
- **`.claude/skills/b2b-overtime/scripts/analyze-overtime.ts`** — the collector + reporter. Discovers the
  target repo's worktrees under `~/Workspace/swf` (git via `child_process`), mines Claude session prompts
  and git reflog, uses **luxon** for DST-correct `Australia/Sydney` bucketing, prints the fixed 7-column
  report, and (by default, `--save`) **incrementally ingests** activity into `session_prompt` / `git_reflog`,
  advancing a `checkpoint` each run. It reads the latest checkpoint `data_timestamp` as a high-water mark
  and only processes activity strictly after it; the first run backfills from the earliest available
  activity; `--since T` overrides the stored checkpoint. `#db` is imported **lazily** so `--no-save` runs
  need no DB connection.

## Conventions

- All datetimes are stored and compared as **tz-aware UTC** (Drizzle `timestamp({ withTimezone: true })`,
  JS `Date`). Parse bare dates / naive inputs as UTC; the reporting layer converts to local via luxon.
  Working hours (Mon–Fri 09:00–17:00 Sydney) and the 03:00 day-boundary are domain local-time rules —
  applied at analysis time, not in storage.
- Imports use `.ts` extensions (ESM/NodeNext at runtime under `tsx`); `tsconfig` sets
  `allowImportingTsExtensions` so `tsc --noEmit` also passes. Import the DB layer via `#db`.
- Never commit development-process `.md` files (analysis frameworks, generated planning docs). `CLAUDE.md`,
  `AGENTS.md`, `README.md` are the exception and should be committed.
