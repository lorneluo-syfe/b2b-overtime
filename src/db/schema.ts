import { pgTable, serial, varchar, text, timestamp } from "drizzle-orm/pg-core";

/**
 * ORM schema — three activity tables, all with timezone-aware timestamps.
 *
 * All datetimes are stored as tz-aware UTC (`withTimezone: true`). The domain's
 * local-time rules (working hours, the 03:00 day boundary) are applied only at
 * analysis time, never in storage.
 */

// A single checkpoint row.
//  - run_timestamp  : when this checkpoint row was recorded (this run).
//  - data_timestamp : the timestamp of the data itself, supplied by the caller
//    (e.g. the high-water mark of activity just ingested).
export const checkpoint = pgTable("checkpoint", {
  id: serial("id").primaryKey(),
  runTimestamp: timestamp("run_timestamp", { withTimezone: true }).notNull().defaultNow(),
  dataTimestamp: timestamp("data_timestamp", { withTimezone: true }).notNull(),
});

// A Claude Code prompt you typed.
//  - directory      : the session's working directory (cwd).
//  - prompt_summary : the prompt, single-lined.
//  - sent_at        : when the prompt was sent.
//  - completed_at   : the last assistant message before your next prompt (i.e.
//    when that task finished); nullable.
export const sessionPrompt = pgTable("session_prompt", {
  id: serial("id").primaryKey(),
  directory: varchar("directory", { length: 1024 }).notNull(),
  promptSummary: text("prompt_summary").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

// A recorded git commit (from reflog `commit:` entries — commits YOU made).
//  - directory     : the repo / worktree directory.
//  - commit_hash   : the commit SHA.
//  - committed_at  : commit time.
//  - message       : commit subject line.
export const gitReflog = pgTable("git_reflog", {
  id: serial("id").primaryKey(),
  directory: varchar("directory", { length: 1024 }).notNull(),
  commitHash: varchar("commit_hash", { length: 40 }).notNull(),
  committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
  message: text("message").notNull(),
});

// Idempotent DDL mirroring the schema above — the sole schema-sync mechanism
// (the runtime equivalent of the old init_db()/create_all; there is no migrate
// step). Kept next to the table defs so the two stay in sync; when you change a
// table above, mirror it here. IF NOT EXISTS makes it safe to run every time.
export const ENSURE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS "checkpoint" (
  "id" serial PRIMARY KEY,
  "run_timestamp" timestamp with time zone NOT NULL DEFAULT now(),
  "data_timestamp" timestamp with time zone NOT NULL
);
CREATE TABLE IF NOT EXISTS "session_prompt" (
  "id" serial PRIMARY KEY,
  "directory" varchar(1024) NOT NULL,
  "prompt_summary" text NOT NULL,
  "sent_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone
);
CREATE TABLE IF NOT EXISTS "git_reflog" (
  "id" serial PRIMARY KEY,
  "directory" varchar(1024) NOT NULL,
  "commit_hash" varchar(40) NOT NULL,
  "committed_at" timestamp with time zone NOT NULL,
  "message" text NOT NULL
);
`;
