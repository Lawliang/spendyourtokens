import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_LIMITS } from "../src/config.ts";
import type { AbsPath, BranchName, CommitSha, ProcessToken, RepoKey, SessionId, ShellCommand, Task, TaskId } from "../src/model.ts";
import { isAlive, stopGroup } from "../src/proc.ts";
import { loadLedger, openSpend } from "../src/runs.ts";
import { plainEnv, tempDir } from "./helpers.ts";

const CHILD = fileURLToPath(new URL("./support/ledger-child.ts", import.meta.url));
const run = promisify(execFile);
const child = async (home: string, ...args: string[]) => JSON.parse((await run(process.execPath, [CHILD, home, ...args])).stdout);
const manual = { kind: "manual", only: null } as const;
const drained = (env: { now: () => Date }) => ({ endedAt: env.now(), halt: { kind: "queue-drained" } as const, skipped: [] });

function task(id: string): Task {
  return {
    id: id as TaskId,
    repo: { key: "app" as RepoKey, path: "/code/app" as AbsPath, commands: { test: null, lint: null, build: null } },
    prompt: "p",
    priority: "normal",
    tools: [],
    model: null,
    maxMinutes: DEFAULT_LIMITS.defaultMaxMinutes,
    check: "true" as ShellCommand,
    source: { kind: "queue-file", index: 0 },
  };
}

describe("the spend lock", () => {
  it("admits one live spend at a time and numbers them in order", async () => {
    const env = plainEnv(await tempDir());
    const first = await openSpend(env, manual);
    assert.equal(first.kind === "opened" && first.spend.no, 1);
    const second = await openSpend(env, manual);
    assert.equal(second.kind === "busy" && second.active.spend, 1, "a second spend is refused while the first lives");
    if (first.kind !== "opened") return;
    await first.spend.close(drained(env));
    await first.spend.close(drained(env));
    const third = await openSpend(env, manual);
    assert.equal(third.kind === "opened" && third.spend.no, 2);
  });

  it("treats a spend whose process died as history, not a lock", async () => {
    const home = await tempDir();
    assert.deepEqual(await child(home, "open", "-1"), { kind: "opened", spend: 1 });
    const env = plainEnv(home);
    const ledger = await loadLedger(env);
    assert.equal(ledger.spends[0]?.state.kind, "interrupted");
    const next = await openSpend(env, manual);
    assert.equal(next.kind === "opened" && next.spend.no, 2);
  });

  it("lets exactly one of several racing processes open a spend", async () => {
    const home = await tempDir();
    const results = await Promise.all([1, 2, 3, 4].map(() => child(home, "open", "1500")));
    assert.equal(results.filter((r) => r.kind === "opened").length, 1, JSON.stringify(results));
    const ledger = await loadLedger(plainEnv(home));
    const backedOff = ledger.spends.filter((s) => s.state.kind === "ended" && s.state.end.halt.kind === "busy");
    assert.equal(ledger.spends.length - backedOff.length, 1, "every other claimed spend ended itself as busy");
  });
});

describe("attempt records", () => {
  it("keeps every fact noted at once, and ends when finished", async () => {
    const env = plainEnv(await tempDir());
    const opened = await openSpend(env, manual);
    assert.equal(opened.kind, "opened");
    if (opened.kind !== "opened") return;
    const handle = await opened.spend.claim({
      task: task("t"),
      plan: { kind: "fresh", prompt: "p" },
      worktree: "/wt" as AbsPath,
      branch: "syt/t" as BranchName,
      base: "b".repeat(40) as CommitSha,
      usageBefore: null,
    });
    assert.ok(handle);
    const agent: ProcessToken = { pid: 4242, lstart: "Wed Oct 28 19:05:01 2026" };
    const session = "cf9ac047-8f1e-4ea2-8bbf-3b6cc8a19723" as SessionId;
    const exit = { kind: "finished", isError: false, numTurns: 2, denials: [], summary: "ok" } as const;
    const sealed = { commit: null, diff: { files: 0, insertions: 0, deletions: 0 } };
    await Promise.all([
      handle.note({ kind: "agent", process: agent, argv: ["claude", "-p"] }),
      handle.note({ kind: "session", id: session }),
      handle.note({ kind: "exited", exit }),
      handle.note({ kind: "sealed", sealed }),
    ]);

    const live = (await loadLedger(env)).attempts.get("t" as TaskId)?.[0];
    assert.equal(live?.state.kind, "live");
    assert.deepEqual([live?.agent?.process, live?.session, live?.exited, live?.sealed], [agent, session, exit, sealed]);
    assert.equal(live?.startedAt instanceof Date, true, "dates come back as Dates");

    const view = await handle.finish({ endedAt: env.now(), result: { kind: "no-op" }, usageAfter: null, diff: sealed.diff, commit: null, denials: [] });
    assert.equal(view.state.kind, "ended");
    const reread = (await loadLedger(env)).attempts.get("t" as TaskId)?.[0];
    assert.equal(reread?.state.kind === "ended" && reread.state.end.result.kind, "no-op");
    assert.equal(reread?.files.stream, path.join(env.home, "logs/t/1.jsonl"));
  });

  it("reads an attempt whose owner died as interrupted, naming its still-running agent", async () => {
    const home = await tempDir();
    const { agent } = await child(home, "orphan", "lost");
    try {
      const attempt = (await loadLedger(plainEnv(home))).attempts.get("lost" as TaskId)?.[0];
      assert.deepEqual(attempt?.state, { kind: "interrupted", orphan: agent });
      await stopGroup(agent, 2_000);
      assert.equal(await isAlive(agent), false);
      const after = (await loadLedger(plainEnv(home))).attempts.get("lost" as TaskId)?.[0];
      assert.deepEqual(after?.state, { kind: "interrupted", orphan: null });
    } finally {
      await stopGroup(agent, 0);
    }
  });

  it("reports an unreadable record as a problem and still loads the rest", async () => {
    const home = await tempDir();
    await mkdir(path.join(home, "runs/bad"), { recursive: true });
    await writeFile(path.join(home, "runs/bad/1.json"), "{ truncated");
    await child(home, "open", "0");
    const ledger = await loadLedger(plainEnv(home));
    assert.equal(ledger.problems.length, 1);
    assert.match(ledger.problems[0] ?? "", /runs\/bad\/1\.json/);
    assert.equal(ledger.spends.length, 1);
  });
});
