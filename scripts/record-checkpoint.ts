/**
 * CLI: record a checkpoint.
 *
 * Usage:
 *   pnpm record-checkpoint                       # data_timestamp = now
 *   pnpm record-checkpoint 2026-07-01T00:00:00Z  # explicit data timestamp
 */
import { loadProjectEnv } from "../src/bootstrap.ts";

loadProjectEnv();

const { recordCheckpoint, closeDb } = await import("#db");

function parse(arg: string): Date {
  const dt = new Date(arg);
  if (Number.isNaN(dt.getTime())) throw new Error(`invalid timestamp: ${arg}`);
  return dt;
}

const arg = process.argv[2];
const dataTimestamp = arg ? parse(arg) : new Date();

try {
  const cp = await recordCheckpoint(dataTimestamp);
  console.log(
    `✓ checkpoint #${cp.id} recorded  ` +
      `run_timestamp=${cp.runTimestamp.toISOString()}  ` +
      `data_timestamp=${cp.dataTimestamp.toISOString()}`,
  );
} finally {
  await closeDb();
}
