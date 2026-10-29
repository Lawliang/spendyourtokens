/**
 * One spend run: the only place where policy, the ledger, git and the agent meet. `spend()` is the
 * whole public surface.
 *
 * State inside the process (single-threaded, so no locks):
 *   ctx.view      the one usage belief, written by probes and by every agent's usage events
 *   ctx.halt      why no new attempt may start (first reason wins; a spend-wide stop overrides)
 *   ctx.stopAll   a spend-wide stop every running agent honors at its next turn
 *   ctx.running   the live attempts
 * Across processes, openSpend makes this the only live spend, so none of it is shared.
 */

import { checkLogin, probeUsage, startAgent } from "./claude.ts";
import type { Agent, UsageProbe } from "./claude.ts";
import type { Env } from "./config.ts";
import type {
  AbsPath,
  AgentExit,
  AttemptPlan,
  AttemptView,
  CommitSha,
  Config,
  HaltReason,
  Login,
  RepoSkip,
  RunResult,
  Sealed,
  SpendMode,
  SpendNo,
  SpendView,
  SpendWideStop,
  SubscriptionProof,
  Task,
  TaskId,
  UsageSnapshot,
  WindowName,
} from "./model.ts";
import { admission, conclude, pickNext, planQueue, stopReason } from "./policy.ts";
import { stopGroup } from "./proc.ts";
import { loadQueue } from "./queue.ts";
import { loadLedger, openSpend } from "./runs.ts";
import type { AttemptHandle, SpendHandle } from "./runs.ts";
import { mergeUpdate, readWindow } from "./usage.ts";
import { branchFor, ensureWorktree, inspectBase, resetWorktree, runCheck, sealWork, worktreePathFor } from "./worktree.ts";

/** The first SIGINT/SIGTERM/SIGHUP aborts `stop`, the second aborts `kill`. */
export type Brakes = { readonly stop: AbortSignal; readonly kill: AbortSignal };

export type SpendEvent =
  | { readonly kind: "opened"; readonly spend: SpendNo; readonly login: Login; readonly view: UsageSnapshot }
  | { readonly kind: "started"; readonly task: TaskId; readonly plan: AttemptPlan; readonly worktree: AbsPath; readonly attempt: AttemptHandle["ref"] }
  | { readonly kind: "skipped"; readonly task: TaskId; readonly skip: RepoSkip }
  | { readonly kind: "ended"; readonly attempt: AttemptView }
  | { readonly kind: "halting"; readonly reason: HaltReason };

export type SpendOptions = {
  readonly mode: SpendMode;
  readonly config: Config;
  readonly brakes: Brakes;
  /** Progress for humans. Must not throw. */
  readonly observe: (event: SpendEvent) => void;
};

export type SpendSummary =
  | { readonly kind: "busy"; readonly active: SpendView }
  /** Preflight failed (not a subscription, `/usage` unreadable). The spend record says why. */
  | { readonly kind: "refused"; readonly spend: SpendNo; readonly halt: HaltReason }
  | {
      readonly kind: "ran";
      readonly spend: SpendNo;
      readonly halt: HaltReason;
      readonly attempts: readonly AttemptView[];
      readonly skipped: readonly RepoSkip[];
    };

const WINDOWS: readonly WindowName[] = ["session", "week"];

type Slot = { readonly task: Task; agent: Agent | null; startedAt: Date | null; done: Promise<void> };

type SpendCtx = {
  readonly env: Env;
  readonly config: Config;
  readonly mode: SpendMode;
  readonly spend: SpendHandle;
  readonly observe: SpendOptions["observe"];
  proof: SubscriptionProof | null;
  view: UsageSnapshot | null;
  halt: HaltReason | null;
  stopAll: SpendWideStop | null;
  killed: boolean;
  probing: Promise<boolean> | null;
  readonly running: Map<TaskId, Slot>;
  readonly tried: Set<TaskId>;
  readonly skipped: RepoSkip[];
  readonly ended: AttemptView[];
  readonly tracked: Promise<unknown>[];
};

/**
 *   openSpend                          busy: return busy
 *   reap orphans of crashed spends, check the login, probe /usage
 *                                      not a subscription or unreadable: refused
 *   until nothing runs: fill free slots, then wait for one to finish
 *   timers: re-probe every usagePollMs; every tickMs apply time-based stop rules
 *   finally: close the spend with its halt reason
 */
