/**
 * Estimate after-hours / overtime activity for the b2bDatafeedIngestorService repo
 * from local Claude Code session history AND local git reflog/commit history.
 *
 * Pipeline (mirrors the former analyze_overtime.py):
 *   Step 1 — discover repo folders under the workspace whose git origin belongs
 *     to the target repo, expanded via `git worktree list` to pick up ALL worktrees.
 *   Step 2 — map to sessions: scan ~/.claude/projects/*, keep session dirs whose
 *     recorded cwd sits at or under a discovered folder.
 *   Step 3 — collect activity: real user prompts (paired with completion time) +
 *     git reflog entries (HEAD movements) and commit entries across all worktrees.
 *   Step 4 — bucket & estimate: 00:00–03:00 rolls to the previous day; work hours
 *     are Mon–Fri 09:00–17:00 Sydney; OT Hrs = summed span of out-of-hours active
 *     segments (split wherever a gap exceeds --gap-minutes).
 *
 * Prints a fixed 7-column English Markdown report; with --save (default) it also
 * incrementally ingests activity into Neon, advancing a checkpoint each run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { parseArgs } from "node:util";
import { DateTime } from "luxon";
import { loadProjectEnv } from "../../../../src/bootstrap.ts";
import {
  ZONE,
  DEFAULT_GAP_MINUTES,
  WD,
  attributedDay,
  isWorkHours,
  overtimeMs,
  fmtDur,
} from "../../../../src/overtime/rules.ts";

const REPO_SLUG = "b2bdatafeedingestorservice"; // matched case-insensitively in remote URL
const WORKSPACE = join(homedir(), "Workspace/swf"); // where the repo + worktrees live
const PROJECTS_DIR = join(homedir(), ".claude/projects");

// Parses: "<sha> HEAD@{<unix>}: <action>: <subject>"
const REFLOG_RE = /^(\S+)\s+\S+@\{(\d+)\}:\s*(.*)$/;

// --------------------------------------------------------------------------- //
// small fs helpers
// --------------------------------------------------------------------------- //
function listDirs(parent: string): string[] {
  try {
    return readdirSync(parent)
      .map((n) => join(parent, n))
      .filter((p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function listJsonl(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

function git(repo: string, args: string[], timeout: number): string | null {
  try {
    return execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- //
// Step 1 / Step 2 — discovery
// --------------------------------------------------------------------------- //
type JsonlObj = Record<string, any>;

function isRealUserPrompt(obj: JsonlObj): boolean {
  if (obj.type !== "user" || obj.isMeta) return false;
  const content = obj.message?.content;
  if (typeof content === "string") return content.trim() !== "";
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object") {
        if (part.type === "tool_result") return false;
        if (part.type === "text") return true;
      } else if (typeof part === "string") {
        return true;
      }
    }
  }
  return false;
}

function firstCwd(sessionDir: string): string | null {
  for (const f of listJsonl(sessionDir)) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const cwd = JSON.parse(s).cwd;
        if (cwd) return cwd;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function remoteUrl(path: string): string {
  return (git(path, ["config", "--get", "remote.origin.url"], 10000) ?? "").trim();
}

function worktreePaths(repo: string): string[] {
  const out = git(repo, ["worktree", "list", "--porcelain"], 15000);
  if (!out) return [];
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      const p = line.slice("worktree ".length).trim();
      if (p && existsSync(p) && statSync(p).isDirectory()) paths.push(realpath(p));
    }
  }
  return paths;
}

function discoverRepoFolders(workspace: string, verbose: boolean): string[] {
  const folders = new Set<string>();
  for (const d of listDirs(workspace)) {
    if (!remoteUrl(d).toLowerCase().includes(REPO_SLUG)) continue;
    folders.add(realpath(d));
    for (const w of worktreePaths(d)) folders.add(w);
  }
  const sorted = [...folders].sort();
  if (verbose) {
    console.log(`# Step 1: ${sorted.length} repo folder(s) discovered under ${workspace}:`);
    for (const f of sorted) console.log(`  - ${f}`);
  }
  return sorted;
}

interface SessionDir {
  sessionDir: string;
  cwd: string;
  folder: string;
}

function discoverSessionDirs(folders: string[], verbose: boolean): SessionDir[] {
  const matched: SessionDir[] = [];
  for (const d of listDirs(PROJECTS_DIR)) {
    const cwd = firstCwd(d);
    if (!cwd) continue;
    const cwdReal = realpath(cwd);
    const folder = folders.find((f) => cwdReal === f || cwdReal.startsWith(f + sep));
    if (folder) {
      matched.push({ sessionDir: d, cwd, folder });
      if (verbose) console.log(`  matched session: ${basename(d)}  (${cwd})`);
    }
  }
  return matched;
}

// --------------------------------------------------------------------------- //
// Step 3 — activity collection (prompts + reflog + commits)
// --------------------------------------------------------------------------- //
function promptText(obj: JsonlObj): string {
  const content = obj.message?.content;
  const parts: string[] = [];
  if (typeof content === "string") {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p === "object" && p.type === "text") parts.push(p.text ?? "");
    }
  }
  return parts.join(" ").split(/\s+/).filter(Boolean).join(" ").slice(0, 280);
}

function parseTs(ts: unknown): DateTime | null {
  if (typeof ts !== "string" || !ts) return null;
  const dt = DateTime.fromISO(ts, { setZone: false }).setZone(ZONE);
  return dt.isValid ? dt : null;
}

interface PromptRecord {
  dt: DateTime;
  label: string;
  cwd: string;
  summary: string;
  completed: DateTime | null;
}

function collectPromptEvents(dirs: SessionDir[], verbose: boolean): PromptRecord[] {
  const records: PromptRecord[] = [];
  for (const { sessionDir, cwd, folder } of dirs) {
    const label = basename(folder);
    for (const f of listJsonl(sessionDir)) {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue;
      }
      // (ts, isPrompt, isAssistant, summary)
      const items: Array<[DateTime, boolean, boolean, string]> = [];
      for (const line of text.split("\n")) {
        const s = line.trim();
        if (!s) continue;
        let obj: JsonlObj;
        try {
          obj = JSON.parse(s);
        } catch {
          continue;
        }
        const ts = parseTs(obj.timestamp);
        if (!ts) continue;
        const isPrompt = isRealUserPrompt(obj);
        items.push([ts, isPrompt, obj.type === "assistant", isPrompt ? promptText(obj) : ""]);
      }
      items.sort((a, b) => a[0].toMillis() - b[0].toMillis());
      const promptIdx = items.map((it, i) => (it[1] ? i : -1)).filter((i) => i >= 0);
      for (let k = 0; k < promptIdx.length; k++) {
        const i = promptIdx[k];
        const nxt = k + 1 < promptIdx.length ? promptIdx[k + 1] : items.length;
        let completed: DateTime | null = null;
        for (let j = i + 1; j < nxt; j++) {
          if (items[j][2]) completed = items[j][0]; // assistant -> keep the last one
        }
        records.push({ dt: items[i][0], label, cwd, summary: items[i][3], completed });
      }
    }
  }
  if (verbose) console.log(`# Step 3a: ${records.length} Claude prompt event(s) collected`);
  return records;
}

interface CommitRecord {
  dt: DateTime;
  label: string;
  dir: string;
  sha: string;
  message: string;
}

function collectReflog(
  folders: string[],
  since: DateTime,
  verbose: boolean,
): { events: Array<[DateTime, string]>; commits: CommitRecord[] } {
  const events: Array<[DateTime, string]> = [];
  const commits = new Map<string, CommitRecord>();
  const seen = new Set<string>();
  for (const repo of folders) {
    const label = basename(repo);
    const out = git(repo, ["reflog", "--date=unix", `--since=${since.toISO()}`], 30000);
    if (out === null) continue;
    let nRepo = 0;
    for (const line of out.split("\n")) {
      const m = REFLOG_RE.exec(line);
      if (!m) continue;
      const sha = m[1];
      const unix = parseInt(m[2], 10);
      const action = m[3];
      const key = `${sha} ${unix}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dt = DateTime.fromSeconds(unix, { zone: ZONE });
      events.push([dt, label]);
      if (action.startsWith("commit:") || action.startsWith("commit (")) {
        const message = action.includes(":") ? action.split(/:(.+)/)[1].trim() : action;
        if (!commits.has(sha)) {
          commits.set(sha, { dt, label, dir: repo, sha, message: message.slice(0, 280) });
        }
      }
      nRepo++;
    }
    if (verbose) console.log(`# Step 3b: ${nRepo} reflog event(s) from ${label}`);
  }
  if (verbose) console.log(`# Step 3c: ${commits.size} commit(s) (your own, from reflog)`);
  return { events, commits: [...commits.values()] };
}

// --------------------------------------------------------------------------- //
// Step 4 — bucketing & overtime estimation
// --------------------------------------------------------------------------- //
// The bucketing primitives (attributedDay / isWorkHours / overtimeMs / fmtDur)
// live in ../../../../src/overtime/rules.ts — the single source of truth shared
// with the dashboard server — and are imported at the top of this file.

interface Analysis {
  gapMinutes: number;
  chatWork: Map<string, number>;
  chatOt: Map<string, number>;
  gitWork: Map<string, number>;
  gitOt: Map<string, number>;
  outTimes: Map<string, DateTime[]>;
  folders: string[]; // basenames
  covPrompts: Map<string, number>;
  covReflog: Map<string, number>;
  promptRecords: PromptRecord[];
  commitRecords: CommitRecord[];
}

function inc(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function analyze(
  startDate: DateTime,
  endDate: DateTime,
  workspace: string,
  gapMinutes: number,
  verbose: boolean,
  collectSince: DateTime | null,
): Analysis {
  const folders = discoverRepoFolders(workspace, verbose);
  if (!folders.length) {
    throw new Error(
      `No repo folders for '*${REPO_SLUG}*' found under ${workspace}. ` +
        "Check the workspace path (--workspace) or that the repo is cloned there.",
    );
  }
  const dirs = discoverSessionDirs(folders, verbose);

  // Scan git a little before the window so day-rollover edges are covered.
  // collectSince (checkpoint watermark, or a far-back date on first run) widens
  // the reflog scan for ingestion so persistence isn't clipped to the report window.
  let since = startDate.minus({ days: 1 }).startOf("day");
  if (collectSince && collectSince < since) since = collectSince;

  const promptRecords = collectPromptEvents(dirs, verbose);
  const { events: reflogEvents, commits: commitRecords } = collectReflog(folders, since, verbose);

  if (!promptRecords.length && !reflogEvents.length) {
    throw new Error(
      `Found ${folders.length} repo folder(s) under ${workspace} but no Claude ` +
        "prompts and no reflog activity to analyse.",
    );
  }

  const chatWork = new Map<string, number>();
  const chatOt = new Map<string, number>();
  const gitWork = new Map<string, number>();
  const gitOt = new Map<string, number>();
  const outTimes = new Map<string, DateTime[]>();
  const covPrompts = new Map<string, number>();
  const covReflog = new Map<string, number>();

  const startKey = startDate.toISODate()!;
  const endKey = endDate.toISODate()!;
  const inRange = (key: string) => key >= startKey && key <= endKey;
  const pushOut = (key: string, dt: DateTime) => {
    const arr = outTimes.get(key);
    if (arr) arr.push(dt);
    else outTimes.set(key, [dt]);
  };

  for (const rec of promptRecords) {
    const key = attributedDay(rec.dt).toISODate()!;
    if (!inRange(key)) continue;
    inc(covPrompts, rec.label);
    if (isWorkHours(rec.dt)) inc(chatWork, key);
    else {
      inc(chatOt, key);
      pushOut(key, rec.dt);
    }
  }

  for (const [dt, label] of reflogEvents) {
    const key = attributedDay(dt).toISODate()!;
    if (!inRange(key)) continue;
    inc(covReflog, label);
    if (!isWorkHours(dt)) pushOut(key, dt); // density only; not a displayed column
  }

  for (const rec of commitRecords) {
    const key = attributedDay(rec.dt).toISODate()!;
    if (!inRange(key)) continue;
    if (isWorkHours(rec.dt)) inc(gitWork, key);
    else inc(gitOt, key);
  }

  return {
    gapMinutes,
    chatWork,
    chatOt,
    gitWork,
    gitOt,
    outTimes,
    folders: folders.map((f) => basename(f)),
    covPrompts,
    covReflog,
    promptRecords,
    commitRecords,
  };
}

function render(data: Analysis, startDate: DateTime, endDate: DateTime): string {
  const gap = data.gapMinutes;
  const lines: string[] = [];
  lines.push(
    `## Overtime report  ${startDate.toISODate()} ~ ${endDate.toISODate()}  ` +
      `(repo: ${REPO_SLUG}, tz: ${ZONE})`,
  );
  lines.push("");

  const withData = data.folders
    .filter((f) => (data.covPrompts.get(f) ?? 0) || (data.covReflog.get(f) ?? 0))
    .sort();
  const empty = data.folders.filter((f) => !withData.includes(f)).sort();
  lines.push(`**Folders with data in range (${withData.length} of ${data.folders.length}):**`);
  for (const f of withData) {
    lines.push(
      `- ${f} — ${data.covPrompts.get(f) ?? 0} prompts, ${data.covReflog.get(f) ?? 0} reflog events`,
    );
  }
  if (empty.length) lines.push(`- _(no data in range: ${empty.join(", ")})_`);
  lines.push("");

  lines.push("| Date | weekday | Chat@Work | Git@Work | Chat OT | Git OT | OT Hrs |");
  lines.push("|------|---------|----------:|---------:|--------:|-------:|-------:|");

  const allDays = [
    ...new Set([
      ...data.chatWork.keys(),
      ...data.chatOt.keys(),
      ...data.gitWork.keys(),
      ...data.gitOt.keys(),
      ...data.outTimes.keys(),
    ]),
  ].sort();

  let tCw = 0, tGw = 0, tCo = 0, tGo = 0, tOt = 0;
  for (const day of allDays) {
    const cw = data.chatWork.get(day) ?? 0;
    const gw = data.gitWork.get(day) ?? 0;
    const co = data.chatOt.get(day) ?? 0;
    const go = data.gitOt.get(day) ?? 0;
    const ot = overtimeMs(data.outTimes.get(day) ?? [], gap);
    tCw += cw; tGw += gw; tCo += co; tGo += go; tOt += ot;
    const weekday = WD[DateTime.fromISO(day, { zone: ZONE }).weekday - 1];
    lines.push(`| ${day} | ${weekday} | ${cw} | ${gw} | ${co} | ${go} | ${ot ? fmtDur(ot) : "—"} |`);
  }

  lines.push(
    `| **Total** | | **${tCw}** | **${tGw}** | **${tCo}** | **${tGo}** | **${fmtDur(tOt)}** |`,
  );
  return lines.join("\n");
}

// --------------------------------------------------------------------------- //
// Persistence — incremental ingest into Neon (DB deps imported lazily)
// --------------------------------------------------------------------------- //
type DbModule = typeof import("#db");

async function checkpointWatermark(): Promise<Date | null> {
  const db: DbModule = await import("#db");
  const { getDb, initDb, checkpoint } = db;
  const { max } = await import("drizzle-orm");
  await initDb();
  const [row] = await getDb().select({ m: max(checkpoint.dataTimestamp) }).from(checkpoint);
  return row?.m ?? null;
}

async function persist(data: Analysis, watermark: Date | null, _verbose: boolean): Promise<void> {
  let db: DbModule;
  try {
    db = await import("#db");
  } catch (e) {
    console.log(
      `# --save skipped: DB layer not importable (${e}). ` +
        "Run from the project (pnpm overtime …) to enable DB writes.",
    );
    return;
  }
  const { getDb, initDb, recordCheckpoint, closeDb, sessionPrompt, gitReflog } = db;
  await initDb();

  let prompts = data.promptRecords;
  let commits = data.commitRecords;
  if (watermark) {
    const wm = watermark.getTime();
    prompts = prompts.filter((r) => r.dt.toMillis() > wm);
    commits = commits.filter((r) => r.dt.toMillis() > wm);
  }

  const windowMs = [...prompts.map((r) => r.dt.toMillis()), ...commits.map((r) => r.dt.toMillis())];
  if (!windowMs.length) {
    const wm = watermark ? watermark.toISOString() : "(none)";
    console.log(`# No new activity after checkpoint ${wm} — nothing to ingest.`);
    await closeDb();
    return;
  }
  const latest = new Date(Math.max(...windowMs));
  if (!watermark) {
    console.log(
      `# First run (no checkpoint): ingesting from earliest activity ` +
        `${new Date(Math.min(...windowMs)).toISOString()}`,
    );
  }

  const database = getDb();
  let nPrompt = 0;
  let nCommit = 0;

  const existingP = new Set<string>();
  for (const r of await database.select({ d: sessionPrompt.directory, s: sessionPrompt.sentAt }).from(sessionPrompt)) {
    existingP.add(`${r.d} ${r.s?.toISOString()}`);
  }
  const promptRows: Array<typeof sessionPrompt.$inferInsert> = [];
  for (const r of prompts) {
    const sentAt = r.dt.toJSDate();
    const key = `${r.cwd} ${sentAt.toISOString()}`;
    if (existingP.has(key)) continue;
    existingP.add(key);
    promptRows.push({
      directory: r.cwd,
      promptSummary: r.summary || "",
      sentAt,
      completedAt: r.completed ? r.completed.toJSDate() : null,
    });
    nPrompt++;
  }

  const existingC = new Set<string>();
  for (const r of await database.select({ h: gitReflog.commitHash }).from(gitReflog)) {
    existingC.add(r.h);
  }
  const commitRows: Array<typeof gitReflog.$inferInsert> = [];
  for (const r of commits) {
    if (existingC.has(r.sha)) continue;
    existingC.add(r.sha);
    commitRows.push({
      directory: r.dir,
      commitHash: r.sha,
      committedAt: r.dt.toJSDate(),
      message: r.message,
    });
    nCommit++;
  }

  if (promptRows.length) await database.insert(sessionPrompt).values(promptRows);
  if (commitRows.length) await database.insert(gitReflog).values(commitRows);

  // Advance the watermark to the latest activity ingested this run.
  const cp = await recordCheckpoint(latest);
  console.log(
    `# Ingested: +${nPrompt} session_prompt, +${nCommit} git_reflog. ` +
      `checkpoint #${cp.id} data_timestamp=${cp.dataTimestamp.toISOString()}`,
  );
  await closeDb();
}

// --------------------------------------------------------------------------- //
// CLI
// --------------------------------------------------------------------------- //
/** YYYY-MM-DD -> local start-of-day DateTime. */
function parseDate(s: string): DateTime {
  const dt = DateTime.fromISO(s, { zone: ZONE });
  if (!dt.isValid) throw new Error(`invalid date (YYYY-MM-DD): ${s}`);
  return dt.startOf("day");
}

