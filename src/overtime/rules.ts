/**
 * Shared overtime rules — the pure, timezone-aware bucketing primitives used by
 * both the CLI collector (`analyze-overtime.ts`) and the dashboard server
 * (`report.ts`). Kept dependency-free (luxon only, no fs / DB) so it is the
 * single source of truth for the domain's local-time conventions.
 */
import { DateTime } from "luxon";

export const ZONE = "Australia/Sydney"; // handles AEST/AEDT (DST) automatically
export const DAY_ROLLOVER_HOUR = 3; // activity before this hour rolls to the previous day
export const DEFAULT_GAP_MINUTES = 45; // idle gap that splits one active segment from the next
export const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Local DateTime at the start of the calendar day an event belongs to. */
export function attributedDay(dt: DateTime): DateTime {
  const d = dt.hour < DAY_ROLLOVER_HOUR ? dt.minus({ days: 1 }) : dt;
  return d.startOf("day");
}

/** Mon–Fri 09:00–17:00 local time. luxon weekday: 1=Mon..7=Sun. */
export function isWorkHours(dt: DateTime): boolean {
  return dt.weekday <= 5 && dt.hour >= 9 && dt.hour < 17;
}

/** Sum of active-segment spans (ms); splits wherever a gap exceeds gapMinutes. */
export function overtimeMs(times: DateTime[], gapMinutes: number): number {
  const sorted = [...times].sort((a, b) => a.toMillis() - b.toMillis());
  if (!sorted.length) return 0;
  let total = 0;
  let segStart = sorted[0];
  let prev = sorted[0];
  for (const t of sorted.slice(1)) {
    if (t.toMillis() - prev.toMillis() > gapMinutes * 60_000) {
      total += prev.toMillis() - segStart.toMillis();
      segStart = t;
    }
    prev = t;
  }
  total += prev.toMillis() - segStart.toMillis();
  return total;
}

/** Milliseconds → "Xh MMm". */
export function fmtDur(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
