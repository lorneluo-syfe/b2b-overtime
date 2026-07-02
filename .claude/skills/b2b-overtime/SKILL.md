---
name: b2b-overtime
description: >-
  Estimate after-hours / overtime work for the b2bDatafeedIngestorService repo
  (git@github.com:SvavaCapital/b2bdatafeedingestorservice.git) from local Claude
  Code session history AND local git reflog/commit history. Use whenever the user
  asks how much they worked, chatted, or coded outside business hours — e.g. "how
  many chats did I do out of working hours", "estimate my overtime", "加班统计",
  "非工作时间的提问", "after-hours activity", or wants a per-day breakdown of
  working-hour vs out-of-hours activity (prompts + git activity) across all
  worktrees of this project. If the user gives no date range, default to the
  past week (last 7 days).
---

# B2B Overtime Estimator

Estimates after-hours activity for the **b2bDatafeedIngestorService** repo by
mining two local signals and merging them on a timeline:

1. **Claude Code prompts** — the messages you actually typed (tool results and
   system messages excluded).
2. **Git reflog** — every HEAD movement (commit, checkout, rebase, reset, pull,
   …) across all of the repo's worktrees. This catches coding activity that
   happened outside Claude Code.

Both are bucketed into working-hour vs out-of-hours by local Sydney time, and a
daily overtime estimate is built from the **density** of out-of-hours activity.
The report is in **English** and also shows how many commits you made during
working hours vs during overtime.

## How it works — four steps

The script (`scripts/analyze-overtime.ts`) runs a fixed pipeline. Each step is a
function you can adjust independently:

1. **Discover repo folders** (`discover_repo_folders`). Every immediate subdir of
   the workspace (`~/Workspace/swf` by default, override with `--workspace`)
   whose git `remote.origin.url` contains `b2bdatafeedingestorservice` is kept
   and expanded with `git worktree list`, so **all worktrees** are picked up
   automatically — the main checkout plus `dev`, `main`, `ap-*`, and anything
   under `./.worktree/` — across several clones. Paths are realpath-normalised
   and deduped.
2. **Map folders to sessions** (`discover_session_dirs`). Scan
   `~/.claude/projects/*`, read each session's recorded `cwd`, and keep the
   session dirs whose `cwd` sits at or under one of the discovered folders.
3. **Collect activity from both sources** (`collect_prompt_events`,
   `collect_reflog`). Prompts come from the matched session dirs; reflog entries
   come from **every discovered worktree** (deduped across worktrees by SHA +
   timestamp). Commits are taken from the reflog's `commit:` entries — these are
   the commits **you** made on this machine, so teammates' pulled-in commits and
   author-email ambiguity never inflate the count.
4. **Bucket & estimate** (`analyze` + `render`). See the rules below.

Pass `--verbose` to print the Step 1 folder list, Step 2 session matches, and
per-source event counts — the quickest way to sanity-check coverage.

Limitation: a worktree that was fully deleted no longer appears in Step 1, so
sessions/reflog run only there can't be attributed. Reflog also expires (git's
default ~90 days), so very old windows may under-count git activity.

## Overtime rules (baked into the script)

- **Day boundary** — activity between **00:00 and 03:00 is attributed to the
  PREVIOUS calendar day**. A session that runs past midnight belongs to the day
  it started on, so a 22:00→01:30 stretch lands on one day, not split across two.
- **Working hours** — Monday–Friday, **09:00–17:00** local Sydney time.
  Everything else (early mornings, evenings, nights, weekends) is out-of-hours.
