/**
 * Every way Claude Code reports usage, turned into one domain shape. Pure: callers pass `now`.
 *
 *   1. `claude -p "/usage"` report text. Strict: anything unexpected is `unrecognized` and spending pauses.
 *   2. `rate_limit_event.rate_limit_info` in a task's stream. Lenient: it yields only the windows it can read.
 */

import { isPercent } from "./model.ts";
import type { Percent, SessionWindow, UsageSnapshot, UsageUpdate, Window, WindowName } from "./model.ts";

export type UsageParseFailure = {
  readonly kind: "unrecognized";
  readonly reason:
    | "missing-banner"
    | "missing-session-line"
    | "missing-week-line"
    | "malformed-window-line"
    | "unknown-time-zone"
    | "unresolvable-date";
  readonly line: string | null;
};

export type UsageParse =
  | { readonly kind: "ok"; readonly snapshot: UsageSnapshot }
  /** The cost summary printed under API-key auth. */
  | { readonly kind: "not-subscription" }
  | UsageParseFailure;

const BANNER = "You are currently using your subscription to power your Claude Code usage";
const COST_SIGNATURE = /^Total cost:/m;
const SESSION_LINE = /^Current session: (\d{1,3})% used(?: · resets (.+))?$/;
const WEEK_LINE = /^Current week \(([^()]+)\): (\d{1,3})% used · resets (.+)$/;
const WHEN = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) at (\d{1,2})(?::(\d{2}))?(am|pm) \(([^()]+)\)$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A read taken just after a reset, before the server rolls the window, still names that reset. */
const YEAR_SLACK_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Reads only lines that start with `Current `. Each must match the grammar, or the whole parse
 * fails. Everything else, such as the "What's contributing" breakdown, is ignored.
 *
 *   Current session: <pct>% used [· resets <when>]       (no reset clause: no window open)
 *   Current week (all models): <pct>% used · resets <when>
 *   Current week (<Model>): <pct>% used · resets <when>  (zero or more)
 *   <when> = <Mon> <day> at <h>[:<mm>]am|pm (<IANA zone>)
 *
 * The text has no year. Of the candidates in the zone's previous, current and next year, the
 * earliest instant at or after `now - 1h` wins.
 */
export function parseUsageText(text: string, now: Date): UsageParse {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const first = lines.find((l) => l.trim() !== "");
  if (first?.trim() !== BANNER) {
    return COST_SIGNATURE.test(text) ? { kind: "not-subscription" } : failure("missing-banner", first ?? null);
  }

  let session: SessionWindow | null = null;
  let week: Window | null = null;
  const modelWeeks: { model: string; window: Window }[] = [];

  for (const line of lines) {
    if (!line.startsWith("Current ")) continue;

    const s = SESSION_LINE.exec(line);
    if (s) {
      const usedPct = percentFrom(s[1]);
      if (session !== null || usedPct === null) return failure("malformed-window-line", line);
      if (s[2] === undefined) {
        session = { kind: "none", usedPct, observedAt: now };
        continue;
      }
      const at = resolveWhen(s[2], now);
      if (at.kind !== "ok") return failure(at.reason, line);
      session = { kind: "open", usedPct, resetsAt: at.date, observedAt: now };
      continue;
    }

    const w = WEEK_LINE.exec(line);
    const usedPct = percentFrom(w?.[2]);
    if (!w || w[1] === undefined || w[3] === undefined || usedPct === null) return failure("malformed-window-line", line);
    const at = resolveWhen(w[3], now);
    if (at.kind !== "ok") return failure(at.reason, line);
    const window: Window = { usedPct, resetsAt: at.date, observedAt: now };
    if (w[1] === "all models") {
      if (week !== null) return failure("malformed-window-line", line);
      week = window;
    } else {
      if (modelWeeks.some((m) => m.model === w[1])) return failure("malformed-window-line", line);
      modelWeeks.push({ model: w[1], window });
    }
  }

  if (session === null) return failure("missing-session-line", null);
  if (week === null) return failure("missing-week-line", null);
  return { kind: "ok", snapshot: { probedAt: now, session, week, modelWeeks } };
}

function failure(reason: UsageParseFailure["reason"], line: string | null): UsageParseFailure {
  return { kind: "unrecognized", reason, line };
}

function percentFrom(digits: string | undefined): Percent | null {
  if (digits === undefined) return null;
  const n = Number(digits);
  return isPercent(n) ? n : null;
}

type Resolved = { readonly kind: "ok"; readonly date: Date } | { readonly kind: "failed"; readonly reason: UsageParseFailure["reason"] };