export async function spend(env: Env, opts: SpendOptions): Promise<SpendSummary> {
  const opened = await openSpend(env, opts.mode);
  if (opened.kind === "busy") return { kind: "busy", active: opened.active };

  const ctx: SpendCtx = {
    env,
    config: opts.config,
    mode: opts.mode,
    spend: opened.spend,
    observe: opts.observe,
    proof: null,
    view: null,
    halt: null,
    stopAll: null,
    killed: false,
    probing: null,
    running: new Map(),
    tried: new Set(),
    skipped: [],
    ended: [],
    tracked: [],
  };
  const timers: NodeJS.Timeout[] = [];
  const onStop = () => haltAll(ctx, { kind: "user-stop" });
  const onKill = () => {
    ctx.killed = true;
    haltAll(ctx, { kind: "user-stop" });
    for (const slot of ctx.running.values()) slot.agent?.kill({ kind: "user-stop" });
  };

  let outcome: "refused" | "ran" = "refused";
  try {
    for (const attempts of (await loadLedger(env)).attempts.values()) {
      for (const a of attempts) if (a.state.kind === "interrupted" && a.state.orphan !== null) await stopGroup(a.state.orphan, env.timing.killGraceMs);
    }

    const login = await checkLogin(env);
    if (login.kind !== "subscription") {
      ctx.halt = { kind: "not-subscription", login };
      return refusedOrRan(ctx, outcome);
    }
    ctx.proof = login.proof;
    const probe = await probeUsage(env, login.proof);
    if (probe.kind !== "ok") {
      ctx.halt = probe.kind === "not-subscription" ? { kind: "not-subscription", login } : { kind: "usage-unreadable", detail: describeProbe(probe) };
      return refusedOrRan(ctx, outcome);
    }
    ctx.view = probe.snapshot;
    outcome = "ran";
    opts.observe({ kind: "opened", spend: ctx.spend.no, login, view: probe.snapshot });

    timers.push(setInterval(() => void refreshUsage(ctx), env.timing.usagePollMs));
    timers.push(setInterval(() => tick(ctx), env.timing.tickMs));
    if (opts.brakes.stop.aborted) onStop();
    else opts.brakes.stop.addEventListener("abort", onStop, { once: true });
    if (opts.brakes.kill.aborted) onKill();
    else opts.brakes.kill.addEventListener("abort", onKill, { once: true });

    for (;;) {
      await fillSlots(ctx);
      if (ctx.running.size === 0) break;
      await Promise.race([...ctx.running.values()].map((s) => s.done));
    }
    return refusedOrRan(ctx, outcome);
  } finally {
    for (const t of timers) clearInterval(t);
    opts.brakes.stop.removeEventListener("abort", onStop);
    opts.brakes.kill.removeEventListener("abort", onKill);
    await Promise.all(ctx.tracked);
    await ctx.spend.close({ endedAt: env.now(), halt: ctx.halt ?? { kind: "queue-drained" }, skipped: ctx.skipped });
  }
}

function refusedOrRan(ctx: SpendCtx, outcome: "refused" | "ran"): SpendSummary {
  const halt = ctx.halt ?? { kind: "queue-drained" };
  return outcome === "refused"
    ? { kind: "refused", spend: ctx.spend.no, halt }
    : { kind: "ran", spend: ctx.spend.no, halt, attempts: ctx.ended, skipped: ctx.skipped };
}

function describeProbe(probe: Exclude<UsageProbe, { kind: "ok" | "not-subscription" }>): string {
  return probe.kind === "probe-failed" ? probe.detail : `/usage output not recognized (${probe.reason}${probe.line ? `: ${probe.line}` : ""})`;
}

/** Re-reads /usage. A failure, or a window still unknown after the fresh read, stops the whole spend. */
function refreshUsage(ctx: SpendCtx): Promise<boolean> {
  if (ctx.proof === null) return Promise.resolve(false);
  const proof = ctx.proof;
  ctx.probing ??= (async () => {
    const probe = await probeUsage(ctx.env, proof);
    if (probe.kind !== "ok") {
      haltAll(ctx, { kind: "usage-unreadable", detail: probe.kind === "not-subscription" ? "/usage now shows the API-key cost summary" : describeProbe(probe) });
      return false;
    }
    ctx.view = probe.snapshot;
    for (const name of WINDOWS) {
      const r = readWindow(probe.snapshot, name, ctx.env.now(), ctx.env.timing.maxReadingAgeMs);
      if (r.kind === "unknown") {
        haltAll(ctx, { kind: "usage-unreadable", detail: `the ${name} window is ${r.why} even on a fresh /usage read` });
        return false;
      }
    }
    return true;
  })().finally(() => {
    ctx.probing = null;
  });
  return ctx.probing;
}