/** Explicit ingest boundary -> DateTime (local Sydney if no offset). */
function parseSince(s: string): DateTime {
  const dt = DateTime.fromISO(s.trim().replace(" ", "T"), { zone: ZONE });
  if (!dt.isValid) throw new Error(`invalid --since: ${s}`);
  return dt;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      start: { type: "string" },
      end: { type: "string" },
      workspace: { type: "string", default: WORKSPACE },
      "gap-minutes": { type: "string" },
      verbose: { type: "boolean", default: false },
      save: { type: "boolean", default: true },
      "no-save": { type: "boolean", default: false },
      since: { type: "string" },
    },
  });

  const gapMinutes = values["gap-minutes"] ? Number(values["gap-minutes"]) : DEFAULT_GAP_MINUTES;
  const verbose = Boolean(values.verbose);
  let save = !values["no-save"];

  // No window given → default to the past week (today + the 6 days before it).
  const today = DateTime.now().setZone(ZONE).startOf("day");
  const end = values.end ? parseDate(values.end) : today;
  const start = values.start ? parseDate(values.start) : end.minus({ days: 6 });
  if (start > end) throw new Error("--start must be on or before --end");

  // For DB ingestion: start from the checkpoint watermark and widen the git scan.
  // First run → scan far back. An explicit --since overrides the stored checkpoint.
  let watermark: Date | null = null;
  let collectSince: DateTime | null = null;
  if (save) {
    if (values.since) {
      const since = parseSince(values.since);
      watermark = since.toJSDate();
      collectSince = since;
    } else {
      try {
        watermark = await checkpointWatermark();
      } catch (e) {
        console.log(`# --save: DB unavailable (${e}); continuing report-only.`);
        save = false;
      }
      collectSince = watermark
        ? DateTime.fromJSDate(watermark).setZone(ZONE)
        : DateTime.fromObject({ year: 2000, month: 1, day: 1 }, { zone: ZONE });
    }
  }

  const data = analyze(start, end, values.workspace!, gapMinutes, verbose, collectSince);
  console.log(render(data, start, end));

  if (save) await persist(data, watermark, verbose);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  // Ensure any DB connection opened during --save is closed so the process exits.
  try {
    const { closeDb } = await import("#db");
    await closeDb();
  } catch {
    /* DB layer never loaded (e.g. --no-save) */
  }
}