function resolveWhen(when: string, now: Date): Resolved {
  const m = WHEN.exec(when);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined || m[5] === undefined || m[6] === undefined) {
    return { kind: "failed", reason: "malformed-window-line" };
  }
  const zone = m[6];
  const dtf = formatterFor(zone);
  if (dtf === null) return { kind: "failed", reason: "unknown-time-zone" };

  const month = MONTHS.indexOf(m[1]) + 1;
  const day = Number(m[2]);
  const hour12 = Number(m[3]);
  const minute = m[4] === undefined ? 0 : Number(m[4]);
  if (day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59) return { kind: "failed", reason: "malformed-window-line" };
  const hour = (hour12 % 12) + (m[5] === "pm" ? 12 : 0);

  const zoneYear = Number(partsOf(dtf, now.getTime()).year);
  const floor = now.getTime() - YEAR_SLACK_MS;
  const candidates = [zoneYear - 1, zoneYear, zoneYear + 1]
    .filter((year) => day <= daysInMonth(year, month))
    .map((year) => zonedWallTimeToInstant(dtf, { year, month, day, hour, minute }))
    .filter((t) => t >= floor);
  if (candidates.length === 0) return { kind: "failed", reason: "unresolvable-date" };
  return { kind: "ok", date: new Date(Math.min(...candidates)) };
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  if (!formatters.has(zone)) {
    let dtf: Intl.DateTimeFormat | null;
    try {
      dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      dtf = null;
    }
    formatters.set(zone, dtf);
  }
  return formatters.get(zone) ?? null;
}

function partsOf(dtf: Intl.DateTimeFormat, instant: number): Record<string, string> {
  return Object.fromEntries(dtf.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
}

/** The zone's UTC offset at an instant, in ms. */
function offsetAt(dtf: Intl.DateTimeFormat, instant: number): number {
  const p = partsOf(dtf, instant);
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return wall - (instant - (instant % 1000));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Wall-clock time in a zone to an instant, with no tz library. Tries the offsets in force a day
 * either side. A wall time that occurs twice (fall back) resolves to the earlier instant. One that
 * never occurs (spring forward) resolves to the instant after the gap.
 */
function zonedWallTimeToInstant(
  dtf: Intl.DateTimeFormat,
  w: { readonly year: number; readonly month: number; readonly day: number; readonly hour: number; readonly minute: number },
): number {
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const candidates = [...new Set([offsetAt(dtf, wall - DAY_MS), offsetAt(dtf, wall + DAY_MS)])].map((o) => wall - o);
  const exact = candidates.filter((t) => t + offsetAt(dtf, t) === wall);
  return exact.length > 0 ? Math.min(...exact) : Math.max(...candidates);
}

/**
 * `rate_limit_info` to the windows it carries: `unifiedWindows.five_hour` is the session and
 * `seven_day` the week. Utilization is a fraction and resetsAt is epoch seconds. A window missing
 * either field is null, and null overall when neither is readable.
 */
export function readRateLimitInfo(info: unknown, observedAt: Date): UsageUpdate | null {
  const windows = field(info, "unifiedWindows");
  const session = streamWindow(field(windows, "five_hour"), observedAt);
  const week = streamWindow(field(windows, "seven_day"), observedAt);
  return session === null && week === null ? null : { session, week };
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function streamWindow(raw: unknown, observedAt: Date): Window | null {
  const utilization = field(raw, "utilization");
  const resetsAt = field(raw, "resetsAt");
  if (typeof utilization !== "number" || !Number.isFinite(utilization) || utilization < 0) return null;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return null;
  const usedPct = Math.min(100, Math.round(utilization * 10_000) / 100);
  if (!isPercent(usedPct)) return null;
  return { usedPct, resetsAt: new Date(resetsAt * 1000), observedAt };
}

/**
 * Two readings describe the same window when their resets are within an hour. The text report
 * shows a reset a minute earlier than the stream's epoch, and consecutive windows are at least
 * 5 hours apart.
 */
export function sameWindow(a: { readonly resetsAt: Date }, b: { readonly resetsAt: Date }): boolean {
  return Math.abs(a.resetsAt.getTime() - b.resetsAt.getTime()) < 60 * 60_000;
}

/** A window the update carries replaces that window. A stream session always has a reset, so it is open. */
export function mergeUpdate(view: UsageSnapshot, update: UsageUpdate): UsageSnapshot {
  return {
    ...view,
    session: update.session === null ? view.session : { kind: "open", ...update.session },
    week: update.week ?? view.week,
  };
}

export type Reading =
  | { readonly kind: "open"; readonly usedPct: Percent; readonly resetsAt: Date }
  | { readonly kind: "none"; readonly usedPct: Percent }
  | { readonly kind: "unknown"; readonly why: "stale" | "rolled-over" };

/** What policy may trust about a window right now. A stale or rolled-over reading is unknown, never zero. */
export function readWindow(view: UsageSnapshot, name: WindowName, now: Date, maxAgeMs: number): Reading {
  const w: SessionWindow = name === "session" ? view.session : { kind: "open", ...view.week };
  if (now.getTime() - w.observedAt.getTime() > maxAgeMs) return { kind: "unknown", why: "stale" };
  if (w.kind === "none") return { kind: "none", usedPct: w.usedPct };
  if (w.resetsAt.getTime() <= now.getTime()) return { kind: "unknown", why: "rolled-over" };
  return { kind: "open", usedPct: w.usedPct, resetsAt: w.resetsAt };
}
