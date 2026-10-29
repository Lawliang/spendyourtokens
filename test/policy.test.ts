import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LIMITS } from "../src/config.ts";
import { admission, conclude, pickNext, planQueue, stopReason, taskStatus } from "../src/policy.ts";
import { percentOrThrow } from "../src/model.ts";
import type {
  AbsPath,
  AgentExit,
  AttemptNo,
  AttemptPlan,
  AttemptState,
  AttemptView,
  BranchName,
  CommitSha,
  Ledger,
  Priority,
  RepoKey,
  RunResult,
  SessionId,
  ShellCommand,
  SpendNo,
  Task,
  TaskId,
  UsageSnapshot,
} from "../src/model.ts";

const NOW = new Date("2026-10-28T19:05:00-07:00");
const MIN = 60_000;
const AGE = 10 * MIN;
const later = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);

function usage(session: number | null, week: number, opts: { sessionResetIn?: number; weekResetIn?: number; observedAt?: Date } = {}): UsageSnapshot {
  const observedAt = opts.observedAt ?? NOW;
  return {
    probedAt: observedAt,
    session:
      session === null
        ? { kind: "none", usedPct: percentOrThrow(0), observedAt }
        : { kind: "open", usedPct: percentOrThrow(session), resetsAt: later(opts.sessionResetIn ?? 180), observedAt },
    week: { usedPct: percentOrThrow(week), resetsAt: later(opts.weekResetIn ?? 1500), observedAt },
    modelWeeks: [],
  };
}

const admit = (view: UsageSnapshot, now = NOW) =>
  admission({ view, now, limits: DEFAULT_LIMITS, mode: { kind: "manual", only: null }, maxReadingAgeMs: AGE });
const stopAt = (view: UsageSnapshot, startedMinutesAgo = 0, now = NOW) =>
  stopReason({ view, now, limits: DEFAULT_LIMITS, startedAt: new Date(now.getTime() - startedMinutesAgo * MIN), maxMinutes: 60, maxReadingAgeMs: AGE });

describe("admission", () => {
  it("opens below both start limits and closes at them", () => {
    const cases: [number | null, number, string][] = [
      [6, 22, "open"],
      [79, 22, "open"],
      [80, 22, "near-reserve:session"],
      [6, 89, "open"],
      [6, 90, "near-reserve:week"],
      [null, 50, "open"],
    ];
    for (const [s, w, want] of cases) {
      const a = admit(usage(s, w));
      const got = a.kind === "open" ? "open" : a.reason.kind === "near-reserve" ? `near-reserve:${a.reason.window}` : a.reason.kind;
      assert.equal(got, want, `session ${s}, week ${w}`);
    }
  });

  it("closes within the 15-minute runway of either reset", () => {
    assert.equal(admit(usage(6, 22, { sessionResetIn: 16 })).kind, "open");
    const s = admit(usage(6, 22, { sessionResetIn: 15 }));
    assert.ok(s.kind === "closed" && s.reason.kind === "reset-soon" && s.reason.window === "session");
    const w = admit(usage(6, 22, { weekResetIn: 10 }));
    assert.ok(w.kind === "closed" && w.reason.kind === "reset-soon" && w.reason.window === "week");
  });

  it("closes on a stale or rolled-over reading, never treating it as zero", () => {
    const stale = admit(usage(0, 0, { observedAt: new Date(NOW.getTime() - AGE - 1) }));
    assert.ok(stale.kind === "closed" && stale.reason.kind === "usage-unreadable");
    const rolled = admit(usage(0, 0, { sessionResetIn: 5 }), later(6));
    assert.ok(rolled.kind === "closed" && rolled.reason.kind === "usage-unreadable");
  });
});

