/**
 * Every decision syt makes, as pure functions of data. No I/O, no clock reads.
 *
 *   admission    may a new attempt start now?
 *   stopReason   must a running attempt stop at this turn?
 *   taskStatus   what is this task's state, and its next step?
 *   planQueue    in what order do tasks run?
 *   conclude     what was the attempt's outcome?
 */

import { percentOrThrow } from "./model.ts";
import type {
  AgentExit,
  AttemptPlan,
  AttemptView,
  CheckRun,
  ContinueWhy,
  DiffStat,
  HaltReason,
  Ledger,
  Limits,
  Priority,
  QueueEntry,
  RunError,
  RunResult,
  SessionId,
  SpendMode,
  StopReason,
  Task,
  TaskId,
  TaskStatus,
  UsageSnapshot,
  WindowName,
} from "./model.ts";
import { readWindow } from "./usage.ts";
import type { Reading } from "./usage.ts";

export type Admission = { readonly kind: "open" } | { readonly kind: "closed"; readonly reason: HaltReason };

const WINDOWS: readonly WindowName[] = ["session", "week"];
const MINUTE = 60_000;

/**
 * A new attempt may start only when both windows are known, neither resets within the runway,
 * and each is below its reserve minus the start margin. A session with no open window passes.
 * Mode `manual` ignores the spend window; it is the only mode in M1.
 */
export function admission(input: {
  readonly view: UsageSnapshot;
  readonly now: Date;
  readonly limits: Limits;
  readonly mode: SpendMode;
  readonly maxReadingAgeMs: number;
}): Admission {
  const { view, now, limits } = input;
  const readings = WINDOWS.map((name) => [name, readWindow(view, name, now, input.maxReadingAgeMs)] as const);

  for (const [name, r] of readings) {
    if (r.kind === "unknown") return closed({ kind: "usage-unreadable", detail: `the ${name} reading is ${r.why}` });
  }
  for (const [name, r] of readings) {
    if (r.kind === "open" && r.resetsAt.getTime() - now.getTime() <= limits.startRunwayMinutes * MINUTE) {
      return closed({ kind: "reset-soon", window: name, resetsAt: r.resetsAt });
    }
  }
  for (const [name, r] of readings) {
    const startLimit = 100 - reserveOf(limits, name) - limits.startMarginPts;
    if (r.kind !== "unknown" && r.usedPct >= startLimit) {
      return closed({ kind: "near-reserve", window: name, usedPct: r.usedPct, startLimitPct: percentOrThrow(Math.max(0, startLimit)) });
    }
  }
  return { kind: "open" };
}

function closed(reason: HaltReason): Admission {
  return { kind: "closed", reason };
}

function reserveOf(limits: Limits, name: WindowName) {
  return name === "session" ? limits.sessionReservePct : limits.weekReservePct;
}

/**
 * The stop rules for one running attempt, first match wins: a reset within the guard, a window at
 * its reserve, then the time cap. An unknown window decides nothing here; the runner re-probes it
 * and stops everything if it stays unknown.
 */
export function stopReason(input: {
  readonly view: UsageSnapshot;
  readonly now: Date;
  readonly limits: Limits;
  readonly startedAt: Date;
  readonly maxMinutes: number;
  readonly maxReadingAgeMs: number;
}): StopReason | null {
  const { view, now, limits } = input;
  const readings: (readonly [WindowName, Reading])[] = WINDOWS.map((name) => [name, readWindow(view, name, now, input.maxReadingAgeMs)]);

  for (const [name, r] of readings) {
    if (r.kind === "open" && r.resetsAt.getTime() - now.getTime() <= limits.resetGuardMinutes * MINUTE) {
      return { kind: "reset-soon", window: name, resetsAt: r.resetsAt };
    }
  }
  for (const [name, r] of readings) {
    const reservePct = reserveOf(limits, name);
    if (r.kind !== "unknown" && r.usedPct >= 100 - reservePct) {
      return { kind: "reserve-reached", window: name, usedPct: r.usedPct, reservePct };
    }
  }
  if (now.getTime() - input.startedAt.getTime() >= input.maxMinutes * MINUTE) return { kind: "time-cap", maxMinutes: input.maxMinutes };
  return null;
}

const MAX_RESUMES = 2;
const MAX_FAILURES = 2;
const MAX_ERRORS = 2;

