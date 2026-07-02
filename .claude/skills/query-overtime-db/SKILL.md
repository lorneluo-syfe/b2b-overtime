---
name: query-overtime-db
description: Read the b2b-overtime activity database (the checkpoint, session_prompt, and git_reflog tables) and filter rows by a datetime range. Use this whenever the user wants to inspect, list, count, or export recorded activity from these tables — e.g. "show me the session prompts from last Tuesday", "what git commits got recorded between 6pm and midnight", "list all checkpoints since July 1", "查一下这段时间的记录", or any request to pull rows out of the b2b-overtime DB filtered by time. Prefer this skill over writing ad-hoc SQL or query code, since it reuses the project's Drizzle DB layer and handles timezone-aware datetime filtering for you.
---

# Query the b2b-overtime activity DB

This skill reads the three activity tables in the b2b-overtime Postgres database
(connection comes from the project's `.env` `DATABASE_URL`) and filters rows by a
datetime range. It wraps the project's Drizzle DB layer (`src/db`, imported via
`#db`) through a bundled TypeScript script, so you don't hand-write SQL or a DB
connection.

## The tables and their datetime fields

| table            | what it holds                                   | datetime fields (default first) |
|------------------|-------------------------------------------------|---------------------------------|
| `checkpoint`     | batch checkpoints                               | `run_timestamp`, `data_timestamp` |
| `session_prompt` | Claude Code prompts (dir, summary, sent/done)   | `sent_at`, `completed_at`       |
| `git_reflog`     | recorded git commits (dir, hash, msg)           | `committed_at`                  |

## How to run it

Run from the project root. The simplest entry is the `pnpm query` script; you can
also invoke the file directly with `npx tsx`. The `.env` is auto-discovered by
walking up to the project root, so cwd doesn't matter.

```bash
pnpm query <table> [options]
# or: npx tsx .claude/skills/query-overtime-db/scripts/query.ts <table> [options]
```

`<table>` is one of `checkpoint`, `session_prompt`, `git_reflog`, or `all`.

Options:
- `--start T` — inclusive lower bound. ISO datetime (`2026-07-01T09:00:00Z`) or a
  bare date (`2026-07-01`, meaning 00:00 UTC).
- `--end T` — **exclusive** upper bound. So `--start 2026-07-01 --end 2026-07-02`
  covers all of July 1st.
- `--field F` — which datetime column to filter and sort on. Defaults to each
  table's primary field (see table above). Only valid for a single table, not `all`.
- `--dir SUBSTR` — keep only rows whose `directory` contains this substring
  (applies to `session_prompt` / `git_reflog`).
- `--limit N` — cap rows per table.
- `--order asc|desc` — sort by the datetime field (default `asc`).
- `--pretty` — print an aligned text table instead of JSON.

Output is a JSON array of row objects by default (datetimes as ISO strings, each
row tagged with `_table`). Use `--pretty` when the user just wants to eyeball it.

## Examples

**List session prompts sent on July 1st (UTC):**
```bash
pnpm query session_prompt --start 2026-07-01 --end 2026-07-02
```

**Git commits recorded after 6pm on a given day, newest first, as a table:**
```bash
pnpm query git_reflog --start 2026-07-01T18:00:00+08:00 --end 2026-07-02T00:00:00+08:00 \
  --order desc --pretty
```

**All three tables since a date (each filtered on its default datetime field):**
```bash
pnpm query all --start 2026-07-01
```

**Checkpoints by their `data_timestamp` rather than `run_timestamp`:**
```bash
pnpm query checkpoint --field data_timestamp --start 2026-06-01 --end 2026-07-01
```

## Notes

- Bare dates and naive datetimes are treated as UTC. Pass an explicit offset
  (e.g. `+08:00`) when the user is reasoning in local time, and convert the
  boundaries accordingly.
- The script calls `initDb()` (idempotent `CREATE TABLE IF NOT EXISTS`) first, so
  it's safe even if a table doesn't exist yet — it just returns no rows.
- If you need an aggregate the CLI doesn't expose (grouping, joins, counts by
  day), it's fine to read `src/db/schema.ts` and write a one-off query with
  `getDb()` from `#db` — but reach for the script first for plain time-range reads.
