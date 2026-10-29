import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Env } from "./config.ts";
import { isSessionId } from "./model.ts";
import type {
  AbsPath,
  AgentExit,
  AttemptPlan,
  Denial,
  Login,
  ProcessToken,
  RefusalReason,
  RunFiles,
  SessionId,
  StopReason,
  SubscriptionProof,
  Task,
  ToolPattern,
  UsageUpdate,
} from "./model.ts";
import { signalGroup, tokenOf } from "./proc.ts";
import { parseUsageText, readRateLimitInfo } from "./usage.ts";
import type { UsageParse } from "./usage.ts";

const PROOF = Object.freeze({}) as SubscriptionProof;

export async function checkLogin(env: Env): Promise<Login> {
  const r = await runFromSytHome(env, ["auth", "status", "--json"]);
  if (r.kind === "failed") return { kind: "unreadable", detail: r.detail };
  const json = parseJson(r.stdout);
  if (json === undefined) return { kind: "unreadable", detail: `claude auth status printed no JSON (exit ${r.code})` };
  if (field(json, "loggedIn") === false) return { kind: "logged-out" };
  const method = field(json, "authMethod");
  if (method === "claude.ai") return { kind: "subscription", plan: stringOrNull(field(json, "subscriptionType")), proof: PROOF };
  if (method === "api_key") return { kind: "api-key", source: stringOrNull(field(json, "apiKeySource")) };
  return { kind: "unreadable", detail: `unknown authMethod ${JSON.stringify(method)}` };
}

export type UsageProbe = UsageParse | { readonly kind: "probe-failed"; readonly detail: string };

export async function probeUsage(env: Env, _proof: SubscriptionProof): Promise<UsageProbe> {
  const r = await runFromSytHome(env, ["-p", "/usage", "--output-format", "json", "--setting-sources", "project,local"]);
  if (r.kind === "failed") return { kind: "probe-failed", detail: r.detail };
  const json = parseJson(r.stdout);
  if (json === undefined) return { kind: "probe-failed", detail: `/usage printed no JSON (exit ${r.code})` };
  const cost = field(json, "total_cost_usd");
  const turns = field(json, "num_turns");
  if ((typeof cost === "number" && cost !== 0) || (typeof turns === "number" && turns !== 0)) {
    return { kind: "probe-failed", detail: `/usage reported a cost ($${String(cost)}, ${String(turns)} turns), so syt stopped polling it` };
  }
  const result = field(json, "result");
  if (field(json, "is_error") === true || typeof result !== "string") {
    return { kind: "probe-failed", detail: `/usage returned an error: ${String(result).slice(0, 200)}` };
  }
  return parseUsageText(result, env.now());
}

type Captured = { readonly kind: "done"; readonly code: number | null; readonly stdout: string } | { readonly kind: "failed"; readonly detail: string };