/**
 * A task's state, derived from its attempts in ascending order. The whole retry policy is here.
 *
 *   no attempts                          ready(fresh)
 *   last live                            running
 *   last interrupted after its agent exited
 *                                        ready(finish): seal, check, classify, spending nothing
 *   last interrupted before that         resume unless 2 resumes already ran
 *   last passed or no-op                 done
 *   last failed                          retry with the check's output, flagged after 2 failures
 *   last partial                         resume, flagged after 2 resumes
 *   last errored                         retry, flagged after 2 errors (a refusal is not the task's error)
 *
 * Resumes count continues for partial or interrupted work that started an agent. An attempt that
 * spent nothing (a finish, or a stop that landed before the spawn) counts toward nothing.
 */
export function taskStatus(task: Task, attempts: readonly AttemptView[]): TaskStatus {
  const last = attempts.at(-1);
  if (last === undefined) return { kind: "ready", plan: { kind: "fresh", prompt: task.prompt } };

  const state = last.state;
  if (state.kind === "live") return { kind: "running", attempt: last.attempt, spend: last.spend };
  if (state.kind === "interrupted" && last.exited !== null) {
    return {
      kind: "ready",
      plan: { kind: "finish", from: last.attempt, worktree: last.worktree, base: last.base, exit: last.exited, sealed: last.sealed },
    };
  }

  const session = lastSession(attempts);
  const resume = (why: ContinueWhy, detail: string): AttemptPlan => ({
    kind: "continue",
    why,
    from: last.attempt,
    session,
    worktree: last.worktree,
    base: last.base,
    prompt: continuePrompt(task, why, session, detail),
  });
  const capped = (count: number, max: number, why: "failed-twice" | "resumed-twice" | "errored-twice", plan: AttemptPlan): TaskStatus =>
    count >= max ? { kind: "flagged", why, next: plan } : { kind: "ready", plan };
  const resumes = attempts.filter((a) => a.agent !== null && a.plan.kind === "continue" && (a.plan.why === "partial" || a.plan.why === "interrupted")).length;

  if (state.kind === "interrupted") return capped(resumes, MAX_RESUMES, "resumed-twice", resume("interrupted", ""));

  const result = state.end.result;
  switch (result.kind) {
    case "passed":
    case "no-op":
      return { kind: "done", outcome: result.kind, attempt: last.attempt };
    case "failed": {
      const failures = attempts.filter((a) => resultOf(a)?.kind === "failed").length;
      return capped(failures, MAX_FAILURES, "failed-twice", resume("failed", result.check.tail));
    }
    case "partial":
      return capped(resumes, MAX_RESUMES, "resumed-twice", resume("partial", describeStop(result.stop)));
    case "errored": {
      const errors = attempts.filter((a) => {
        const r = resultOf(a);
        return r?.kind === "errored" && r.error.kind !== "refused";
      }).length;
      return capped(errors, MAX_ERRORS, "errored-twice", resume("errored", describeError(result.error)));
    }
  }
}

function resultOf(a: AttemptView): RunResult | null {
  return a.state.kind === "ended" ? a.state.end.result : null;
}

/** Every attempt of a task shares one worktree, so the newest session is resumable from it. */
function lastSession(attempts: readonly AttemptView[]): SessionId | null {
  for (let i = attempts.length - 1; i >= 0; i--) {
    const s = attempts[i]?.session;
    if (s) return s;
  }
  return null;
}

function continuePrompt(task: Task, why: ContinueWhy, session: SessionId | null, detail: string): string {
  const lead =
    session === null
      ? `${task.prompt}\n\nAn earlier attempt at this task already worked in this directory. Its changes are committed on the current branch.`
      : "Continue the task.";
  switch (why) {
    case "partial":
      return `${lead}\n\nYour previous run was stopped before it finished (${detail}). Pick up where you left off.`;
    case "interrupted":
      return `${lead}\n\nYour previous run was interrupted. Pick up where you left off.`;
    case "failed":
      return `${lead}\n\nThe done check \`${task.check}\` failed after your last run. The end of its output:\n\n${detail}\n\nFix the cause so the check passes.`;
    case "errored":
      return `${lead}\n\nYour previous run ended with an error (${detail}). Pick up where you left off.`;
  }
}

export function describeStop(stop: StopReason): string {
  switch (stop.kind) {
    case "reserve-reached":
      return `${stop.window} reserve reached (${stop.usedPct}% used)`;
    case "reset-soon":
      return `${stop.window} window resets soon`;
    case "time-cap":
      return `time cap of ${stop.maxMinutes} minutes`;
    case "usage-unreadable":
      return `usage unreadable: ${stop.detail}`;
    case "user-stop":
      return "stopped by you";
  }
}