function anyUnknown(ctx: SpendCtx, view: UsageSnapshot): boolean {
  const now = ctx.env.now();
  return WINDOWS.some((name) => readWindow(view, name, now, ctx.env.timing.maxReadingAgeMs).kind === "unknown");
}

/** Applies the time-based stop rules to agents that haven't reached a turn boundary lately. */
function tick(ctx: SpendCtx): void {
  if (ctx.view === null) return;
  if (ctx.running.size > 0 && anyUnknown(ctx, ctx.view)) void refreshUsage(ctx);
  for (const slot of ctx.running.values()) {
    if (slot.agent === null || slot.startedAt === null) continue;
    const reason = ctx.stopAll ?? stopFor(ctx, slot.task, slot.startedAt);
    if (reason !== null) slot.agent.requestStop(reason);
  }
}

function stopFor(ctx: SpendCtx, task: Task, startedAt: Date) {
  if (ctx.view === null) return null;
  return stopReason({
    view: ctx.view,
    now: ctx.env.now(),
    limits: ctx.config.limits,
    startedAt,
    maxMinutes: task.maxMinutes,
    maxReadingAgeMs: ctx.env.timing.maxReadingAgeMs,
  });
}

/**
 * Starts attempts while there's a free slot: re-probe when the reading is old, check admission,
 * read the queue and ledger fresh (so edits apply), pick the next task, and find where it runs.
 */
async function fillSlots(ctx: SpendCtx): Promise<void> {
  const { env, config, mode } = ctx;
  while (ctx.halt === null && ctx.running.size < config.limits.concurrency) {
    const view = ctx.view;
    if (view === null) return;
    if (env.now().getTime() - view.probedAt.getTime() > env.timing.usageFreshMs || anyUnknown(ctx, view)) {
      if (!(await refreshUsage(ctx))) return;
    }
    if (ctx.view === null || ctx.halt !== null) return;
    const gate = admission({ view: ctx.view, now: env.now(), limits: config.limits, mode, maxReadingAgeMs: env.timing.maxReadingAgeMs });
    if (gate.kind === "closed") {
      setHalt(ctx, gate.reason);
      return;
    }

    const [queue, ledger] = await Promise.all([loadQueue(env, config), loadLedger(env)]);
    const next = pickNext({ plan: planQueue(queue.tasks, ledger), mode, exclude: new Set([...ctx.tried, ...ctx.running.keys()]) });
    if (next.kind === "none") {
      if (next.halt.kind !== "queue-drained") setHalt(ctx, next.halt);
      return;
    }
    const { task, plan } = next;
    ctx.tried.add(task.id);

    const where = await locate(ctx, task, plan);
    if (where.kind === "skip") {
      ctx.skipped.push(where.skip);
      ctx.observe({ kind: "skipped", task: task.id, skip: where.skip });
      continue;
    }
    if (ctx.halt !== null) return;

    const slot: Slot = { task, agent: null, startedAt: null, done: Promise.resolve() };
    slot.done = runAttempt(ctx, slot, plan, where)
      .then((view) => {
        if (view === null) return;
        ctx.ended.push(view);
        ctx.observe({ kind: "ended", attempt: view });
      })
      .finally(() => ctx.running.delete(task.id));
    ctx.running.set(task.id, slot);
  }
}

type Where = { readonly kind: "here"; readonly worktree: AbsPath; readonly base: CommitSha } | { readonly kind: "skip"; readonly skip: RepoSkip };

/** A fresh plan branches from the checkout's HEAD, so it needs a clean checkout. A continuation carries its own worktree. */
async function locate(ctx: SpendCtx, task: Task, plan: AttemptPlan): Promise<Where> {
  if (plan.kind !== "fresh") return { kind: "here", worktree: plan.worktree, base: plan.base };
  const base = await inspectBase(task.repo.path);
  if (base.kind === "clean") return { kind: "here", worktree: worktreePathFor(ctx.env, task.repo, task.id), base: base.head };
  return { kind: "skip", skip: { repo: task.repo.key, reason: base.kind, detail: base.detail } };
}

