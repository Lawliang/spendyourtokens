import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { checkLogin, probeUsage, startAgent } from "../src/claude.ts";
import type { AgentHooks, AgentRequest } from "../src/claude.ts";
import type {
  AbsPath,
  AttemptNo,
  CommitSha,
  Login,
  RepoKey,
  SessionId,
  ShellCommand,
  StopReason,
  SubscriptionProof,
  Task,
  TaskId,
  ToolPattern,
  UsageUpdate,
} from "../src/model.ts";
import { isAlive } from "../src/proc.ts";
import { runFiles } from "../src/runs.ts";
import type { FakeRun } from "./fake-claude.ts";
import { FIXTURES, fakeEnv, fakeScenario, plainEnv, tempDir } from "./helpers.ts";

const SESSION = "cf9ac047-8f1e-4ea2-8bbf-3b6cc8a19723";

async function subscribed(env: Parameters<typeof checkLogin>[0]): Promise<SubscriptionProof> {
  const login = await checkLogin(env);
  assert.equal(login.kind, "subscription");
  if (login.kind !== "subscription") throw new Error("unreachable");
  return login.proof;
}

describe("checkLogin", () => {
  it("reads the real subscription and API-key auth outputs", async () => {
    const home = await tempDir();
    const sub = await checkLogin(fakeEnv(home, await fakeScenario(path.join(home, "a"), { auth: "auth/subscription.json" })));
    assert.equal(sub.kind === "subscription" && sub.plan, "max");
    const key = await checkLogin(fakeEnv(home, await fakeScenario(path.join(home, "b"), { auth: "auth/api-key.json" })));
    assert.deepEqual(key, { kind: "api-key", source: "ANTHROPIC_API_KEY" } satisfies Login);
  });

  it("calls a missing claude binary unreadable", async () => {
    assert.equal((await checkLogin(plainEnv(await tempDir()))).kind, "unreadable");
  });
});

describe("probeUsage", () => {
  async function probe(usage: Parameters<typeof fakeScenario>[1]["usage"]) {
    const home = await tempDir();
    const fake = await fakeScenario(path.join(home, "fake"), { usage: usage ?? [] });
    const env = fakeEnv(home, fake);
    return { result: await probeUsage(env, await subscribed(env)), fake, home };
  }

  it("parses the real report from the zero-cost envelope, run from the syt home", async () => {
    const { result, fake, home } = await probe(["usage/subscription-max.txt"]);
    assert.equal(result.kind, "ok");
    const call = (await fake.invocations()).find((i) => i.argv[0] === "-p");
    assert.deepEqual(call, { argv: ["-p", "/usage", "--output-format", "json", "--setting-sources", "project,local"], cwd: home });
  });

  it("passes through a not-subscription report and fails on garbage", async () => {
    assert.equal((await probe(["usage/api-key.txt"])).result.kind, "not-subscription");
    assert.equal((await probe(["unreadable"])).result.kind, "probe-failed");
  });

  it("refuses an envelope that reports a cost or turns", async () => {
    assert.equal((await probe([{ fixture: "usage/subscription-max.txt", costUsd: 0.01 }])).result.kind, "probe-failed");
    assert.equal((await probe([{ fixture: "usage/subscription-max.txt", numTurns: 1 }])).result.kind, "probe-failed");
  });
});

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t" as TaskId,
    repo: { key: "app" as RepoKey, path: "/code/app" as AbsPath, commands: { test: "npm test" as ShellCommand, lint: null, build: null } },
    prompt: "List the files, run npm test, and curl example.com",
    priority: "normal",
    tools: ["WebSearch" as ToolPattern],
    model: null,
    maxMinutes: 60,
    check: "npm test" as ShellCommand,
    source: { kind: "queue-file", index: 0 },
    ...overrides,
  };
}

type Recorded = { sessions: SessionId[]; usage: UsageUpdate[]; boundaries: number };