export function describeError(error: RunError): string {
  switch (error.kind) {
    case "refused":
      return error.reason.kind === "api-key"
        ? `refused: API key from ${error.reason.source}`
        : error.reason.kind === "permission-mode"
          ? `refused: permission mode ${error.reason.mode}`
          : "refused: no init event";
    case "agent-crashed":
      return `claude exited ${error.code ?? error.signal ?? "abnormally"}${error.stderrTail ? `: ${lastLine(error.stderrTail)}` : ""}`;
    case "agent-error":
      return `claude reported an error: ${lastLine(error.summary)}`;
    case "worktree":
      return `worktree: ${error.detail}`;
    case "internal":
      return `internal error: ${error.detail}`;
  }
}

function lastLine(s: string): string {
  return s.trim().split("\n").at(-1)?.slice(0, 200) ?? "";
}

const PRIORITY_RANK: Readonly<Record<Priority, number>> = { high: 0, normal: 1, low: 2 };

/** Resumes and finishes, then fresh tasks, then failed or errored retries; then running, flagged, done. */
function laneOf(status: TaskStatus): number {
  switch (status.kind) {
    case "ready":
      switch (status.plan.kind) {
        case "finish":
          return 0;
        case "fresh":
          return 1;
        case "continue":
          return status.plan.why === "partial" || status.plan.why === "interrupted" ? 0 : 2;
      }
    case "running":
      return 3;
    case "flagged":
      return 4;
    case "done":
      return 5;
  }
}

/** Every task with its status, in run order. Within a lane: priority, then declaration order. */
export function planQueue(tasks: readonly Task[], ledger: Ledger): readonly QueueEntry[] {
  return tasks
    .map((task) => ({ task, status: taskStatus(task, ledger.attempts.get(task.id) ?? []) }))
    .sort((a, b) => laneOf(a.status) - laneOf(b.status) || PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority]);
}

export type Next =
  | { readonly kind: "run"; readonly task: Task; readonly plan: AttemptPlan }
  | { readonly kind: "none"; readonly halt: HaltReason };

/**
 * The next attempt to start. `exclude` holds tasks this spend already tried or is running, so each
 * task runs at most once per spend. With `mode.only`, only that task, and flagged is an override.
 */
export function pickNext(input: { readonly plan: readonly QueueEntry[]; readonly mode: SpendMode; readonly exclude: ReadonlySet<TaskId> }): Next {
  const only = input.mode.only;
  if (only !== null) {
    const entry = input.plan.find((e) => e.task.id === only);
    if (entry === undefined) return { kind: "none", halt: { kind: "task-not-runnable", task: only, status: "missing" } };
    if (input.exclude.has(only)) return { kind: "none", halt: { kind: "queue-drained" } };
    const s = entry.status;
    if (s.kind === "ready") return { kind: "run", task: entry.task, plan: s.plan };
    if (s.kind === "flagged") return { kind: "run", task: entry.task, plan: s.next };
    return { kind: "none", halt: { kind: "task-not-runnable", task: only, status: s.kind } };
  }
  for (const e of input.plan) {
    if (e.status.kind === "ready" && !input.exclude.has(e.task.id)) return { kind: "run", task: e.task, plan: e.status.plan };
  }
  return { kind: "none", halt: { kind: "queue-drained" } };
}

export type Conclusion =
  | { readonly kind: "final"; readonly result: RunResult }
  /** The agent finished cleanly with a diff, so the done check decides. */
  | { readonly kind: "run-check"; readonly then: (check: CheckRun) => RunResult };

/**
 * Classifies an attempt: stopped is partial, refused or crashed or an error result is errored, an
 * empty cumulative diff is no-op, and otherwise the done check decides passed or failed.
 */
export function conclude(input: { readonly exit: AgentExit; readonly diff: DiffStat }): Conclusion {
  const { exit } = input;
  switch (exit.kind) {
    case "stopped":
      return { kind: "final", result: { kind: "partial", stop: exit.reason } };
    case "refused":
      return { kind: "final", result: { kind: "errored", error: { kind: "refused", reason: exit.reason } } };
    case "crashed":
      return {
        kind: "final",
        result: { kind: "errored", error: { kind: "agent-crashed", code: exit.code, signal: exit.signal, stderrTail: exit.stderrTail } },
      };
    case "finished":
      if (exit.isError) return { kind: "final", result: { kind: "errored", error: { kind: "agent-error", summary: exit.summary } } };
      if (input.diff.files === 0) return { kind: "final", result: { kind: "no-op" } };
      return {
        kind: "run-check",
        then: (check) => (check.kind === "exited" && check.code === 0 ? { kind: "passed", check } : { kind: "failed", check }),
      };
  }
}
