import { randomBytes } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound } from "./config.ts";
import type { Env } from "./config.ts";
import { isTaskId } from "./model.ts";
import type {
  AbsPath,
  AgentExit,
  AttemptNo,
  AttemptPlan,
  AttemptRecord,
  AttemptState,
  AttemptView,
  BranchName,
  CommitSha,
  Ledger,
  ProcessToken,
  RunEnd,
  RunFiles,
  Sealed,
  SessionId,
  SpendEnd,
  SpendMode,
  SpendNo,
  SpendRecord,
  SpendView,
  Task,
  TaskId,
  UsageSnapshot,
} from "./model.ts";
import { isAlive, selfToken } from "./proc.ts";

export function runFiles(env: Env, task: TaskId, attempt: AttemptNo): RunFiles {
  const logs = path.join(env.home, "logs", task);
  return {
    record: path.join(env.home, "runs", task, `${attempt}.json`) as AbsPath,
    stream: path.join(logs, `${attempt}.jsonl`) as AbsPath,
    stderr: path.join(logs, `${attempt}.stderr.log`) as AbsPath,
    check: path.join(logs, `${attempt}.check.log`) as AbsPath,
  };
}

export async function loadLedger(env: Env): Promise<Ledger> {
  const problems: string[] = [];
  const liveness = livenessCache();
  const spends = await loadSpends(env, problems, liveness);

  const attempts = new Map<TaskId, AttemptView[]>();
  const runsDir = path.join(env.home, "runs");
  for (const task of await listDir(runsDir)) {
    if (!isTaskId(task)) {
      if (!task.startsWith(".")) problems.push(`runs/${task}: not a task id`);
      continue;
    }
    const views: AttemptView[] = [];
    for (const { n, file } of await numberedFiles(path.join(runsDir, task))) {
      const record = await readRecord(file, problems, (r): r is AttemptRecord => r.task === task && r.attempt === n && isRecordShape(r));
      if (record === null) continue;
      const { end, ...rest } = record;
      let state: AttemptState;
      if (end !== null) state = { kind: "ended", end };
      else if (await liveness(record.owner)) state = { kind: "live" };
      else state = { kind: "interrupted", orphan: record.agent !== null && (await liveness(record.agent.process)) ? record.agent.process : null };
      views.push({ ...rest, state, files: runFiles(env, task, record.attempt) });
    }
    if (views.length > 0) attempts.set(task, views);
  }
  return { attempts, spends, problems };
}

async function loadSpends(env: Env, problems: string[], liveness = livenessCache()): Promise<SpendView[]> {
  const views: SpendView[] = [];
  for (const { n, file } of await numberedFiles(path.join(env.home, "spends"))) {
    const record = await readRecord(file, problems, (r): r is SpendRecord => r.spend === n && isRecordShape(r));
    if (record === null) continue;
    const { end, ...rest } = record;
    const state = end !== null ? ({ kind: "ended", end } as const) : (await liveness(record.owner)) ? ({ kind: "live" } as const) : ({ kind: "interrupted" } as const);
    views.push({ ...rest, state });
  }
  return views;
}

function livenessCache(): (t: ProcessToken) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>();
  return (t) => {
    const key = `${t.pid}@${t.lstart}`;
    let p = seen.get(key);
    if (p === undefined) {
      p = isAlive(t);
      seen.set(key, p);
    }
    return p;
  };
}

const DATE_KEYS = new Set(["startedAt", "endedAt", "observedAt", "resetsAt", "probedAt"]);

function reviveDates(key: string, value: unknown): unknown {
  return DATE_KEYS.has(key) && typeof value === "string" ? new Date(value) : value;
}

function isRecordShape(r: Record<string, unknown>): boolean {
  const owner = r.owner as Record<string, unknown> | undefined;
  return r.v === 1 && typeof owner?.pid === "number" && typeof owner.lstart === "string" && r.startedAt instanceof Date && "end" in r;
}

async function readRecord<T>(file: string, problems: string[], valid: (r: Record<string, unknown>) => r is Record<string, unknown> & T): Promise<T | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"), reviveDates);
    if (typeof parsed === "object" && parsed !== null && valid(parsed as Record<string, unknown>)) return parsed as T;
    problems.push(`${file}: not a syt record`);
  } catch (e) {
    problems.push(`${file}: ${(e as Error).message}`);
  }
  return null;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}

async function numberedFiles(dir: string): Promise<{ n: number; file: string }[]> {
  return (await listDir(dir))
    .flatMap((name) => {
      const m = /^([1-9]\d*)\.json$/.exec(name);
      return m ? [{ n: Number(m[1]), file: path.join(dir, name) }] : [];
    })
    .sort((a, b) => a.n - b.n);
}

async function claimFile(file: string, content: unknown): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  await writeFile(tmp, JSON.stringify(content, null, 2));
  try {
    await link(tmp, file);
    return true;
  } catch (e) {
    if ((e as { code?: unknown }).code === "EEXIST") return false;
    throw e;
  } finally {
    await unlink(tmp);
  }
}

async function rewrite(file: string, content: unknown): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  await writeFile(tmp, JSON.stringify(content, null, 2));
  await rename(tmp, file);
}