async function runFromSytHome(env: Env, args: readonly string[]): Promise<Captured> {
  await mkdir(env.home, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(env.claudeBin, args, { cwd: env.home, env: env.vars, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.resume();
    const timer = setTimeout(() => {
      if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
      resolve({ kind: "failed", detail: `claude ${args[0]} timed out after ${env.timing.probeTimeoutMs} ms` });
    }, env.timing.probeTimeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ kind: "failed", detail: `could not run ${env.claudeBin}: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ kind: "done", code, stdout });
    });
  });
}

export type AgentRequest = {
  readonly task: Task;
  readonly plan: Exclude<AttemptPlan, { readonly kind: "finish" }>;
  readonly cwd: AbsPath;
  readonly files: RunFiles;
};

export type AgentHooks = {
  readonly onSession: (id: SessionId) => void;
  readonly onUsage: (update: UsageUpdate) => void;
  readonly stopAt: () => StopReason | null;
};

export type Agent = {
  readonly process: ProcessToken;
  readonly argv: readonly string[];
  readonly requestStop: (reason: StopReason) => void;
  readonly kill: (reason: StopReason) => void;
  readonly exited: Promise<AgentExit>;
};

const STDERR_TAIL = 4096;

export async function startAgent(env: Env, _proof: SubscriptionProof, req: AgentRequest, hooks: AgentHooks): Promise<Agent> {
  const argv = argvFor(req);
  await mkdir(path.dirname(req.files.stream), { recursive: true });
  const streamLog = createWriteStream(req.files.stream, { flags: "a" });
  const stderrLog = createWriteStream(req.files.stderr, { flags: "a" });

  const child = spawn(env.claudeBin, argv, { cwd: req.cwd, env: env.vars, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const pid = child.pid;
  if (pid === undefined) {
    const error = await new Promise<Error>((resolve) => child.once("error", resolve));
    await Promise.all([end(streamLog), end(stderrLog)]);
    throw new Error(`could not run ${env.claudeBin}: ${error.message}`);
  }

  let sawInit = false;
  let refused: RefusalReason | null = null;
  let applied: StopReason | null = null;
  let requested: StopReason | null = null;
  let result: Extract<AgentExit, { kind: "finished" }> | null = null;
  let stderrTail = "";
  const timers: NodeJS.Timeout[] = [];

  const stopNow = (reason: StopReason) => {
    if (applied !== null || refused !== null) return;
    applied = reason;
    signalGroup(pid, "SIGTERM");
    timers.push(setTimeout(() => signalGroup(pid, "SIGKILL"), env.timing.killGraceMs));
  };
  const refuse = (reason: RefusalReason) => {
    if (refused !== null) return;
    refused = reason;
    signalGroup(pid, "SIGKILL");
  };
  timers.push(setTimeout(() => !sawInit && refuse({ kind: "no-init" }), env.timing.initTimeoutMs));

  const onLine = (line: string) => {
    streamLog.write(line + "\n");
    if (refused !== null) return;
    const ev = parseJson(line);
    const type = field(ev, "type");
    if (type === "system" && field(ev, "subtype") === "init") {
      if (sawInit) return;
      sawInit = true;
      const source = field(ev, "apiKeySource");
      const mode = field(ev, "permissionMode");
      const session = field(ev, "session_id");
      if (source !== "none") return refuse({ kind: "api-key", source: String(source) });
      if (mode !== "dontAsk") return refuse({ kind: "permission-mode", mode: String(mode) });
      if (typeof session === "string" && isSessionId(session)) hooks.onSession(session);
      return;
    }
    if (!sawInit && (type === "assistant" || type === "user" || type === "rate_limit_event")) return refuse({ kind: "no-init" });
    if (type === "rate_limit_event") {
      const update = readRateLimitInfo(field(ev, "rate_limit_info"), env.now());
      if (update !== null) hooks.onUsage(update);
    } else if (type === "user" && isTurnBoundary(ev)) {
      const reason = requested ?? hooks.stopAt();
      if (reason !== null) stopNow(reason);
    } else if (type === "result") {
      result = {
        kind: "finished",
        isError: field(ev, "is_error") === true,
        numTurns: typeof field(ev, "num_turns") === "number" ? (field(ev, "num_turns") as number) : 0,
        denials: denialsOf(field(ev, "permission_denials")),
        summary: String(field(ev, "result") ?? "").slice(0, 2000),
      };
    }
  };

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("line", onLine);
  const linesDone = new Promise<void>((resolve) => lines.once("close", resolve));
  child.stderr.on("data", (d: Buffer) => {
    stderrLog.write(d);
    stderrTail = (stderrTail + d.toString()).slice(-STDERR_TAIL);
  });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));

  const exited = (async (): Promise<AgentExit> => {
    const [{ code, signal }] = await Promise.all([closed, linesDone]);
    for (const t of timers) clearTimeout(t);
    await Promise.all([end(streamLog), end(stderrLog)]);
    return classifyExit({
      refused,
      result: result as Extract<AgentExit, { kind: "finished" }> | null,
      stoppedBySyt: applied,
      crash: { kind: "crashed", code, signal, stderrTail: stderrTail.trim() },
    });
  })();

  const token = (await tokenOf(pid)) ?? { pid, lstart: "" };
  return {
    process: token,
    argv,
    requestStop: (reason) => {
      if (requested !== null || applied !== null) return;
      requested = reason;
      timers.push(setTimeout(() => stopNow(reason), env.timing.stopGraceMs));
    },
    kill: (reason) => {
      applied ??= reason;
      signalGroup(pid, "SIGKILL");
    },
    exited,
  };
}

function isTurnBoundary(ev: unknown): boolean {
  const content = field(field(ev, "message"), "content");
  return Array.isArray(content) && content.some((c) => field(c, "type") === "tool_result");
}

function denialsOf(raw: unknown): Denial[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((d) => ({ tool: String(field(d, "tool_name") ?? "?"), input: JSON.stringify(field(d, "tool_input") ?? null).slice(0, 500) }));
}

const DEFAULT_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write"] as const;
const ALWAYS_DENIED = ["Bash(git push*)", "Bash(gh *)"] as const;

export function allowlistFor(task: Task): readonly ToolPattern[] {
  const { test, lint, build } = task.repo.commands;
  const commands = [test, lint, build].filter((c) => c !== null).flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]);
  return [...new Set([...DEFAULT_TOOLS, ...commands, ...task.tools])] as ToolPattern[];
}

function argvFor(req: AgentRequest): readonly string[] {
  const session = req.plan.kind === "continue" ? req.plan.session : null;
  return [
    "-p",
    req.plan.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--setting-sources",
    "project,local",
    ...(session !== null ? ["--resume", session] : []),
    ...(req.task.model !== null ? ["--model", req.task.model] : []),
    "--allowedTools",
    ...allowlistFor(req.task),
    "--disallowedTools",
    ...ALWAYS_DENIED,
  ];
}

function end(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function classifyExit(seen: {
  readonly refused: RefusalReason | null;
  readonly result: Extract<AgentExit, { kind: "finished" }> | null;
  readonly stoppedBySyt: StopReason | null;
  readonly crash: Extract<AgentExit, { kind: "crashed" }>;
}): AgentExit {
  if (seen.refused !== null) return { kind: "refused", reason: seen.refused };
  const cleanFinishWinsOverOurStop = seen.result !== null && !seen.result.isError;
  if (cleanFinishWinsOverOurStop) return seen.result;
  if (seen.stoppedBySyt !== null) return { kind: "stopped", reason: seen.stoppedBySyt };
  return seen.result ?? seen.crash;
}