describe("stopReason", () => {
  it("stops at each reserve", () => {
    assert.equal(stopAt(usage(84, 94)), null);
    assert.deepEqual(stopAt(usage(85, 22)), { kind: "reserve-reached", window: "session", usedPct: 85, reservePct: 15 });
    assert.deepEqual(stopAt(usage(6, 95)), { kind: "reserve-reached", window: "week", usedPct: 95, reservePct: 5 });
  });

  it("stops 5 minutes before either reset, ahead of a reserve", () => {
    assert.equal(stopAt(usage(6, 22, { sessionResetIn: 6 })), null);
    assert.equal(stopAt(usage(90, 22, { sessionResetIn: 5 }))?.kind, "reset-soon");
    assert.equal(stopAt(usage(6, 22, { weekResetIn: 4 }))?.kind, "reset-soon");
  });

  it("stops at the task's time cap", () => {
    assert.equal(stopAt(usage(6, 22), 59), null);
    assert.deepEqual(stopAt(usage(6, 22), 60), { kind: "time-cap", maxMinutes: 60 });
  });

  it("leaves an unknown window to the runner's re-probe", () => {
    assert.equal(stopAt(usage(99, 99, { observedAt: new Date(NOW.getTime() - AGE - 1) })), null);
  });
});

const SESSION = "cf9ac047-8f1e-4ea2-8bbf-3b6cc8a19723" as SessionId;
const BASE = "a".repeat(40) as CommitSha;
const WORKTREE = "/home/me/.spendyourtokens/worktrees/app/t" as AbsPath;

function task(id: string, priority: Priority = "normal"): Task {
  return {
    id: id as TaskId,
    repo: { key: "app" as RepoKey, path: "/code/app" as AbsPath, commands: { test: null, lint: null, build: null } },
    prompt: `do ${id}`,
    priority,
    tools: [],
    model: null,
    maxMinutes: 60,
    check: "npm test" as ShellCommand,
    source: { kind: "queue-file", index: 0 },
  };
}

const finished: AgentExit = { kind: "finished", isError: false, numTurns: 3, denials: [], summary: "done" };
const ended = (result: RunResult): AttemptState => ({
  kind: "ended",
  end: { endedAt: NOW, result, usageAfter: null, diff: null, commit: null, denials: [] },
});
const results = {
  passed: { kind: "passed", check: { kind: "exited", code: 0, tail: "" } },
  failed: { kind: "failed", check: { kind: "exited", code: 1, tail: "1 failing: parser rejects '{'" } },
  partial: { kind: "partial", stop: { kind: "time-cap", maxMinutes: 60 } },
  noop: { kind: "no-op" },
  crashed: { kind: "errored", error: { kind: "agent-crashed", code: 1, signal: null, stderrTail: "boom" } },
  refused: { kind: "errored", error: { kind: "refused", reason: { kind: "api-key", source: "ANTHROPIC_API_KEY" } } },
} as const satisfies Record<string, RunResult>;

type Step = { plan: AttemptPlan["kind"] | `continue:${"partial" | "interrupted" | "failed" | "errored"}`; state: AttemptState; exited?: AgentExit; session?: SessionId | null };

function history(...steps: Step[]): AttemptView[] {
  return steps.map((s, i) => {
    const n = (i + 1) as AttemptNo;
    const plan: AttemptPlan =
      s.plan === "fresh"
        ? { kind: "fresh", prompt: "p" }
        : s.plan === "finish"
          ? { kind: "finish", from: i as AttemptNo, worktree: WORKTREE, base: BASE, exit: finished, sealed: null }
          : { kind: "continue", why: s.plan.split(":")[1] as "partial", from: i as AttemptNo, session: SESSION, worktree: WORKTREE, base: BASE, prompt: "c" };
    return {
      v: 1,
      task: "t" as TaskId,
      attempt: n,
      spend: n as number as SpendNo,
      owner: { pid: 1, lstart: "x" },
      plan,
      spec: { prompt: "p", tools: [], model: null, maxMinutes: 60, check: "npm test" as ShellCommand, repo: { key: "app" as RepoKey, path: "/code/app" as AbsPath } },
      worktree: WORKTREE,
      branch: "syt/t" as BranchName,
      base: BASE,
      startedAt: NOW,
      usageBefore: null,
      agent: null,
      session: s.session === undefined ? SESSION : s.session,
      exited: s.exited ?? null,
      sealed: null,
      state: s.state,
      files: { record: "/r" as AbsPath, stream: "/s" as AbsPath, stderr: "/e" as AbsPath, check: "/c" as AbsPath },
    };
  });
}

