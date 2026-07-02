/**
 * DB-sourced overtime report — reads the activity already ingested into Neon
 * (`session_prompt` + `git_reflog`) and buckets it with the shared rules to
 * produce the dashboard's table, coverage list, and activity heatmap.
 *
 * This mirrors the CLI collector's Step 4 (`analyze()` in analyze-overtime.ts)
 * but sources events from the database instead of scanning disk. One documented
 * consequence: the CLI's OT-Hrs density uses EVERY git reflog HEAD movement,
 * whereas the DB only stores commits — so here the density (and thus OT Hrs) is
 * built from prompts + commits only, and may read slightly lower than the CLI.
 * The six count columns match the CLI exactly.
 */
import { DateTime } from "luxon";
import { and, gte, lt, min, max } from "drizzle-orm";
import { basename } from "node:path";
import { getDb, initDb, sessionPrompt, gitReflog } from "#db";
import {
  ZONE,
  DEFAULT_GAP_MINUTES,
  WD,
  attributedDay,
  isWorkHours,
  overtimeMs,
  fmtDur,
} from "./rules.ts";

export interface ReportRow {
  date: string; // YYYY-MM-DD (attributed day, local)
  weekday: string; // Mon..Sun
  chatWork: number;
  gitWork: number;
  chatOt: number;
  gitOt: number;
  otMs: number;
  otLabel: string; // fmtDur(otMs), or "—" when 0
}

export interface CoverageRow {
  folder: string; // basename of the directory
  directory: string; // full directory
  prompts: number;
  commits: number;
}

export interface HeatCell {
  date: string; // attributed day, YYYY-MM-DD
  hour: number; // 0..23, actual local hour of the event
  count: number; // prompts + commits in that (day, hour)
}

export interface Report {
  range: { start: string; end: string; zone: string; gap: number };
  rows: ReportRow[];
  total: Omit<ReportRow, "date" | "weekday">;
  coverage: CoverageRow[];
  heatmap: HeatCell[];
  // Full extent of activity in the DB (attributed days, local), for the "All
  // time" preset. null when the DB is empty.
  bounds: { start: string; end: string } | null;
}

export interface BuildReportOptions {
  start: string; // YYYY-MM-DD, local Sydney, inclusive
  end: string; // YYYY-MM-DD, local Sydney, inclusive
  gap?: number; // idle-gap minutes; defaults to DEFAULT_GAP_MINUTES
}

/** YYYY-MM-DD -> local start-of-day DateTime (throws on invalid). */
function parseDate(s: string): DateTime {
  const dt = DateTime.fromISO(s, { zone: ZONE });
  if (!dt.isValid) throw new Error(`invalid date (YYYY-MM-DD): ${s}`);
  return dt.startOf("day");
}

