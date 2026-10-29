/**
 * The nouns of syt: data shapes and the guards that mint branded values. No I/O, no policy.
 *
 *   Task (queue.ts)  --policy.taskStatus-->  AttemptPlan
 *   AttemptPlan --runner--> AttemptRecord (runs.ts) --> AttemptView (liveness folded in)
 *   AttemptView[] --report.reportRows--> ReportRow
 *
 * The user owns Task declarations, syt owns AttemptRecord/SpendRecord, and every status is
 * derived by joining the two on TaskId.
 */

import path from "node:path";

export type AbsPath = string & { readonly __brand: "AbsPath" };
/** Lowercase slug, safe as a path segment and as the suffix of `syt/<id>`. */
export type TaskId = string & { readonly __brand: "TaskId" };
/** Names a repo's worktree folder: the `[repos.<key>]` section, else the repo dir's basename. */
export type RepoKey = string & { readonly __brand: "RepoKey" };
/** A non-empty command line run through `/bin/sh -c` in a worktree. */
export type ShellCommand = string & { readonly __brand: "ShellCommand" };
/** A Claude Code permission rule: `Read`, `mcp__x__y`, `Bash(npm test *)`. */
export type ToolPattern = string & { readonly __brand: "ToolPattern" };
export type SessionId = string & { readonly __brand: "SessionId" };
export type BranchName = string & { readonly __brand: "BranchName" };
export type CommitSha = string & { readonly __brand: "CommitSha" };
/** 1-based attempt number within one task, and the file name `runs/<task>/<n>.json`. */
export type AttemptNo = number & { readonly __brand: "AttemptNo" };
/** 1-based spend number, and the file name `spends/<n>.json`. */
export type SpendNo = number & { readonly __brand: "SpendNo" };
/** 0..100, may be fractional. */
export type Percent = number & { readonly __brand: "Percent" };

const TASK_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const REPO_KEY = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const TOOL = /^(?:[A-Z][A-Za-z0-9_]*|mcp__[A-Za-z0-9_-]+)(?:\(.+\))?$/s;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const isAbsPath = (s: string): s is AbsPath => path.isAbsolute(s) && path.normalize(s) === s;
export const isTaskId = (s: string): s is TaskId => TASK_ID.test(s);
export const isRepoKey = (s: string): s is RepoKey => REPO_KEY.test(s);
export const isShellCommand = (s: string): s is ShellCommand => s.trim() !== "" && !s.includes("\0");
export const isToolPattern = (s: string): s is ToolPattern => TOOL.test(s);
export const isSessionId = (s: string): s is SessionId => UUID.test(s);
export const isCommitSha = (s: string): s is CommitSha => SHA.test(s);
export const isAttemptNo = (n: number): n is AttemptNo => Number.isSafeInteger(n) && n >= 1;
export const isSpendNo = (n: number): n is SpendNo => Number.isSafeInteger(n) && n >= 1;
export const isPercent = (n: number): n is Percent => Number.isFinite(n) && n >= 0 && n <= 100;

export function percentOrThrow(n: number): Percent {
  if (!isPercent(n)) throw new Error(`not a percent: ${n}`);
  return n;
}

// config

/** All user-set thresholds. Defaults live in config.ts. */
export type Limits = {
  readonly concurrency: 1 | 2 | 3 | 4;
  readonly sessionReservePct: Percent;
  readonly weekReservePct: Percent;
  /** No new start within this many points of either reserve. */
  readonly startMarginPts: number;
  /** A running attempt stops this close to either window's reset. */
  readonly resetGuardMinutes: number;
  /** No new start this close to either window's reset. */
  readonly startRunwayMinutes: number;
  readonly defaultMaxMinutes: number;
};

export type RepoCommands = {
  readonly test: ShellCommand | null;
  readonly lint: ShellCommand | null;
  readonly build: ShellCommand | null;
};

export type Repo = { readonly key: RepoKey; readonly path: AbsPath; readonly commands: RepoCommands };

export type Config = { readonly limits: Limits; readonly repos: readonly Repo[] };

// tasks (user-owned)

export type Priority = "high" | "normal" | "low";

export type TaskSource =
  | { readonly kind: "queue-file"; readonly index: number }
  | { readonly kind: "added"; readonly file: AbsPath; readonly addedAt: Date | null };

/** A validated declaration. One without a resolvable done check is a QueueProblem, never a Task. */
export type Task = {
  readonly id: TaskId;
  readonly repo: Repo;
  readonly prompt: string;
  readonly priority: Priority;
  /** Added to the defaults, never replacing them. */
  readonly tools: readonly ToolPattern[];
  /** null is Claude Code's default model. */
  readonly model: string | null;
  readonly maxMinutes: number;
  readonly check: ShellCommand;
  readonly source: TaskSource;
};

