import { ensureSchema, getDb } from "./client.ts";
import { checkpoint } from "./schema.ts";

/** Create tables that don't exist yet (idempotent). Alias of ensureSchema. */
export async function initDb(): Promise<void> {
  await ensureSchema();
}

export interface CheckpointRow {
  id: number;
  runTimestamp: Date;
  dataTimestamp: Date;
}

/**
 * Insert one checkpoint row.
 *
 * @param dataTimestamp timestamp of the data (supplied by the caller).
 * @param runTimestamp  when this run happened; defaults to now.
 * @returns the persisted checkpoint (with its assigned id).
 */
export async function recordCheckpoint(
  dataTimestamp: Date,
  runTimestamp?: Date,
): Promise<CheckpointRow> {
  await initDb();
  const values = runTimestamp
    ? { runTimestamp, dataTimestamp }
    : { dataTimestamp };
  const [row] = await getDb().insert(checkpoint).values(values).returning();
  return row as CheckpointRow;
}