async function agentRun(run: FakeRun, opts: { stopAt?: (n: number) => StopReason | null; request?: Partial<AgentRequest>; timing?: Parameters<typeof fakeEnv>[2] } = {}) {
  const home = await tempDir();
  const fake = await fakeScenario(path.join(home, "fake"), { runs: [run] });
  const env = fakeEnv(home, fake, opts.timing);
  const files = runFiles(env, "t" as TaskId, 1 as AttemptNo);
  const recorded: Recorded = { sessions: [], usage: [], boundaries: 0 };
  const hooks: AgentHooks = {
    onSession: (id) => recorded.sessions.push(id),
    onUsage: (u) => recorded.usage.push(u),
    stopAt: () => {
      recorded.boundaries++;
      return opts.stopAt?.(recorded.boundaries) ?? null;
    },
  };
  const req: AgentRequest = { task: task(), plan: { kind: "fresh", prompt: task().prompt }, cwd: home, files, ...opts.request };
  const agent = await startAgent(env, await subscribed(env), req, hooks);
  return { agent, recorded, files, fake, home };
}

describe("startAgent", () => {
  it("replays a real run to a finish, logging every line and surfacing session, usage and denials", async () => {
    const { agent, recorded, files, fake, home } = await agentRun({ stream: "stream/task-allowlist.jsonl" });
    const exit = await agent.exited;
    assert.equal(exit.kind, "finished");
    if (exit.kind !== "finished") return;
    assert.equal(exit.isError, false);
    assert.equal(exit.numTurns, 4);
    assert.deepEqual(exit.denials.map((d) => d.tool), ["Bash"]);
    assert.match(exit.denials[0]?.input ?? "", /curl/);
    assert.deepEqual(recorded.sessions, [SESSION]);
    assert.deepEqual(recorded.usage.map((u) => [u.session?.usedPct, u.week?.usedPct]), [[6, 22]]);
    assert.equal(recorded.boundaries, 3, "each tool_result is a turn boundary");
    assert.equal(await readFile(files.stream, "utf8"), await readFile(path.join(FIXTURES, "stream/task-allowlist.jsonl"), "utf8"));

    const call = (await fake.invocations()).find((i) => i.argv.includes("stream-json"));
    assert.equal(call?.cwd, home);
    assert.deepEqual(call?.argv.slice(0, 2), ["-p", task().prompt], "the prompt is positional, right after -p");
    const argv = call?.argv ?? [];
    for (const forbidden of ["--bare", "--dangerously-skip-permissions"]) assert.ok(!argv.includes(forbidden), forbidden);
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    assert.equal(flag("--permission-mode"), "dontAsk");
    assert.equal(flag("--permission-prompts"), "none");
    assert.equal(flag("--setting-sources"), "project,local");
    const allowed = argv.slice(argv.indexOf("--allowedTools") + 1, argv.indexOf("--disallowedTools"));
    assert.deepEqual(allowed, ["Read", "Glob", "Grep", "Edit", "Write", "Bash(npm test)", "Bash(npm test *)", "WebSearch"]);
    assert.deepEqual(argv.slice(argv.indexOf("--disallowedTools") + 1), ["Bash(git push*)", "Bash(gh *)"]);
  });

  it("resumes a session and passes the task's model", async () => {
    const { agent, fake } = await agentRun(
      { stream: "stream/task-resume.jsonl" },
      {
        request: {
          task: task({ model: "claude-sonnet-5" }),
          plan: { kind: "continue", why: "partial", from: 1 as AttemptNo, session: SESSION as SessionId, worktree: "/x" as AbsPath, base: "a".repeat(40) as CommitSha, prompt: "Continue the task." },
        },
      },
    );
    assert.equal((await agent.exited).kind, "finished");
    const argv = (await fake.invocations()).find((i) => i.argv.includes("stream-json"))?.argv ?? [];
    assert.equal(argv[argv.indexOf("--resume") + 1], SESSION);
    assert.equal(argv[argv.indexOf("--model") + 1], "claude-sonnet-5");
  });

  it("ignores hook events before init", async () => {
    const { agent, recorded } = await agentRun({ stream: "stream/task-with-user-hooks.jsonl" });
    assert.equal((await agent.exited).kind, "finished");
    assert.deepEqual(recorded.sessions, ["f62a9daf-69c5-4852-a282-f65355dda5f8"]);
  });

  it("kills the agent at init when it reports an API key, before any turn", async () => {
    const { agent, recorded } = await agentRun({ stream: "stream/task-allowlist.jsonl", apiKeySource: "ANTHROPIC_API_KEY", hangAfterLine: 1 });
    assert.deepEqual(await agent.exited, { kind: "refused", reason: { kind: "api-key", source: "ANTHROPIC_API_KEY" } });
    assert.deepEqual(recorded.sessions, []);
    assert.equal(await isAlive(agent.process), false);
  });

  it("kills the agent at init when the permission mode isn't dontAsk", async () => {
    const { agent } = await agentRun({ stream: "stream/task-allowlist.jsonl", permissionMode: "bypassPermissions", hangAfterLine: 1 });
    assert.deepEqual(await agent.exited, { kind: "refused", reason: { kind: "permission-mode", mode: "bypassPermissions" } });
  });

  it("refuses an agent whose init never comes", async () => {
    const { agent } = await agentRun({ stream: "stream/task-allowlist.jsonl", hangAfterLine: 0 }, { timing: { timing: { initTimeoutMs: 300 } } });
    assert.deepEqual(await agent.exited, { kind: "refused", reason: { kind: "no-init" } });
  });

  it("stops at the turn boundary where policy says so", async () => {
    const { agent, recorded } = await agentRun(
      { stream: "stream/task-allowlist.jsonl", lineDelayMs: 100 },
      { stopAt: (n) => (n === 1 ? { kind: "time-cap", maxMinutes: 60 } : null) },
    );
    assert.deepEqual(await agent.exited, { kind: "stopped", reason: { kind: "time-cap", maxMinutes: 60 } });
    assert.equal(recorded.boundaries, 1);
  });

  it("applies a requested stop at the next boundary, or after the grace when none comes", async () => {
    const atBoundary = await agentRun({ stream: "stream/task-allowlist.jsonl", lineDelayMs: 100 });
    atBoundary.agent.requestStop({ kind: "user-stop" });
    assert.deepEqual(await atBoundary.agent.exited, { kind: "stopped", reason: { kind: "user-stop" } });

    const stuck = await agentRun({ stream: "stream/task-allowlist.jsonl", hangAfterLine: 2 }, { timing: { timing: { stopGraceMs: 300 } } });
    const started = Date.now();
    stuck.agent.requestStop({ kind: "user-stop" });
    assert.deepEqual(await stuck.agent.exited, { kind: "stopped", reason: { kind: "user-stop" } });
    assert.ok(Date.now() - started >= 300, "it waited for a boundary first");
  });

  it("counts a stop that races a clean result as a finish", async () => {
    const { agent } = await agentRun({ stream: "stream/task-resume.jsonl", hangAfterLine: 4 }, { timing: { timing: { stopGraceMs: 200 } } });
    await new Promise((r) => setTimeout(r, 300));
    agent.requestStop({ kind: "user-stop" });
    assert.equal((await agent.exited).kind, "finished");
  });

  it("reports a run that dies without a result as crashed, with its stderr", async () => {
    const { agent } = await agentRun({ stream: "stream/task-allowlist.jsonl", exitAfterLine: 3, exitCode: 7 });
    const exit = await agent.exited;
    assert.equal(exit.kind, "crashed");
    if (exit.kind !== "crashed") return;
    assert.equal(exit.code, 7);
    assert.match(exit.stderrTail, /exiting 7/);
  });
});