export type OpenSpend = { readonly kind: "opened"; readonly spend: SpendHandle } | { readonly kind: "busy"; readonly active: SpendView };

export async function openSpend(env: Env, mode: SpendMode): Promise<OpenSpend> {
  const owner = await selfToken();
  const dir = path.join(env.home, "spends");
  for (;;) {
    const before = await loadSpends(env, []);
    const live = before.find((s) => s.state.kind === "live");
    if (live) return { kind: "busy", active: live };

    const taken = await numberedFiles(dir);
    const n = (1 + Math.max(0, ...taken.map((f) => f.n))) as SpendNo;
    const record: SpendRecord = { v: 1, spend: n, owner, mode, startedAt: env.now(), end: null };
    const file = path.join(dir, `${n}.json`);
    if (!(await claimFile(file, record))) continue;

    const rival = (await loadSpends(env, [])).find((s) => s.spend < n && s.state.kind === "live");
    if (rival) {
      await rewrite(file, { ...record, end: { endedAt: env.now(), halt: { kind: "busy", holder: rival.spend }, skipped: [] } });
      return { kind: "busy", active: rival };
    }
    return { kind: "opened", spend: spendHandle(env, record, file) };
  }
}

export type ClaimInput = {
  readonly task: Task;
  readonly plan: AttemptPlan;
  readonly worktree: AbsPath;
  readonly branch: BranchName;
  readonly base: CommitSha;
  readonly usageBefore: UsageSnapshot | null;
};

export type SpendHandle = {
  readonly no: SpendNo;
  readonly owner: ProcessToken;
  readonly claim: (input: ClaimInput) => Promise<AttemptHandle | null>;
  readonly close: (end: SpendEnd) => Promise<void>;
};

function spendHandle(env: Env, record: SpendRecord, file: string): SpendHandle {
  let closed = false;
  return {
    no: record.spend,
    owner: record.owner,
    claim: async (input) => {
      const dir = path.join(env.home, "runs", input.task.id);
      const n = (1 + Math.max(0, ...(await numberedFiles(dir)).map((f) => f.n))) as AttemptNo;
      const { task } = input;
      const attempt: AttemptRecord = {
        v: 1,
        task: task.id,
        attempt: n,
        spend: record.spend,
        owner: record.owner,
        plan: input.plan,
        spec: { prompt: task.prompt, tools: task.tools, model: task.model, maxMinutes: task.maxMinutes, check: task.check, repo: { key: task.repo.key, path: task.repo.path } },
        worktree: input.worktree,
        branch: input.branch,
        base: input.base,
        startedAt: env.now(),
        usageBefore: input.usageBefore,
        agent: null,
        session: null,
        exited: null,
        sealed: null,
        end: null,
      };
      const files = runFiles(env, task.id, n);
      if (!(await claimFile(files.record, attempt))) return null;
      await mkdir(path.dirname(files.stream), { recursive: true });
      return attemptHandle(attempt, files);
    },
    close: async (end) => {
      if (closed) return;
      closed = true;
      await rewrite(file, { ...record, end });
    },
  };
}

export type AttemptFact =
  | { readonly kind: "agent"; readonly process: ProcessToken; readonly argv: readonly string[] }
  | { readonly kind: "session"; readonly id: SessionId }
  | { readonly kind: "exited"; readonly exit: AgentExit }
  | { readonly kind: "sealed"; readonly sealed: Sealed };

export type AttemptHandle = {
  readonly ref: { readonly task: TaskId; readonly attempt: AttemptNo; readonly spend: SpendNo };
  readonly startedAt: Date;
  readonly files: RunFiles;
  readonly note: (fact: AttemptFact) => Promise<void>;
  readonly finish: (end: RunEnd) => Promise<AttemptView>;
};

function attemptHandle(initial: AttemptRecord, files: RunFiles): AttemptHandle {
  let current = initial;
  let chain: Promise<void> = Promise.resolve();
  let finished = false;
  const write = (update: (r: AttemptRecord) => AttemptRecord) => {
    chain = chain.then(() => {
      current = update(current);
      return rewrite(files.record, current);
    });
    return chain;
  };
  return {
    ref: { task: initial.task, attempt: initial.attempt, spend: initial.spend },
    startedAt: initial.startedAt,
    files,
    note: (fact) => {
      if (finished) return Promise.reject(new Error("attempt already finished"));
      switch (fact.kind) {
        case "agent":
          return write((r) => ({ ...r, agent: { process: fact.process, argv: fact.argv } }));
        case "session":
          return write((r) => ({ ...r, session: fact.id }));
        case "exited":
          return write((r) => ({ ...r, exited: fact.exit }));
        case "sealed":
          return write((r) => ({ ...r, sealed: fact.sealed }));
      }
    },
    finish: async (end) => {
      if (finished) throw new Error("attempt already finished");
      finished = true;
      await chain.catch(() => {});
      current = { ...current, end };
      await rewrite(files.record, current);
      const { end: _end, ...rest } = current;
      return { ...rest, state: { kind: "ended", end }, files };
    },
  };
}