const interrupted: AttemptState = { kind: "interrupted", orphan: null };

describe("taskStatus", () => {
  const t = task("t");

  it("starts fresh, runs, and finishes done", () => {
    assert.deepEqual(taskStatus(t, []), { kind: "ready", plan: { kind: "fresh", prompt: "do t" } });
    assert.deepEqual(taskStatus(t, history({ plan: "fresh", state: { kind: "live" } })), { kind: "running", attempt: 1, spend: 1 });
    assert.deepEqual(taskStatus(t, history({ plan: "fresh", state: ended(results.passed) })), { kind: "done", outcome: "passed", attempt: 1 });
    assert.deepEqual(taskStatus(t, history({ plan: "fresh", state: ended(results.noop) })), { kind: "done", outcome: "no-op", attempt: 1 });
  });

  it("retries a failure once in the same session with the check output, then flags it", () => {
    const once = taskStatus(t, history({ plan: "fresh", state: ended(results.failed) }));
    assert.ok(once.kind === "ready" && once.plan.kind === "continue");
    assert.equal(once.plan.why, "failed");
    assert.equal(once.plan.session, SESSION);
    assert.equal(once.plan.worktree, WORKTREE);
    assert.match(once.plan.prompt, /parser rejects/);
    assert.match(once.plan.prompt, /npm test/);

    const twice = taskStatus(t, history({ plan: "fresh", state: ended(results.failed) }, { plan: "continue:failed", state: ended(results.failed) }));
    assert.ok(twice.kind === "flagged" && twice.why === "failed-twice" && twice.next.kind === "continue");
  });

  it("resumes partial work at most twice", () => {
    const p = { state: ended(results.partial) };
    const one = taskStatus(t, history({ plan: "fresh", ...p }));
    assert.ok(one.kind === "ready" && one.plan.kind === "continue" && one.plan.why === "partial");
    const two = taskStatus(t, history({ plan: "fresh", ...p }, { plan: "continue:partial", ...p }));
    assert.equal(two.kind, "ready");
    const three = taskStatus(t, history({ plan: "fresh", ...p }, { plan: "continue:partial", ...p }, { plan: "continue:partial", ...p }));
    assert.ok(three.kind === "flagged" && three.why === "resumed-twice");
  });

  it("counts an interruption before the agent exited as a resume", () => {
    const status = taskStatus(t, history({ plan: "fresh", state: interrupted }, { plan: "continue:interrupted", state: interrupted }, { plan: "continue:interrupted", state: interrupted }));
    assert.ok(status.kind === "flagged" && status.why === "resumed-twice");
  });

  it("finishes an attempt whose agent exited before the crash, without counting a resume", () => {
    const p = { state: ended(results.partial) };
    const attempts = history({ plan: "fresh", ...p }, { plan: "continue:partial", ...p }, { plan: "continue:partial", state: interrupted, exited: finished });
    const status = taskStatus(t, attempts);
    assert.ok(status.kind === "ready" && status.plan.kind === "finish");
    assert.equal(status.plan.from, 3);
    assert.deepEqual(status.plan.exit, finished);

    const afterFinish = taskStatus(t, history({ plan: "fresh", ...p }, { plan: "continue:partial", state: ended(results.passed) }, { plan: "finish", state: ended(results.partial), session: null }));
    assert.ok(afterFinish.kind === "ready" && afterFinish.plan.kind === "continue");
    assert.equal(afterFinish.plan.session, SESSION, "resumes the newest session, past a finish that had none");
  });

  it("flags after two errors, but a refusal is not the task's error", () => {
    const refused = taskStatus(t, history({ plan: "fresh", state: ended(results.crashed) }, { plan: "continue:errored", state: ended(results.refused) }));
    assert.equal(refused.kind, "ready");
    const crashed = taskStatus(t, history({ plan: "fresh", state: ended(results.crashed) }, { plan: "continue:errored", state: ended(results.crashed) }));
    assert.ok(crashed.kind === "flagged" && crashed.why === "errored-twice");
  });

  it("restates the task prompt when there is no session to resume", () => {
    const status = taskStatus(t, history({ plan: "fresh", state: interrupted, session: null }));
    assert.ok(status.kind === "ready" && status.plan.kind === "continue");
    assert.equal(status.plan.session, null);
    assert.match(status.plan.prompt, /^do t/);
  });
});

