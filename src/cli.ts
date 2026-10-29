#!/usr/bin/env node
/**
 * `syt` entry point. Thin: it parses argv, loads config, makes one or two deep calls, prints what
 * report.ts renders, and picks the exit code. No policy here.
 */

import { parseArgs } from "node:util";
import { checkLogin, probeUsage } from "./claude.ts";
import { envFromProcess, loadConfig, toAbsPath } from "./config.ts";
import type { Env } from "./config.ts";
import { isTaskId } from "./model.ts";
import type { AbsPath, Config } from "./model.ts";
import { admission, planQueue } from "./policy.ts";
import { addTask, loadQueue } from "./queue.ts";
import { parseSince, renderQueue, renderReport, renderSpendEvent, renderSpendSummary, renderStatus, reportRows } from "./report.ts";
import type { StatusInput } from "./report.ts";
import { spend } from "./runner.ts";
import type { Brakes, SpendSummary } from "./runner.ts";
import { loadLedger } from "./runs.ts";
import { repoRoot } from "./worktree.ts";

export const EXIT = { ok: 0, refused: 1, badInput: 2, busy: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type Io = {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly cwd: string;
  /** Called only by `syt run`, so other commands keep the default Ctrl-C. */
  readonly brakes: () => Brakes;
};

const USAGE = `syt: spends what's left of your Claude plan on work you queued

  syt add "<prompt>" [--repo <path>] [--priority high|normal|low] [--tools <rule>]...
                     [--model <name>] [--max-minutes <n>] [--done-when <command>]
  syt queue                      tasks in run order, with status
  syt status                     login, both usage windows, and what would run next
  syt run --now [--task <id>]    spend now, down to your reserves
  syt report [--since 7d]        one row per attempt, failures first

Exit codes: 0 ok, 1 refused, 2 bad input, 3 another spend is active.`;

export async function main(argv: readonly string[], env: Env, io: Io): Promise<ExitCode> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "add":
        return await add(rest, env, io);
      case "queue":
        return await queue(rest, env, io);
      case "status":
        return await status(rest, env, io);
      case "run":
        return await run(rest, env, io);
      case "report":
        return await report(rest, env, io);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return EXIT.ok;
      default:
        io.err(`unknown command "${command}"\n\n${USAGE}`);
        return EXIT.badInput;
    }
  } catch (e) {
    if (isArgError(e)) {
      io.err(`${(e as Error).message}\n\n${USAGE}`);
      return EXIT.badInput;
    }
    throw e;
  }
}

function isArgError(e: unknown): boolean {
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}

async function configOrFail(env: Env, io: Io): Promise<Config | null> {
  const loaded = await loadConfig(env);
  if (loaded.kind === "ok") return loaded.config;
  io.err(`${loaded.file} has problems:\n${loaded.problems.map((p) => `  ${p}`).join("\n")}`);
  return null;
}

async function add(args: readonly string[], env: Env, io: Io): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      priority: { type: "string" },
      tools: { type: "string", multiple: true },
      model: { type: "string" },
      "max-minutes": { type: "string" },
      "done-when": { type: "string" },
    },
  });
  if (positionals.length !== 1 || positionals[0] === undefined) {
    io.err('syt add takes one prompt. Quote it: syt add "Write tests for src/parser"');
    return EXIT.badInput;
  }
  const repo = values.repo !== undefined ? toAbsPath(values.repo, io.cwd as AbsPath) : await repoRoot(io.cwd);
  if (repo === null) {
    io.err(`${io.cwd} is not inside a git repo. Pass --repo <path>.`);
    return EXIT.badInput;
  }
  const config = await configOrFail(env, io);
  if (config === null) return EXIT.badInput;

  const result = await addTask(env, config, {
    prompt: positionals[0],
    repo,
    ...(values.priority !== undefined && { priority: values.priority }),
    ...(values.tools !== undefined && { tools: values.tools }),
    ...(values.model !== undefined && { model: values.model }),
    ...(values["max-minutes"] !== undefined && { maxMinutes: Number(values["max-minutes"]) }),
    ...(values["done-when"] !== undefined && { doneWhen: values["done-when"] }),
  });
  if (result.kind === "invalid") {
    io.err(`not added:\n${result.problems.map((p) => `  ${p.message}`).join("\n")}`);
    return EXIT.badInput;
  }
  const source = values["done-when"] !== undefined ? "done_when" : "repo default";
  io.out(`added ${result.task.id}\n  ${result.file}\n  check: ${result.task.check} (${source})`);
  return EXIT.ok;
}

