/**
 * Query the b2b-overtime activity tables, filtered by a datetime range.
 *
 * Tables (see src/db/schema.ts):
 *   checkpoint      -> datetime fields: run_timestamp (default), data_timestamp
 *   session_prompt  -> datetime fields: sent_at (default), completed_at
 *   git_reflog      -> datetime fields: committed_at (default)
 *
 * Usage:
 *   pnpm query <table> [--start T] [--end T] [--field F]
 *                      [--dir SUBSTR] [--limit N] [--order asc|desc] [--pretty]
 *
 *   <table> is one of: checkpoint | session_prompt | git_reflog | all
 *
 * Datetime inputs accept ISO-8601 (2026-07-01T09:00:00Z) or a bare date
 * (2026-07-01, interpreted as 00:00 UTC). --start is inclusive, --end is
 * exclusive, so --start 2026-07-01 --end 2026-07-02 = all of July 1st.
 *
 * Output is JSON (a list of row objects) unless --pretty is given.
 */
import { parseArgs } from "node:util";
import { and, asc, desc, gte, like, lt, type Column } from "drizzle-orm";
import { loadProjectEnv } from "../../../../src/bootstrap.ts";

loadProjectEnv();

const { getDb, initDb, closeDb, checkpoint, sessionPrompt, gitReflog } = await import("#db");

type TableName = "checkpoint" | "session_prompt" | "git_reflog";

// table name -> { table, output column order (db name -> js prop), datetime
// fields (first is the default), and whether it has a `directory` column }.
interface TableSpec {
  table: any;
  columns: Array<[string, string]>; // [dbColumnName, jsProp]
  dtFields: Record<string, Column>; // db field name -> drizzle column
  defaultField: string;
  directory?: Column;
}

const TABLES: Record<TableName, TableSpec> = {
  checkpoint: {
    table: checkpoint,
    columns: [["id", "id"], ["run_timestamp", "runTimestamp"], ["data_timestamp", "dataTimestamp"]],
    dtFields: { run_timestamp: checkpoint.runTimestamp, data_timestamp: checkpoint.dataTimestamp },
    defaultField: "run_timestamp",
  },
  session_prompt: {
    table: sessionPrompt,
    columns: [
      ["id", "id"], ["directory", "directory"], ["prompt_summary", "promptSummary"],
      ["sent_at", "sentAt"], ["completed_at", "completedAt"],
    ],
    dtFields: { sent_at: sessionPrompt.sentAt, completed_at: sessionPrompt.completedAt },
    defaultField: "sent_at",
    directory: sessionPrompt.directory,
  },
  git_reflog: {
    table: gitReflog,
    columns: [
      ["id", "id"], ["directory", "directory"], ["commit_hash", "commitHash"],
      ["committed_at", "committedAt"], ["message", "message"],
    ],
    dtFields: { committed_at: gitReflog.committedAt },
    defaultField: "committed_at",
    directory: gitReflog.directory,
  },
};

/** Parse an ISO datetime or bare date into a UTC Date (naive inputs = UTC). */
function parseDt(value: string): Date {
  let text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    text += "T00:00:00Z";
  } else {
    text = text.replace(" ", "T");
    if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(text)) text += "Z";
  }
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid datetime: ${value}`);
  return d;
}

interface Args {
  start?: string;
  end?: string;
  field?: string;
  dir?: string;
  limit?: number;
  order: "asc" | "desc";
  pretty: boolean;
}

async function queryTable(name: TableName, args: Args): Promise<Record<string, unknown>[]> {
  const spec = TABLES[name];
  const field = args.field ?? spec.defaultField;
  const column = spec.dtFields[field];
  if (!column) {
    throw new Error(
      `table '${name}' has no datetime field '${field}'. available: ${Object.keys(spec.dtFields).join(", ")}`,
    );
  }

  const conds = [];
  if (args.start !== undefined) conds.push(gte(column, parseDt(args.start)));
  if (args.end !== undefined) conds.push(lt(column, parseDt(args.end)));
  if (args.dir && spec.directory) conds.push(like(spec.directory, `%${args.dir}%`));

  let q = getDb().select().from(spec.table).$dynamic();
  if (conds.length) q = q.where(and(...conds));
  q = q.orderBy(args.order === "desc" ? desc(column) : asc(column));
  if (args.limit) q = q.limit(args.limit);

  const rows = await q;
  return rows.map((row: any) => {
    const out: Record<string, unknown> = {};
    for (const [dbName, jsProp] of spec.columns) {
      const val = row[jsProp];
      out[dbName] = val instanceof Date ? val.toISOString() : val;
    }
    out._table = name;
    return out;
  });
}

function printPretty(rows: Record<string, unknown>[]): void {
  if (!rows.length) {
    console.log("(no rows)");
    return;
  }
  const cols = Object.keys(rows[0]).filter((c) => c !== "_table");
  const widths: Record<string, number> = {};
  for (const c of cols) {
    widths[c] = Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length));
  }
  const pad = (s: string, w: number) => s.padEnd(w);
  console.log(cols.map((c) => pad(c, widths[c])).join("  "));
  console.log(cols.map((c) => "-".repeat(widths[c])).join("  "));
  for (const r of rows) {
    console.log(cols.map((c) => pad(String(r[c] ?? ""), widths[c])).join("  "));
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      start: { type: "string" },
      end: { type: "string" },
      field: { type: "string" },
      dir: { type: "string" },
      limit: { type: "string" },
      order: { type: "string", default: "asc" },
      pretty: { type: "boolean", default: false },
    },
  });

  const table = positionals[0];
  const valid = [...Object.keys(TABLES), "all"];
  if (!table || !valid.includes(table)) {
    throw new Error(`table must be one of: ${valid.join(" | ")}`);
  }
  if ((values.order as string) !== "asc" && (values.order as string) !== "desc") {
    throw new Error("--order must be asc or desc");
  }
  if (table === "all" && values.field) {
    throw new Error("--field cannot be combined with table 'all'");
  }

  const args: Args = {
    start: values.start,
    end: values.end,
    field: values.field,
    dir: values.dir,
    limit: values.limit ? Number(values.limit) : undefined,
    order: values.order as "asc" | "desc",
    pretty: Boolean(values.pretty),
  };

  await initDb(); // idempotent; ensures tables exist

  const names = (table === "all" ? Object.keys(TABLES) : [table]) as TableName[];
  const rows: Record<string, unknown>[] = [];
  for (const name of names) rows.push(...(await queryTable(name, args)));

  if (args.pretty) printPretty(rows);
  else console.log(JSON.stringify(rows, null, 2));
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await closeDb();
}
