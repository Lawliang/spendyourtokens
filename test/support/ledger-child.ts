import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_TIMING } from "../../src/config.ts";
import type { Env } from "../../src/config.ts";
import type { AbsPath, CommitSha, RepoKey, ShellCommand, Task, TaskId, BranchName } from "../../src/model.ts";
import { tokenOf } from "../../src/proc.ts";
import { openSpend } from "../../src/runs.ts";

const [home, action, arg] = process.argv.slice(2) as [string, string, string];
const env: Env = { home: home as AbsPath, claudeBin: "claude", now: () => new Date(), timing: DEFAULT_TIMING, vars: {} };

const opened = await openSpend(env, { kind: "manual", only: null });
if (opened.kind === "busy") {
  console.log(JSON.stringify({ kind: "busy", holder: opened.active.spend }));
  process.exit(0);
}
const spend = opened.spend;

if (action === "open") {
  console.log(JSON.stringify({ kind: "opened", spend: spend.no }));
  const hold = Number(arg);
  if (hold < 0) process.exit(0);
  await sleep(hold);
  await spend.close({ endedAt: new Date(), halt: { kind: "queue-drained" }, skipped: [] });
} else if (action === "orphan") {
  const task: Task = {
    id: arg as TaskId,
    repo: { key: "app" as RepoKey, path: "/tmp" as AbsPath, commands: { test: null, lint: null, build: null } },
    prompt: "p",
    priority: "normal",
    tools: [],
    model: null,
    maxMinutes: 60,
    check: "true" as ShellCommand,
    source: { kind: "queue-file", index: 0 },
  };
  const attempt = await spend.claim({
    task,
    plan: { kind: "fresh", prompt: "p" },
    worktree: "/tmp/wt" as AbsPath,
    branch: `syt/${arg}` as BranchName,
    base: "a".repeat(40) as CommitSha,
    usageBefore: null,
  });
  const agent = spawn("sh", ["-c", "sleep 60 & wait"], { detached: true, stdio: "ignore" });
  agent.unref();
  const token = await tokenOf(agent.pid ?? 0);
  if (attempt === null || token === null) throw new Error("setup failed");
  await attempt.note({ kind: "agent", process: token, argv: ["claude"] });
  console.log(JSON.stringify({ kind: "orphaned", agent: token }));
  process.exit(0);
}