/** What an attempt snapshots from its Task at claim time, so later queue edits don't rewrite history. */
export type TaskSpec = Pick<Task, "prompt" | "tools" | "model" | "maxMinutes" | "check"> & {
  readonly repo: Pick<Repo, "key" | "path">;
};

export type QueueProblem = { readonly where: string; readonly message: string };

// usage

export type WindowName = "session" | "week";
export type Window = { readonly usedPct: Percent; readonly resetsAt: Date; readonly observedAt: Date };
/** `/usage` prints the session line with no reset clause when no 5-hour window is open. */
export type SessionWindow =
  | ({ readonly kind: "open" } & Window)
  | { readonly kind: "none"; readonly usedPct: Percent; readonly observedAt: Date };

/**
 * The current belief about both windows. A `/usage` probe replaces it wholesale. Each
 * `rate_limit_event` overlays the windows it carries.
 */
export type UsageSnapshot = {
  readonly probedAt: Date;
  readonly session: SessionWindow;
  readonly week: Window;
  /** Per-model weekly windows such as Fable. Parsed and kept, not enforced in M1. */
  readonly modelWeeks: readonly { readonly model: string; readonly window: Window }[];
};

export type UsageUpdate = { readonly session: Window | null; readonly week: Window | null };

/** Minted only by claude.checkLogin for a claude.ai login. Required to spawn anything that spends. */
export type SubscriptionProof = { readonly __brand: "SubscriptionProof" };

export type Login =
  | { readonly kind: "subscription"; readonly plan: string | null; readonly proof: SubscriptionProof }
  | { readonly kind: "api-key"; readonly source: string | null }
  | { readonly kind: "logged-out" }
  | { readonly kind: "unreadable"; readonly detail: string };

// agent

/** A pid plus its exact start time (`ps -o lstart=`), which survives pid reuse. */
export type ProcessToken = { readonly pid: number; readonly lstart: string };

/** A stop rule fired. Every StopReason makes the attempt `partial`. */
export type StopReason =
  | { readonly kind: "reserve-reached"; readonly window: WindowName; readonly usedPct: Percent; readonly reservePct: Percent }
  | { readonly kind: "reset-soon"; readonly window: WindowName; readonly resetsAt: Date }
  | { readonly kind: "time-cap"; readonly maxMinutes: number }
  | { readonly kind: "usage-unreadable"; readonly detail: string }
  | { readonly kind: "user-stop" };

/** The `init` guard tripped and the agent was killed before its first turn. */
export type RefusalReason =
  | { readonly kind: "api-key"; readonly source: string }
  | { readonly kind: "permission-mode"; readonly mode: string }
  | { readonly kind: "no-init" };

export type Denial = { readonly tool: string; readonly input: string };

export type AgentExit =
  | {
      readonly kind: "finished";
      readonly isError: boolean;
      readonly numTurns: number;
      readonly denials: readonly Denial[];
      readonly summary: string;
    }
  | { readonly kind: "stopped"; readonly reason: StopReason }
  | { readonly kind: "refused"; readonly reason: RefusalReason }
  | { readonly kind: "crashed"; readonly code: number | null; readonly signal: string | null; readonly stderrTail: string };

// work

/** Cumulative diff of the task branch against its base, so it spans every attempt. */
export type DiffStat = { readonly files: number; readonly insertions: number; readonly deletions: number };

/** What sealWork recorded: the commit it made (null when nothing changed) and the cumulative diff. */
export type Sealed = { readonly commit: CommitSha | null; readonly diff: DiffStat };

export type CheckRun =
  | { readonly kind: "exited"; readonly code: number; readonly tail: string }
  | { readonly kind: "timed-out"; readonly tail: string };

// attempts (syt-owned)

export type ContinueWhy = "partial" | "interrupted" | "failed" | "errored";

/**
 * What the next attempt does. Derived by policy.taskStatus from history, never stored ahead of time.
 * `continue` reuses the earlier worktree and base, and resumes `session` when there is one.
 * `finish` spends nothing: the earlier agent already exited, so the attempt only seals, checks and classifies.
 */
export type AttemptPlan =
  | { readonly kind: "fresh"; readonly prompt: string }
  | {
      readonly kind: "continue";
      readonly why: ContinueWhy;
      readonly from: AttemptNo;
      readonly session: SessionId | null;
      readonly worktree: AbsPath;
      readonly base: CommitSha;
      readonly prompt: string;
    }
  | {
      readonly kind: "finish";
      readonly from: AttemptNo;
      readonly worktree: AbsPath;
      readonly base: CommitSha;
      readonly exit: AgentExit;
      readonly sealed: Sealed | null;
    };

export type RunError =
  | { readonly kind: "refused"; readonly reason: RefusalReason }
  | { readonly kind: "agent-crashed"; readonly code: number | null; readonly signal: string | null; readonly stderrTail: string }
  | { readonly kind: "agent-error"; readonly summary: string }
  | { readonly kind: "worktree"; readonly detail: string }
  | { readonly kind: "internal"; readonly detail: string };

