/**
 * Everything a human reads: report rows, the queue table, status, spend progress. Pure: data in,
 * strings out.
 */

import type {
  AbsPath,
  AttemptNo,
  AttemptPlan,
  AttemptState,
  AttemptView,
  BranchName,
  DiffStat,
  HaltReason,
  Ledger,
  Limits,
  Login,
  QueueEntry,
  QueueProblem,
  RunResult,
  SessionWindow,
  SpendNo,
  SpendView,
  TaskId,
  UsageSnapshot,
  Window,
} from "./model.ts";
import { describeError, describeStop } from "./policy.ts";
import type { Admission } from "./policy.ts";
import type { SpendEvent, SpendSummary } from "./runner.ts";
import { sameWindow } from "./usage.ts";

export type RowOutcome = RunResult["kind"] | Exclude<AttemptState["kind"], "ended">;

/** Failures first. A Record, so the compiler rejects an outcome without a rank. */
const SEVERITY: Readonly<Record<RowOutcome, number>> = {
  failed: 0,
  errored: 1,
  interrupted: 2,
  partial: 3,
  live: 4,
  "no-op": 5,
  passed: 6,
};

/** Points used in each window while the attempt ran. null for a window that reset in between. */
export type UsageDelta = { readonly sessionPts: number | null; readonly weekPts: number | null };

export type ReportRow = {
  readonly task: TaskId;
  readonly attempt: AttemptNo;
  readonly spend: SpendNo;
  readonly outcome: RowOutcome;
  readonly note: string;
  readonly branch: BranchName;
  readonly diff: DiffStat | null;
  readonly usage: UsageDelta | null;
  readonly log: AbsPath;
  readonly startedAt: Date;
};

/** One row per attempt started at or after `since`, failures first, newest first within a group. */
export function reportRows(ledger: Ledger, since: Date): readonly ReportRow[] {
  const rows: ReportRow[] = [];
  for (const attempts of ledger.attempts.values()) {
    for (const a of attempts) {
      if (a.startedAt.getTime() < since.getTime()) continue;
      const ended = a.state.kind === "ended" ? a.state.end : null;
      rows.push({
        task: a.task,
        attempt: a.attempt,
        spend: a.spend,
        outcome: ended ? ended.result.kind : (a.state.kind as Exclude<AttemptState["kind"], "ended">),
        note: noteOf(a),
        branch: a.branch,
        diff: ended ? ended.diff : (a.sealed?.diff ?? null),
        usage: usageDelta(a),
        log: a.files.stream,
        startedAt: a.startedAt,
      });
    }
  }
  return rows.sort((x, y) => SEVERITY[x.outcome] - SEVERITY[y.outcome] || y.startedAt.getTime() - x.startedAt.getTime());
}

function noteOf(a: AttemptView): string {
  const s = a.state;
  if (s.kind === "live") return "running now";
  if (s.kind === "interrupted") {
    const orphan = s.orphan ? `; its claude (pid ${s.orphan.pid}) is still running` : "";
    return `syt stopped before this attempt ended${a.exited ? " (the agent had exited, so the next run finishes it for free)" : ""}${orphan}`;
  }
  const r = s.end.result;
  switch (r.kind) {
    case "passed":
      return a.plan.kind === "finish" ? "finished after a crash, no tokens spent" : "";
    case "no-op":
      return "no changes";
    case "partial":
      return describeStop(r.stop);
    case "failed":
      return r.check.kind === "timed-out" ? "the done check timed out" : `the done check exited ${r.check.code}: ${lastLine(r.check.tail)}`;
    case "errored":
      return describeError(r.error);
  }
}

function lastLine(s: string): string {
  return s.trim().split("\n").at(-1)?.slice(0, 160) ?? "";
}

/** Each window's change while the attempt ran, when both readings describe the same window. */
export function usageDelta(attempt: AttemptView): UsageDelta | null {
  const before = attempt.usageBefore;
  const after = attempt.state.kind === "ended" ? attempt.state.end.usageAfter : null;
  if (before === null || after === null) return null;
  return { sessionPts: sessionDelta(before.session, after.session), weekPts: windowDelta(before.week, after.week) };
}

function windowDelta(before: Window, after: Window): number | null {
  return sameWindow(before, after) ? Math.max(0, round(after.usedPct - before.usedPct)) : null;
}