async function queue(args: readonly string[], env: Env, io: Io): Promise<ExitCode> {
  parseArgs({ args: [...args], options: {} });
  const config = await configOrFail(env, io);
  if (config === null) return EXIT.badInput;
  const [q, ledger] = await Promise.all([loadQueue(env, config), loadLedger(env)]);
  io.out(renderQueue(planQueue(q.tasks, ledger), [...q.problems, ...ledger.problems.map((p) => ({ where: "ledger", message: p }))]));
  return EXIT.ok;
}

async function status(args: readonly string[], env: Env, io: Io): Promise<ExitCode> {
  parseArgs({ args: [...args], options: {} });
  const config = await configOrFail(env, io);
  if (config === null) return EXIT.badInput;
  const login = await checkLogin(env);
  let usage: StatusInput["usage"] = null;
  if (login.kind === "subscription") {
    const probe = await probeUsage(env, login.proof);
    usage =
      probe.kind === "ok"
        ? {
            kind: "ok",
            view: probe.snapshot,
            admission: admission({ view: probe.snapshot, now: env.now(), limits: config.limits, mode: { kind: "manual", only: null }, maxReadingAgeMs: env.timing.maxReadingAgeMs }),
          }
        : { kind: "unreadable", detail: probe.kind === "probe-failed" ? probe.detail : probe.kind === "not-subscription" ? "the API-key cost summary" : probe.reason };
  }
  const [q, ledger] = await Promise.all([loadQueue(env, config), loadLedger(env)]);
  const plan = planQueue(q.tasks, ledger);
  io.out(
    renderStatus({
      login,
      usage,
      limits: config.limits,
      lastSpend: ledger.spends.at(-1) ?? null,
      live: [...ledger.attempts.values()].flat().filter((a) => a.state.kind === "live"),
      next: plan.find((e) => e.status.kind === "ready") ?? null,
      now: env.now(),
    }),
  );
  return EXIT.ok;
}

async function run(args: readonly string[], env: Env, io: Io): Promise<ExitCode> {
  const { values } = parseArgs({ args: [...args], options: { now: { type: "boolean" }, task: { type: "string" } } });
  if (!values.now) {
    io.err("scheduled spending arrives in M2; use: syt run --now");
    return EXIT.badInput;
  }
  if (values.task !== undefined && !isTaskId(values.task)) {
    io.err(`"${values.task}" is not a task id`);
    return EXIT.badInput;
  }
  const config = await configOrFail(env, io);
  if (config === null) return EXIT.badInput;
  const summary = await spend(env, {
    mode: { kind: "manual", only: values.task ?? null },
    config,
    brakes: io.brakes(),
    observe: (e) => io.out(renderSpendEvent(e, env.now())),
  });
  (summary.kind === "ran" ? io.out : io.err)(renderSpendSummary(summary));
  return exitCodeFor(summary);
}

async function report(args: readonly string[], env: Env, io: Io): Promise<ExitCode> {
  const { values } = parseArgs({ args: [...args], options: { since: { type: "string" } } });
  const since = parseSince(values.since ?? "7d", env.now());
  if (since === null) {
    io.err(`--since takes 7d, 24h, 90m or a date such as 2026-10-01, not "${values.since}"`);
    return EXIT.badInput;
  }
  const ledger = await loadLedger(env);
  io.out(renderReport(reportRows(ledger, since), ledger.problems, since));
  return EXIT.ok;
}

/** The first SIGINT/SIGTERM/SIGHUP stops agents at their next turn; the second kills them. */
export function brakesFromSignals(proc: NodeJS.Process): Brakes {
  const stop = new AbortController();
  const kill = new AbortController();
  const onSignal = () => (stop.signal.aborted ? kill.abort() : stop.abort());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) proc.on(signal, onSignal);
  return { stop: stop.signal, kill: kill.signal };
}

/** busy 3, refused 1, ran 0, including runs that halted on a reserve, which is the normal ending. */
export function exitCodeFor(summary: SpendSummary): ExitCode {
  switch (summary.kind) {
    case "busy":
      return EXIT.busy;
    case "refused":
      return EXIT.refused;
    case "ran":
      return EXIT.ok;
  }
}

if (import.meta.main) {
  let env: Env;
  try {
    env = envFromProcess(process.env);
  } catch (e) {
    process.stderr.write(`syt: ${(e as Error).message}\n`);
    process.exit(EXIT.badInput);
  }
  process.exitCode = await main(process.argv.slice(2), env, {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    cwd: process.cwd(),
    brakes: () => brakesFromSignals(process),
  });
}