export type RunResult =
  | { readonly kind: "passed"; readonly check: CheckRun }
  | { readonly kind: "failed"; readonly check: CheckRun }
  | { readonly kind: "partial"; readonly stop: StopReason }
  | { readonly kind: "no-op" }
  | { readonly kind: "errored"; readonly error: RunError };

export type RunEnd = {
  readonly endedAt: Date;
  readonly result: RunResult;
  readonly usageAfter: UsageSnapshot | null;
  readonly diff: DiffStat | null;
  readonly commit: CommitSha | null;
  readonly denials: readonly Denial[];
};

/** runs/<task>/<attempt>.json. Created exclusively by the claimer, and only the claimer rewrites it. */
export type AttemptRecord = {
  readonly v: 1;
  readonly task: TaskId;
  readonly attempt: AttemptNo;
  readonly spend: SpendNo;
  readonly owner: ProcessToken;
  readonly plan: AttemptPlan;
  readonly spec: TaskSpec;
  readonly worktree: AbsPath;
  readonly branch: BranchName;
  readonly base: CommitSha;
  readonly startedAt: Date;
  readonly usageBefore: UsageSnapshot | null;
  readonly agent: { readonly process: ProcessToken; readonly argv: readonly string[] } | null;
  readonly session: SessionId | null;
  /** Noted the moment the agent exits, so a crash afterwards finishes without spending tokens. */
  readonly exited: AgentExit | null;
  readonly sealed: Sealed | null;
  readonly end: RunEnd | null;
};

/** Derived, never stored. A record without `end` is live while its owner runs, and interrupted after. */
export type AttemptState =
  | { readonly kind: "live" }
  | { readonly kind: "interrupted"; readonly orphan: ProcessToken | null }
  | { readonly kind: "ended"; readonly end: RunEnd };

export type RunFiles = { readonly record: AbsPath; readonly stream: AbsPath; readonly stderr: AbsPath; readonly check: AbsPath };

export type AttemptView = Omit<AttemptRecord, "end"> & { readonly state: AttemptState; readonly files: RunFiles };

// spends (syt-owned)

/** M1 has only `manual` (`syt run --now`). */
export type SpendMode = { readonly kind: "manual"; readonly only: TaskId | null };

/** Stops that apply to the whole spend: no new starts, and every running agent stops at its next turn. */
export type SpendWideStop = Extract<StopReason, { readonly kind: "usage-unreadable" | "user-stop" }>;

export type HaltReason =
  | SpendWideStop
  | Extract<StopReason, { readonly kind: "reset-soon" }>
  | { readonly kind: "queue-drained" }
  | { readonly kind: "near-reserve"; readonly window: WindowName; readonly usedPct: Percent; readonly startLimitPct: Percent }
  | { readonly kind: "not-subscription"; readonly login: Login }
  | { readonly kind: "agent-refused"; readonly reason: RefusalReason }
  | { readonly kind: "task-not-runnable"; readonly task: TaskId; readonly status: TaskStatus["kind"] | "missing" }
  /** Another spend claimed a lower number in the same instant. */
  | { readonly kind: "busy"; readonly holder: SpendNo };

export type RepoSkip = { readonly repo: RepoKey; readonly reason: "dirty" | "not-a-repo"; readonly detail: string };

export type SpendEnd = { readonly endedAt: Date; readonly halt: HaltReason; readonly skipped: readonly RepoSkip[] };

/** spends/<n>.json. A live one is the system-wide spend lock. */
export type SpendRecord = {
  readonly v: 1;
  readonly spend: SpendNo;
  readonly owner: ProcessToken;
  readonly mode: SpendMode;
  readonly startedAt: Date;
  readonly end: SpendEnd | null;
};

export type SpendState = { readonly kind: "live" } | { readonly kind: "interrupted" } | { readonly kind: "ended"; readonly end: SpendEnd };
export type SpendView = Omit<SpendRecord, "end"> & { readonly state: SpendState };

export type Ledger = {
  /** Ascending by attempt number. */
  readonly attempts: ReadonlyMap<TaskId, readonly AttemptView[]>;
  /** Ascending by spend number. */
  readonly spends: readonly SpendView[];
  /** Unreadable or foreign files. Shown, never fatal. */
  readonly problems: readonly string[];
};

// derived task status

export type FlagReason = "failed-twice" | "resumed-twice" | "errored-twice";

export type TaskStatus =
  | { readonly kind: "ready"; readonly plan: AttemptPlan }
  | { readonly kind: "running"; readonly attempt: AttemptNo; readonly spend: SpendNo }
  | { readonly kind: "done"; readonly outcome: "passed" | "no-op"; readonly attempt: AttemptNo }
  /** `next` is what `syt run --now --task <id>` runs anyway, as an explicit override. */
  | { readonly kind: "flagged"; readonly why: FlagReason; readonly next: AttemptPlan };

export type QueueEntry = { readonly task: Task; readonly status: TaskStatus };