function sessionDelta(before: SessionWindow, after: SessionWindow): number | null {
  if (before.kind === "open" && after.kind === "open") return windowDelta(before, after);
  if (before.kind === "none") return Math.max(0, round(after.usedPct - before.usedPct));
  return null;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** `7d`, `24h`, `90m`, or an ISO date or date-time. null when unparseable. */
export function parseSince(input: string, now: Date): Date | null {
  const rel = /^(\d+)([dhm])$/.exec(input);
  if (rel) {
    const unit = rel[2] === "d" ? 86_400_000 : rel[2] === "h" ? 3_600_000 : 60_000;
    return new Date(now.getTime() - Number(rel[1]) * unit);
  }
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(input)) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T00:00:00` : input);
  return Number.isNaN(date.getTime()) ? null : date;
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows.reduce<number[]>((w, r) => r.map((cell, i) => Math.max(w[i] ?? 0, cell.length)), []);
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ").trimEnd()).join("\n");
}

export function formatDiff(diff: DiffStat | null): string {
  if (diff === null || diff.files === 0) return "-";
  return `${diff.files} file${diff.files === 1 ? "" : "s"} +${diff.insertions} -${diff.deletions}`;
}

function formatDelta(d: UsageDelta | null): string {
  if (d === null) return "?";
  const one = (n: number | null) => (n === null ? "reset" : `+${n}`);
  return `${one(d.sessionPts)} / ${one(d.weekPts)}`;
}

export function renderReport(rows: readonly ReportRow[], problems: readonly string[], since: Date): string {
  if (rows.length === 0) return withProblems(`no attempts since ${formatWhen(since, since)}`, problems);
  const lines = [["outcome", "attempt", "branch", "diff", "usage session/week", "log"]];
  const notes = new Map<number, string>();
  for (const [i, r] of rows.entries()) {
    lines.push([r.outcome, `${r.task} #${r.attempt}`, r.branch, formatDiff(r.diff), formatDelta(r.usage), r.log]);
    if (r.note !== "") notes.set(i, r.note);
  }
  const rendered = table(lines).split("\n");
  const out = [rendered[0] ?? ""];
  for (const [i, line] of rendered.slice(1).entries()) {
    out.push(line);
    const note = notes.get(i);
    if (note !== undefined) out.push(`  ${note}`);
  }
  return withProblems(out.join("\n"), problems);
}

function withProblems(text: string, problems: readonly string[]): string {
  return problems.length === 0 ? text : `${text}\n\nproblems\n${problems.map((p) => `  ${p}`).join("\n")}`;
}

export function describePlan(plan: AttemptPlan): string {
  switch (plan.kind) {
    case "fresh":
      return "fresh";
    case "finish":
      return "finish (no agent)";
    case "continue":
      return `${plan.why === "failed" || plan.why === "errored" ? "retry" : "resume"} after ${plan.why}${plan.session === null ? ", new session" : ""}`;
  }
}

function statusText(entry: QueueEntry): string {
  const s = entry.status;
  switch (s.kind) {
    case "ready":
      return s.plan.kind === "fresh" ? "ready" : `ready: ${describePlan(s.plan)}`;
    case "running":
      return `running (attempt ${s.attempt}, spend ${s.spend})`;
    case "done":
      return `${s.outcome} (attempt ${s.attempt}, syt/${entry.task.id})`;
    case "flagged":
      return `flagged: ${s.why.replace("-", " ")} (syt run --now --task ${entry.task.id} to force)`;
  }
}

export function renderQueue(entries: readonly QueueEntry[], problems: readonly QueueProblem[]): string {
  const body =
    entries.length === 0
      ? 'the queue is empty. Add a task with: syt add "<prompt>" --repo <path>'
      : (() => {
          let n = 0;
          const rows = entries.map((e) => [e.status.kind === "ready" ? String(++n) : "-", e.task.id, e.task.repo.key, e.task.priority, statusText(e)]);
          return table([["#", "task", "repo", "pri", "status"], ...rows]);
        })();
  return withProblems(body, problems.map((p) => `${p.where}: ${p.message}`));
}

export type StatusInput = {
  readonly login: Login;
  readonly usage: { readonly kind: "ok"; readonly view: UsageSnapshot; readonly admission: Admission } | { readonly kind: "unreadable"; readonly detail: string } | null;
  readonly limits: Limits;
  readonly lastSpend: SpendView | null;
  readonly live: readonly AttemptView[];
  readonly next: QueueEntry | null;
  readonly now: Date;
};

export function renderStatus(input: StatusInput): string {
  const { limits, now } = input;
  const rows: string[][] = [["login", describeLogin(input.login)]];
  const u = input.usage;
  if (u === null) rows.push(["usage", "not read (no subscription login)"]);
  else if (u.kind === "unreadable") rows.push(["usage", `unreadable: ${u.detail}`]);
  else {
    const s = u.view.session;
    const sessionReset = s.kind === "open" ? ` · resets ${formatWhen(s.resetsAt, now)} (in ${formatSpan(s.resetsAt.getTime() - now.getTime())})` : " · no window open";
    rows.push(["session", `${s.usedPct}% used${sessionReset} · reserve ${limits.sessionReservePct}% · new tasks until ${100 - limits.sessionReservePct - limits.startMarginPts}%`]);
    const w = u.view.week;
    rows.push(["week", `${w.usedPct}% used · resets ${formatWhen(w.resetsAt, now)} (in ${formatSpan(w.resetsAt.getTime() - now.getTime())}) · reserve ${limits.weekReservePct}% · new tasks until ${100 - limits.weekReservePct - limits.startMarginPts}%`]);
  }
  const last = input.lastSpend;
  const spendLine =
    last === null
      ? "none yet"
      : last.state.kind === "live"
        ? `spend ${last.spend} is running (pid ${last.owner.pid}, since ${formatWhen(last.startedAt, now)}, ${input.live.length} attempt${input.live.length === 1 ? "" : "s"} live)`
        : last.state.kind === "interrupted"
          ? `none active · last: spend ${last.spend} was interrupted`
          : `none active · last: spend ${last.spend} ended ${formatWhen(last.state.end.endedAt, now)} (${describeHalt(last.state.end.halt)})`;
  rows.push(["spend", spendLine]);
  const next = input.next;
  const gate = u?.kind === "ok" ? u.admission : null;
  rows.push([
    "next",
    next === null
      ? "nothing is ready in the queue"
      : gate?.kind === "closed"
        ? `${next.task.id} is ready, but nothing starts now: ${describeHalt(gate.reason)}`
        : `syt run --now would start ${next.task.id}${next.status.kind === "ready" ? ` (${describePlan(next.status.plan)})` : ""}`,
  ]);
  return table(rows);
}