function inc(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Query the DB and bucket everything into the dashboard report shape. */
export async function buildReport(opts: BuildReportOptions): Promise<Report> {
  const gap = opts.gap && opts.gap > 0 ? opts.gap : DEFAULT_GAP_MINUTES;
  const startDate = parseDate(opts.start);
  const endDate = parseDate(opts.end);
  if (startDate > endDate) throw new Error("start must be on or before end");

  await initDb();
  const db = getDb();

  // Widen the SQL window by a day on each side so the 03:00 day-rollover and
  // late-night activity that attributes into the range are not clipped.
  const lo = startDate.minus({ days: 1 }).toJSDate();
  const hi = endDate.plus({ days: 2 }).toJSDate(); // end-of-range + rollover slack

  const prompts = await db
    .select({ directory: sessionPrompt.directory, sentAt: sessionPrompt.sentAt })
    .from(sessionPrompt)
    .where(and(gte(sessionPrompt.sentAt, lo), lt(sessionPrompt.sentAt, hi)));

  const commits = await db
    .select({ directory: gitReflog.directory, committedAt: gitReflog.committedAt })
    .from(gitReflog)
    .where(and(gte(gitReflog.committedAt, lo), lt(gitReflog.committedAt, hi)));

  // Full activity extent across the whole DB (unbounded by the window), used by
  // the dashboard's "All time" preset.
  const [pB] = await db
    .select({ mn: min(sessionPrompt.sentAt), mx: max(sessionPrompt.sentAt) })
    .from(sessionPrompt);
  const [cB] = await db
    .select({ mn: min(gitReflog.committedAt), mx: max(gitReflog.committedAt) })
    .from(gitReflog);
  const boundMin = [pB?.mn, cB?.mn].filter(Boolean).map((d) => new Date(d as any).getTime());
  const boundMax = [pB?.mx, cB?.mx].filter(Boolean).map((d) => new Date(d as any).getTime());
  const bounds =
    boundMin.length && boundMax.length
      ? {
          start: attributedDay(DateTime.fromMillis(Math.min(...boundMin)).setZone(ZONE)).toISODate()!,
          end: attributedDay(DateTime.fromMillis(Math.max(...boundMax)).setZone(ZONE)).toISODate()!,
        }
      : null;

  const startKey = startDate.toISODate()!;
  const endKey = endDate.toISODate()!;
  const inRange = (key: string) => key >= startKey && key <= endKey;

  const chatWork = new Map<string, number>();
  const chatOt = new Map<string, number>();
  const gitWork = new Map<string, number>();
  const gitOt = new Map<string, number>();
  const outTimes = new Map<string, DateTime[]>();
  const heat = new Map<string, number>(); // `${dayKey}\t${hour}` -> count
  const covPrompts = new Map<string, number>();
  const covCommits = new Map<string, number>();

  const pushOut = (key: string, dt: DateTime) => {
    const arr = outTimes.get(key);
    if (arr) arr.push(dt);
    else outTimes.set(key, [dt]);
  };
  const pushHeat = (dayKey: string, dt: DateTime) => inc(heat, `${dayKey}\t${dt.hour}`);

  for (const p of prompts) {
    const dt = DateTime.fromJSDate(p.sentAt as Date).setZone(ZONE);
    const key = attributedDay(dt).toISODate()!;
    if (!inRange(key)) continue;
    inc(covPrompts, p.directory);
    if (isWorkHours(dt)) inc(chatWork, key);
    else {
      inc(chatOt, key);
      pushOut(key, dt);
    }
    pushHeat(key, dt);
  }

  for (const c of commits) {
    const dt = DateTime.fromJSDate(c.committedAt as Date).setZone(ZONE);
    const key = attributedDay(dt).toISODate()!;
    if (!inRange(key)) continue;
    inc(covCommits, c.directory);
    if (isWorkHours(dt)) inc(gitWork, key);
    else {
      inc(gitOt, key);
      pushOut(key, dt);
    }
    pushHeat(key, dt);
  }

  // Rows — one per day that had any activity, sorted ascending.
  const allDays = [
    ...new Set([
      ...chatWork.keys(),
      ...chatOt.keys(),
      ...gitWork.keys(),
      ...gitOt.keys(),
      ...outTimes.keys(),
    ]),
  ].sort();

  const rows: ReportRow[] = [];
  let tCw = 0, tGw = 0, tCo = 0, tGo = 0, tOt = 0;
  for (const day of allDays) {
    const cw = chatWork.get(day) ?? 0;
    const gw = gitWork.get(day) ?? 0;
    const co = chatOt.get(day) ?? 0;
    const go = gitOt.get(day) ?? 0;
    const otMs = overtimeMs(outTimes.get(day) ?? [], gap);
    tCw += cw; tGw += gw; tCo += co; tGo += go; tOt += otMs;
    rows.push({
      date: day,
      weekday: WD[DateTime.fromISO(day, { zone: ZONE }).weekday - 1],
      chatWork: cw,
      gitWork: gw,
      chatOt: co,
      gitOt: go,
      otMs,
      otLabel: otMs ? fmtDur(otMs) : "—",
    });
  }

  // Coverage — every directory that contributed prompts or commits in range.
  const dirs = new Set([...covPrompts.keys(), ...covCommits.keys()]);
  const coverage: CoverageRow[] = [...dirs]
    .map((directory) => ({
      directory,
      folder: basename(directory),
      prompts: covPrompts.get(directory) ?? 0,
      commits: covCommits.get(directory) ?? 0,
    }))
    .sort((a, b) => a.folder.localeCompare(b.folder));

  // Heatmap cells.
  const heatmap: HeatCell[] = [...heat.entries()]
    .map(([k, count]) => {
      const [date, hour] = k.split("\t");
      return { date, hour: Number(hour), count };
    })
    .sort((a, b) => (a.date === b.date ? a.hour - b.hour : a.date.localeCompare(b.date)));

  return {
    range: { start: startKey, end: endKey, zone: ZONE, gap },
    rows,
    total: {
      chatWork: tCw,
      gitWork: tGw,
      chatOt: tCo,
      gitOt: tGo,
      otMs: tOt,
      otLabel: fmtDur(tOt),
    },
    coverage,
    heatmap,
    bounds,
  };
}

/** Default window when the caller supplies none: today + the 6 days before it. */
export function defaultRange(): { start: string; end: string } {
  const end = DateTime.now().setZone(ZONE).startOf("day");
  const start = end.minus({ days: 6 });
  return { start: start.toISODate()!, end: end.toISODate()! };
}