- **Overtime duration** — for each day, take all out-of-hours events (prompts +
  reflog combined), sort them, and split into **active segments** wherever two
  consecutive events are more than `--gap-minutes` apart (default **45**).
  Overtime = the summed span of those segments. **Long idle gaps are excluded** —
  only the dense, actually-active stretches accumulate. A lone event with no
  neighbour inside the gap window contributes 0 (it isn't a work session). This
  replaces the old "PM-window only" heuristic: morning and evening bursts both
  count, but isolated one-off pings don't.
- **Commits** — each of your reflog `commit:` entries is classified work-hours
  vs overtime by the same rules and counted per day and in total.

If the user wants a different convention (different idle threshold, shifted
working hours, a different day-rollover hour), the constants live near the top of
the script (`DAY_ROLLOVER_HOUR`, `DEFAULT_GAP_MINUTES`, the `is_work_hours`
function) — adjust those rather than post-processing the output. The idle
threshold is also exposed as `--gap-minutes`.

## Date range — defaults to the past week

**If the user gives no date range, default to the past week** (today and the 6
days before it, 7 inclusive days) — just run it; the script applies this default
on its own when `--start`/`--end` are omitted, so you don't have to compute the
dates. Mention the window you used so the user can widen it if they meant
something longer.

When the user *does* name a window, convert natural phrases to explicit dates
yourself and pass them in:

- "最近两周" / "last 2 weeks" → today minus 13 days, through today (inclusive).
- "上个月" / "last month" → first to last day of the previous calendar month.
- A single month like "2026-05" → that month's first to last day.

Dates are interpreted in local Sydney time and are **inclusive** on both ends.

## Running it

This skill lives inside the b2b-overtime project and, by default, **saves the
collected activity to the Neon database** (see "Persistence" below). Run it from
the project root; the `.env` is auto-discovered by walking up to the root:

```bash
cd /Users/lorneluo/Workspace/swf/b2b-overtime
pnpm overtime --start YYYY-MM-DD --end YYYY-MM-DD
# or: npx tsx .claude/skills/b2b-overtime/scripts/analyze-overtime.ts --start … --end …
```

If you only want the report and don't want to touch the DB, add `--no-save`; the
DB layer is imported lazily, so `--no-save` runs never open a connection.

Flags:
- `--save` / `--no-save` — ingest new activity into Neon (default: **on**).
- `--since T` — explicit ingest boundary that **overrides the stored checkpoint**
  for this run: only activity strictly after `T` is ingested. Accepts a bare date
  or datetime, interpreted in local Sydney time when no offset is given
  (`2026-06-01`, `"2026-06-01 13:13"`, `2026-06-01T13:13:00+10:00`). Use it to
  backfill from a chosen point regardless of what the checkpoint says. The
  checkpoint still advances to the latest activity ingested afterward.
- `--verbose` — print discovered repo folders, matched session dirs, and
  per-source event counts. Use this to sanity-check coverage.
- `--workspace PATH` — where the repo and its worktrees live (default
  `~/Workspace/swf`). Only change it if the clones live elsewhere.
- `--gap-minutes N` — idle gap that splits active segments (default 45).

## Persistence — incremental ingest into Neon

When saving (the default), collected activity is written to three tables via the
project's Drizzle DB layer (`src/db`, imported via `#db`; `DATABASE_URL` from `.env`):

- **`session_prompt`** — one row per real prompt you typed: `directory` (session
  cwd), `prompt_summary` (the prompt, single-lined), `sent_at`, and `completed_at`
  (the last assistant message before your next prompt — i.e. when that task
  finished). Deduped by `(directory, sent_at)`.
- **`git_reflog`** — one row per commit **you** made (from reflog `commit:`
  entries): `directory`, `commit_hash`, `committed_at`, `message` (subject line).
  Deduped by `commit_hash`.
- **`checkpoint`** — a high-water mark recorded after each successful ingest.

**Incremental by checkpoint** — each run reads the latest checkpoint's
`data_timestamp`: everything at or before it is already ingested, so only activity
*strictly after* it is processed, and the checkpoint then advances to the latest
activity just ingested. The **first run** (no checkpoint) scans from the earliest
available session/reflog activity and backfills everything. This makes the script
safe to run periodically — re-runs only top up what's new.

To ingest from a **specific point** instead of the stored checkpoint, pass
`--since T` (see Flags). Dedup still applies, so this is safe to combine with an
existing dataset; the checkpoint advances to the latest activity as usual. Example
— backfill everything after a chosen boundary and show the full span in the report:

```bash
pnpm overtime --since "2026-06-01 13:13" --start 2026-06-01
```

Note: the DB accumulates *all* activity (not clipped to `--start/--end`); only the
printed report is scoped to the date window.

The script prints a finished English Markdown report. **Relay it to the user
as-is** — do not re-derive, reformat, or add columns/sections. The format is
fixed: a title line, then a **Folders with data** coverage block, then exactly
this seven-column per-day table followed by a **Total** row, and **nothing below
the table**.

The coverage block lists every discovered folder that actually contributed
prompts or reflog events in the date range (with its counts), and names the
discovered folders that had no data. It comes first on purpose: it's the
fastest way to confirm all repo folders/worktrees were scanned and nothing was
silently skipped — surface it to the user, don't drop it.

```
| Date | weekday | Chat@Work | Git@Work | Chat OT | Git OT | OT Hrs |
```

- **Chat@Work / Chat OT** — Claude prompts you typed, during work hours / out of
  hours.
- **Git@Work / Git OT** — commits **you** made (from reflog `commit:` entries),
  during work hours / out of hours.
- **OT Hrs** — overtime duration: the summed span of out-of-hours active
  segments. Note this density uses *all* out-of-hours activity (prompts + every
  reflog HEAD movement), so it reflects real engagement even though the Git
  columns themselves only count commits.

## Timezone note

Times use `Australia/Sydney` (via luxon), which automatically applies AEST
(UTC+10) or AEDT (UTC+11) depending on the date.
