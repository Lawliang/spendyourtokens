#!/usr/bin/env node
/**
 * A fake `claude` for tests. SYT_CLAUDE_BIN points here. It replays the recorded fixtures under
 * test/fixtures, so tests run the real runner, real git, the real ledger and real child processes,
 * and only the model is fake.
 *
 * FAKE_CLAUDE_SCENARIO names a JSON Scenario. Each invocation claims the next step with an
 * O_EXCL file next to the log, so concurrent invocations each get their own step. Every invocation
 * appends {argv, cwd} as one JSON line to `log`.
 *
 *   auth status --json                 print the `auth` fixture
 *   -p /usage --output-format json     the next `usage` step in a result envelope (the last one repeats)
 *   -p <prompt> ... stream-json        the next `runs` step: write `writeFiles` into the cwd, then
 *                                      replay the stream line by line and exit
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export type FakeRun = {
  /** A fixture under test/fixtures, such as "stream/task-allowlist.jsonl". */
  readonly stream: string;
  readonly writeFiles?: Readonly<Record<string, string>>;
  readonly lineDelayMs?: number;
  /** Replay this many lines, then hang until killed. */
  readonly hangAfterLine?: number;
  /** Replay this many lines, then exit. */
  readonly exitAfterLine?: number;
  readonly exitCode?: number;
  /** Rewrite rate_limit_event utilizations (fractions), to push a window across its reserve. */
  readonly utilization?: { readonly session?: number; readonly week?: number };
  readonly apiKeySource?: string;
  readonly permissionMode?: string;
  /** Rewrite every session_id, so resumes can be told apart from fresh sessions. */
  readonly sessionId?: string;
};

export type UsageStep = "unreadable" | { readonly fixture: string; readonly costUsd?: number; readonly numTurns?: number } | string;

export type Scenario = {
  readonly fixtures: string;
  readonly auth: string;
  readonly usage: readonly UsageStep[];
  readonly runs: readonly FakeRun[];
  readonly log: string;
};

export type Invocation = { readonly argv: readonly string[]; readonly cwd: string };

function claim(log: string, kind: string): number {
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(`${log}.${kind}-${i}`, "wx"));
      return i;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
    }
  }
}

async function write(line: string): Promise<void> {
  await new Promise<void>((resolve) => process.stdout.write(line + "\n", () => resolve()));
}

function rewrite(line: string, run: FakeRun): string {
  if (!run.apiKeySource && !run.permissionMode && !run.sessionId && !run.utilization) return line;
  const ev = JSON.parse(line) as Record<string, unknown>;
  if (ev.type === "system" && ev.subtype === "init") {
    if (run.apiKeySource) ev.apiKeySource = run.apiKeySource;
    if (run.permissionMode) ev.permissionMode = run.permissionMode;
  }
  if (run.sessionId && typeof ev.session_id === "string") ev.session_id = run.sessionId;
  if (ev.type === "rate_limit_event" && run.utilization) {
    const windows = (ev.rate_limit_info as { unifiedWindows: Record<string, { utilization: number }> }).unifiedWindows;
    if (run.utilization.session !== undefined && windows.five_hour) windows.five_hour.utilization = run.utilization.session;
    if (run.utilization.week !== undefined && windows.seven_day) windows.seven_day.utilization = run.utilization.week;
  }
  return JSON.stringify(ev);
}

async function main(argv: readonly string[]): Promise<number> {
  const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;
  if (!scenarioPath) {
    process.stderr.write("fake-claude: FAKE_CLAUDE_SCENARIO is not set\n");
    return 2;
  }
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
  appendFileSync(scenario.log, JSON.stringify({ argv, cwd: process.cwd() } satisfies Invocation) + "\n");
  const fixture = (name: string) => readFileSync(path.join(scenario.fixtures, name), "utf8");

  if (argv[0] === "auth" && argv[1] === "status") {
    await write(fixture(scenario.auth).trimEnd());
    return 0;
  }

  const p = argv.indexOf("-p");
  const prompt = p >= 0 ? argv[p + 1] : undefined;

  if (prompt === "/usage" && !argv.includes("stream-json")) {
    const steps = scenario.usage;
    const step = steps[Math.min(claim(scenario.log, "usage"), steps.length - 1)];
    if (step === undefined || step === "unreadable") {
      await write("this is not the JSON envelope");
      return 1;
    }
    const spec = typeof step === "string" ? { fixture: step } : step;
    await write(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: spec.numTurns ?? 0,
        total_cost_usd: spec.costUsd ?? 0,
        result: fixture(spec.fixture),
      }),
    );
    return 0;
  }

  if (prompt !== undefined && argv.includes("stream-json")) {
    const run = scenario.runs[claim(scenario.log, "run")];
    if (run === undefined) {
      process.stderr.write("fake-claude: the scenario has no run step left\n");
      return 3;
    }
    for (const [rel, content] of Object.entries(run.writeFiles ?? {})) {
      mkdirSync(path.dirname(path.join(process.cwd(), rel)), { recursive: true });
      writeFileSync(path.join(process.cwd(), rel), content);
    }
    const lines = fixture(run.stream).split("\n").filter((l) => l.trim() !== "");
    for (const [i, line] of lines.entries()) {
      if (run.hangAfterLine !== undefined && i >= run.hangAfterLine) {
        setInterval(() => {}, 1 << 30);
        await new Promise(() => {});
      }
      if (run.exitAfterLine !== undefined && i >= run.exitAfterLine) break;
      await write(rewrite(line, run));
      if (run.lineDelayMs) await sleep(run.lineDelayMs);
    }
    if (run.hangAfterLine !== undefined) {
      setInterval(() => {}, 1 << 30);
      await new Promise(() => {});
    }
    process.stderr.write(run.exitCode ? `fake-claude: exiting ${run.exitCode}\n` : "");
    return run.exitCode ?? 0;
  }

  process.stderr.write(`fake-claude: unsupported argv ${JSON.stringify(argv)}\n`);
  return 2;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