function describeLogin(login: Login): string {
  switch (login.kind) {
    case "subscription":
      return `subscription${login.plan ? ` (${login.plan})` : ""}`;
    case "api-key":
      return `API key${login.source ? ` from ${login.source}` : ""}. syt spends only a subscription`;
    case "logged-out":
      return "not logged in. Run claude and /login";
    case "unreadable":
      return `unreadable: ${login.detail}`;
  }
}

export function describeHalt(h: HaltReason): string {
  switch (h.kind) {
    case "usage-unreadable":
      return `usage unreadable: ${h.detail}`;
    case "user-stop":
      return "stopped by you";
    case "reset-soon":
      return `the ${h.window} window resets soon`;
    case "queue-drained":
      return "queue drained";
    case "near-reserve":
      return `${h.window} is within the start margin of its reserve (${h.usedPct}% used, new tasks start below ${h.startLimitPct}%)`;
    case "not-subscription":
      return `not a subscription login: ${describeLogin(h.login)}`;
    case "agent-refused":
      return `an agent was killed at init: ${describeError({ kind: "refused", reason: h.reason })}`;
    case "task-not-runnable":
      return h.status === "missing" ? `task ${h.task} is not in the queue` : `task ${h.task} is ${h.status}`;
    case "busy":
      return `spend ${h.holder} started at the same moment`;
  }
}

const TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DAY_TIME = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function formatWhen(when: Date, now: Date): string {
  return Math.abs(when.getTime() - now.getTime()) < 20 * 3_600_000 ? TIME.format(when) : DAY_TIME.format(when).replace(",", "");
}

function formatSpan(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${m}m` : `${m}m`;
}

export function renderSpendEvent(event: SpendEvent, now: Date): string {
  switch (event.kind) {
    case "opened": {
      const s = event.view.session;
      const session = s.kind === "open" ? `session ${s.usedPct}% (resets ${formatWhen(s.resetsAt, now)})` : `session ${s.usedPct}% (no window open)`;
      return `spend ${event.spend} · ${describeLogin(event.login)} · ${session} · week ${event.view.week.usedPct}% (resets ${formatWhen(event.view.week.resetsAt, now)})`;
    }
    case "started":
      return `start  ${event.task} #${event.attempt.attempt}  ${describePlan(event.plan)}  ${event.worktree}`;
    case "skipped":
      return `skip   ${event.task}  repo ${event.skip.repo} is ${event.skip.reason === "dirty" ? "dirty" : "not a git repo"}: ${event.skip.detail}`;
    case "ended": {
      const a = event.attempt;
      const outcome = a.state.kind === "ended" ? a.state.end.result.kind : a.state.kind;
      const diff = a.state.kind === "ended" ? formatDiff(a.state.end.diff) : "-";
      const note = noteOf(a);
      return `end    ${a.task} #${a.attempt}  ${outcome}  ${diff}${note ? `  ${note}` : ""}`;
    }
    case "halting":
      return `halt   ${describeHalt(event.reason)}`;
  }
}

export function renderSpendSummary(summary: SpendSummary): string {
  switch (summary.kind) {
    case "busy":
      return `spend ${summary.active.spend} is active (pid ${summary.active.owner.pid}, since ${formatWhen(summary.active.startedAt, summary.active.startedAt)})`;
    case "refused":
      return `refused: ${describeHalt(summary.halt)}`;
    case "ran": {
      const counts = new Map<string, number>();
      for (const a of summary.attempts) {
        const k = a.state.kind === "ended" ? a.state.end.result.kind : a.state.kind;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const n = summary.attempts.length;
      const parts = [...counts].map(([k, c]) => `${c} ${k}`).join(", ");
      const skipped = summary.skipped.length > 0 ? `\nskipped: ${summary.skipped.map((s) => `${s.repo} (${s.reason})`).join(", ")}` : "";
      return `${n} attempt${n === 1 ? "" : "s"}${parts ? `: ${parts}` : ""} · stopped: ${describeHalt(summary.halt)} · syt report${skipped}`;
    }
  }
}
