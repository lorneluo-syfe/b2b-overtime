// Barrel for the DB layer — import via the "#db" subpath (see package.json).
export { checkpoint, sessionPrompt, gitReflog, ENSURE_SCHEMA_SQL } from "./schema.ts";
export { getDb, getSql, ensureSchema, closeDb } from "./client.ts";
export { initDb, recordCheckpoint, type CheckpointRow } from "./checkpoint.ts";