function ledgerOf(entries: Record<string, AttemptView[]>): Ledger {
  return { attempts: new Map(Object.entries(entries).map(([k, v]) => [k as TaskId, v])), spends: [], problems: [] };
}

describe("planQueue and pickNext", () => {
  const tasks = [task("low-fresh", "low"), task("done"), task("retry", "high"), task("high-fresh", "high"), task("resume", "low"), task("flagged")];
  const ledger = ledgerOf({
    done: history({ plan: "fresh", state: ended(results.passed) }),
    retry: history({ plan: "fresh", state: ended(results.failed) }),
    resume: history({ plan: "fresh", state: ended(results.partial) }),
    flagged: history({ plan: "fresh", state: ended(results.failed) }, { plan: "continue:failed", state: ended(results.failed) }),
  });
  const plan = planQueue(tasks, ledger);
  const manual = (only: string | null) => ({ kind: "manual" as const, only: only as TaskId | null });

  it("orders resumes, then fresh tasks by priority, then retries, then the rest", () => {
    assert.deepEqual(plan.map((e) => e.task.id), ["resume", "high-fresh", "low-fresh", "retry", "flagged", "done"]);
  });

  it("picks the first ready task not already tried this spend", () => {
    const first = pickNext({ plan, mode: manual(null), exclude: new Set() });
    assert.equal(first.kind === "run" && first.task.id, "resume");
    const next = pickNext({ plan, mode: manual(null), exclude: new Set(["resume", "high-fresh", "low-fresh"] as TaskId[]) });
    assert.equal(next.kind === "run" && next.task.id, "retry");
    const none = pickNext({ plan, mode: manual(null), exclude: new Set(["resume", "high-fresh", "low-fresh", "retry"] as TaskId[]) });
    assert.deepEqual(none, { kind: "none", halt: { kind: "queue-drained" } });
  });

  it("lets --task force a flagged task but not a done or missing one", () => {
    const forced = pickNext({ plan, mode: manual("flagged"), exclude: new Set() });
    assert.ok(forced.kind === "run" && forced.plan.kind === "continue");
    assert.deepEqual(pickNext({ plan, mode: manual("done"), exclude: new Set() }), {
      kind: "none",
      halt: { kind: "task-not-runnable", task: "done", status: "done" },
    });
    assert.deepEqual(pickNext({ plan, mode: manual("ghost"), exclude: new Set() }), {
      kind: "none",
      halt: { kind: "task-not-runnable", task: "ghost", status: "missing" },
    });
  });
});

describe("conclude", () => {
  const diff = { files: 2, insertions: 10, deletions: 1 };
  const none = { files: 0, insertions: 0, deletions: 0 };
  const final = (exit: AgentExit, d = diff) => {
    const c = conclude({ exit, diff: d });
    return c.kind === "final" ? c.result.kind : "run-check";
  };

  it("classifies in the brief's order", () => {
    assert.equal(final({ kind: "stopped", reason: { kind: "user-stop" } }), "partial");
    assert.equal(final({ kind: "refused", reason: { kind: "no-init" } }), "errored");
    assert.equal(final({ kind: "crashed", code: 1, signal: null, stderrTail: "" }), "errored");
    assert.equal(final({ ...finished, isError: true }), "errored");
    assert.equal(final(finished, none), "no-op");
    assert.equal(final(finished), "run-check");
  });

  it("lets the done check decide passed or failed", () => {
    const c = conclude({ exit: finished, diff });
    assert.equal(c.kind, "run-check");
    if (c.kind !== "run-check") return;
    assert.equal(c.then({ kind: "exited", code: 0, tail: "" }).kind, "passed");
    assert.equal(c.then({ kind: "exited", code: 1, tail: "" }).kind, "failed");
    assert.equal(c.then({ kind: "timed-out", tail: "" }).kind, "failed");
  });
});
