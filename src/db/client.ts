import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { loadProjectEnv } from "../bootstrap.ts";
import * as schema from "./schema.ts";

/**
 * Database client — the whole "ORM" layer's connection config lives here.
 *
 * Reads DATABASE_URL from the environment (loading the project's .env if it
 * isn't set yet), hands out a cached Drizzle instance over a postgres.js
 * connection, and exposes ensureSchema()/closeDb(). This is the only module that
 * touches connection config.
 */

let sql: postgres.Sql | null = null;
let db: PostgresJsDatabase<typeof schema> | null = null;

function connectionUrl(): string {
  if (!process.env.DATABASE_URL) loadProjectEnv();
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set (check your .env file)");
  // Neon URLs carry libpq-only params (sslmode, channel_binding) that
  // postgres.js doesn't understand; strip them and enable SSL explicitly.
  const u = new URL(raw);
  u.searchParams.delete("sslmode");
  u.searchParams.delete("channel_binding");
  return u.toString();
}

export function getSql(): postgres.Sql {
  // onnotice: swallow "relation already exists, skipping" NOTICEs from the
  // idempotent ensureSchema DDL so they don't clutter script output.
  if (!sql) sql = postgres(connectionUrl(), { ssl: "require", onnotice: () => {} });
  return sql;
}

export function getDb(): PostgresJsDatabase<typeof schema> {
  if (!db) db = drizzle(getSql(), { schema });
  return db;
}

/** Idempotent CREATE TABLE IF NOT EXISTS for all three tables (was init_db). */
export async function ensureSchema(): Promise<void> {
  await getSql().unsafe(schema.ENSURE_SCHEMA_SQL);
}

/** Close the connection so short-lived CLI processes can exit cleanly. */
export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = null;
    db = null;
  }
}