/** One attempt, claim to finish. Never throws: an unexpected failure ends the attempt as errored. */
async function runAttempt(ctx: SpendCtx, slot: Slot, plan: AttemptPlan, where: Extract<Where, { kind: "here" }>): Promise<AttemptView | null> {
  const { task } = slot;
  const handle = await ctx.spend.claim({ task, plan, worktree: where.worktree, branch: branchFor(task.id), base: where.base, usageBefore: ctx.view });
  if (handle === null) return null;
  ctx.observe({ kind: "started", task: task.id, plan, worktree: where.worktree, attempt: handle.ref });
  try {
    return await attempt(ctx, slot, plan, where, handle);
  } catch (e) {
    return handle
      .finish({ endedAt: ctx.env.now(), result: { kind: "errored", error: { kind: "internal", detail: (e as Error).message } }, usageAfter: ctx.view, diff: null, commit: null, denials: [] })
      .catch(() => null);
  }
}

async function attempt(ctx: SpendCtx, slot: Slot, plan: AttemptPlan, where: Extract<Where, { kind: "here" }>, handle: AttemptHandle): Promise<AttemptView> {
  const { env } = ctx;
  const { task } = slot;
  const finish = (result: RunResult, sealed: Sealed | null, exit: AgentExit | null) =>
    handle.finish({
      endedAt: env.now(),
      result,
      usageAfter: ctx.view,
      diff: sealed?.diff ?? null,
      commit: sealed?.commit ?? null,
      denials: exit?.kind === "finished" ? exit.denials : [],
    });

  const ready = await ensureWorktree({ repo: task.repo.path, path: where.worktree, branch: branchFor(task.id), base: where.base });
  if (ready.kind === "conflict") return finish({ kind: "errored", error: { kind: "worktree", detail: ready.detail } }, null, null);

  let exit: AgentExit;
  let sealed: Sealed;
  if (plan.kind === "finish") {
    exit = plan.exit;
    await handle.note({ kind: "exited", exit });
    sealed = plan.sealed ?? (await sealWork({ path: where.worktree, base: where.base, message: `syt: ${task.id} attempt ${plan.from}` }));
    await handle.note({ kind: "sealed", sealed });
    await resetWorktree({ path: where.worktree, to: sealed.commit });
  } else {
    if (ctx.proof === null) throw new Error("spawning an agent needs the subscription proof");
    if (ctx.stopAll !== null) return finish({ kind: "partial", stop: ctx.stopAll }, null, null);
    const agent = await startAgent(
      env,
      ctx.proof,
      { task, plan, cwd: where.worktree, files: handle.files },
      {
        onSession: (id) => ctx.tracked.push(handle.note({ kind: "session", id }).catch(() => {})),
        onUsage: (update) => {
          if (ctx.view !== null) ctx.view = mergeUpdate(ctx.view, update);
        },
        stopAt: () => ctx.stopAll ?? stopFor(ctx, task, handle.startedAt),
      },
    );
    slot.agent = agent;
    slot.startedAt = handle.startedAt;
    if (ctx.killed) agent.kill({ kind: "user-stop" });
    else if (ctx.stopAll !== null) agent.requestStop(ctx.stopAll);
    await handle.note({ kind: "agent", process: agent.process, argv: agent.argv });

    exit = await agent.exited;
    slot.agent = null;
    await handle.note({ kind: "exited", exit });
    if (exit.kind === "refused") setHalt(ctx, { kind: "agent-refused", reason: exit.reason });
    sealed = await sealWork({ path: where.worktree, base: where.base, message: `syt: ${task.id} attempt ${handle.ref.attempt}` });
    await handle.note({ kind: "sealed", sealed });
  }

  const c = conclude({ exit, diff: sealed.diff });
  const result =
    c.kind === "final"
      ? c.result
      : c.then(await runCheck({ path: where.worktree, command: task.check, timeoutMs: env.timing.checkTimeoutMs, log: handle.files.check, restore: sealed.commit }));
  return finish(result, sealed, exit);
}

function setHalt(ctx: SpendCtx, reason: HaltReason): void {
  if (ctx.halt !== null) return;
  ctx.halt = reason;
  ctx.observe({ kind: "halting", reason });
}

/** No new starts, and every running agent stops at its next turn. Overrides a halt that only blocked starts. */
function haltAll(ctx: SpendCtx, reason: SpendWideStop): void {
  if (ctx.halt === null || (ctx.halt.kind !== "user-stop" && ctx.halt.kind !== "usage-unreadable")) {
    ctx.halt = reason;
    ctx.observe({ kind: "halting", reason });
  }
  ctx.stopAll ??= reason;
  for (const slot of ctx.running.values()) slot.agent?.requestStop(ctx.stopAll);
}
