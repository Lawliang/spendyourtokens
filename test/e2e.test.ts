import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";
import type { Timing } from "../src/config.ts";
import type { AbsPath } from "../src/model.ts";
import type { FakeRun, UsageStep } from "./fake-claude.ts";
import { FAKE_CLAUDE, RECORDED_AT, fakeEnv, fakeScenario, git, gitRepo, tempDir, testClock } from "./helpers.ts";

const DRIVER = fileURLToPath(new URL("./support/syt-driver.ts", import.meta.url));
const SESSION = "cf9ac047-8f1e-4ea2-8bbf-3b6cc8a19723";

type Brakes = { stop?: AbortSignal; kill?: AbortSignal };

async function world(opts: { runs?: FakeRun[]; usage?: UsageStep[]; auth?: string; config?: (repo: string) => string; timing?: Partial<Timing> } = {}) {
  const root = await tempDir();
  const home = path.join(root, "home") as AbsPath;
  await mkdir(home);
  const repo = await gitRepo(path.join(root, "app"), { "README.md": "# app\n", "package.json": '{ "name": "app" }\n' });
  const fake = await fakeScenario(path.join(root, "fake"), {
    runs: opts.runs ?? [],
    ...(opts.usage !== undefined && { usage: opts.usage }),
    ...(opts.auth !== undefined && { auth: opts.auth }),
  });
  const clock = testClock();
  const env = fakeEnv(home, fake, { now: clock.now, timing: opts.timing ?? {} });
  await writeFile(path.join(home, "config.toml"), opts.config?.(repo) ?? `[repos.app]\npath = "${repo}"\ntest = "test -f hello.txt"\n`);

  const start = (argv: string[], brakes: Brakes = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const done = main(argv, env, {
      out: (s) => out.push(...s.split("\n")),
      err: (s) => err.push(...s.split("\n")),
      cwd: repo,
      brakes: () => ({ stop: brakes.stop ?? new AbortController().signal, kill: brakes.kill ?? new AbortController().signal }),
    }).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
    return { out, done };
  };
  return {
    root,
    home,
    repo,
    fake,
    clock,
    start,
    syt: (...argv: string[]) => start(argv).done,
    queue: (yaml: string) => writeFile(path.join(home, "queue.yaml"), yaml),
    agentRuns: async () => (await fake.invocations()).filter((i) => i.argv.includes("stream-json")),
  };
}

async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const promptOf = (argv: readonly string[]) => argv[argv.indexOf("-p") + 1] ?? "";
const resumeOf = (argv: readonly string[]) => (argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : null);

describe("syt end to end", () => {
  it("adds a task, runs it to a passing check, and reports its branch and diff", async () => {
    const w = await world({ runs: [{ stream: "stream/task-with-user-hooks.jsonl", writeFiles: { "hello.txt": "hi\n" } }] });
    const added = await w.syt("add", "Create hello.txt containing hi");
    assert.equal(added.code, 0, added.err);
    const id = /^added (\S+)/.exec(added.out)?.[1] ?? "";
    assert.match(added.out, /check: test -f hello.txt \(repo default\)/);
    await writeFile(path.join(w.repo, "notes.txt"), "untracked\n");
    const baseHead = await git(w.repo, "rev-parse", "HEAD");

    const ran = await w.syt("run", "--now");
    assert.equal(ran.code, 0, `${ran.out}\n${ran.err}`);
    assert.match(ran.out, new RegExp(`end +${id} #1 +passed +1 file \\+1 -0`));

    const report = await w.syt("report");
    assert.match(report.out, new RegExp(`passed +${id} #1 +syt/${id} +1 file \\+1 -0 +\\+0 / \\+0`));
    assert.equal(await git(w.repo, "show", `syt/${id}:hello.txt`), "hi", "the work is committed on syt/<id>");
    assert.equal(await git(w.repo, "log", "-1", "--format=%s", `syt/${id}`), `syt: ${id} attempt 1`);
    assert.equal(await git(w.repo, "rev-parse", "HEAD"), baseHead, "the user's checkout never moved");
    assert.equal(await git(w.repo, "status", "--porcelain"), "?? notes.txt", "an untracked file didn't block the run");

    const [agent] = await w.agentRuns();
    assert.equal(agent?.cwd, path.join(w.home, "worktrees/app", id));
    for (const inv of await w.fake.invocations()) {
      assert.ok(!inv.argv.includes("--bare") && !inv.argv.includes("--dangerously-skip-permissions"), JSON.stringify(inv.argv));
    }
    assert.match((await w.syt("queue")).out, new RegExp(`${id} +app +normal +passed \\(attempt 1, syt/${id}\\)`));
  });

  it("calls a run that changed nothing a no-op without running the check", async () => {
    const w = await world({ runs: [{ stream: "stream/task-resume.jsonl" }] });
    await w.queue(`- { id: noop, repo: "${w.repo}", prompt: "Look around", done_when: "false" }\n`);
    const ran = await w.syt("run", "--now");
    assert.match(ran.out, /end +noop #1 +no-op/);
    assert.equal(await git(w.repo, "rev-list", "--count", "main..syt/noop"), "0");
    assert.match((await w.syt("report")).out, /no-op +noop #1/);
  });

  it("exits 2 without spending when --task names a task that isn't queued", async () => {
    const w = await world({ runs: [] });
    const ran = await w.syt("run", "--now", "--task", "ghost");
    assert.equal(ran.code, 2, ran.out);
    assert.match(ran.out, /task ghost is not in the queue/);
    assert.equal((await w.agentRuns()).length, 0);
  });

  it("fails a task whose check fails, retries it once in the same session with the check output, then flags it", async () => {
    const w = await world({
      runs: [
        { stream: "stream/task-allowlist.jsonl", writeFiles: { "a.txt": "1\n" } },
        { stream: "stream/task-resume.jsonl", writeFiles: { "a.txt": "2\n" } },
        { stream: "stream/task-resume.jsonl" },
      ],
    });
    await w.queue(`- id: flaky\n  repo: "${w.repo}"\n  prompt: Fix the parser\n  done_when: "echo 'expected 3, got 2' >&2; exit 1"\n`);

    assert.match((await w.syt("run", "--now")).out, /end +flaky #1 +failed/);
    assert.match((await w.syt("run", "--now")).out, /end +flaky #2 +failed/);
    const [first, retry] = await w.agentRuns();
    assert.equal(resumeOf(retry?.argv ?? []), SESSION, "the retry resumes the failed session");
    assert.equal(retry?.cwd, first?.cwd, "from the same worktree");
    assert.match(promptOf(retry?.argv ?? []), /expected 3, got 2/);

    assert.match((await w.syt("queue")).out, /flaky .*flagged: failed twice/);
    const third = await w.syt("run", "--now");
    assert.match(third.out, /queue drained/);
    assert.equal((await w.agentRuns()).length, 2, "a flagged task doesn't run on its own");

    assert.match((await w.syt("run", "--now", "--task", "flaky")).out, /start +flaky #3/, "--task forces a flagged task");
    assert.equal((await w.agentRuns()).length, 3);
  });

  it("stops at the session reserve, keeps the partial work, and resumes it next run in the same worktree", async () => {
    const w = await world({
      timing: { tickMs: 60_000 },
      runs: [
        { stream: "stream/task-allowlist.jsonl", writeFiles: { "part1.txt": "first half\n" }, utilization: { session: 0.86 }, lineDelayMs: 50 },
        { stream: "stream/task-resume.jsonl", writeFiles: { "hello.txt": "done\n" } },
      ],
    });
    await w.queue(`- { id: parser, repo: "${w.repo}", prompt: "Write the parser" }\n`);

    const first = await w.syt("run", "--now");
    assert.match(first.out, /end +parser #1 +partial .*session reserve reached \(86% used\)/);
    assert.match(first.out, /halt +session is within the start margin/);
    assert.equal(await git(w.repo, "show", "syt/parser:part1.txt"), "first half", "partial work is sealed on the branch");
    assert.match((await w.syt("queue")).out, /parser .*ready: resume after partial/);

    const second = await w.syt("run", "--now");
    assert.match(second.out, /end +parser #2 +passed/);
    const [stopped, resumed] = await w.agentRuns();
    assert.equal(resumeOf(resumed?.argv ?? []), SESSION);
    assert.equal(resumed?.cwd, stopped?.cwd);
    assert.equal(await git(w.repo, "show", "syt/parser:part1.txt"), "first half");
    assert.equal(await git(w.repo, "show", "syt/parser:hello.txt"), "done");
  });

  it("refuses API-key auth before any agent starts", async () => {
    const w = await world({ auth: "auth/api-key.json", runs: [{ stream: "stream/task-resume.jsonl" }] });
    await w.queue(`- { id: t, repo: "${w.repo}", prompt: "p" }\n`);
    const ran = await w.syt("run", "--now");
    assert.equal(ran.code, 1);
    assert.match(ran.err, /not a subscription login: API key from ANTHROPIC_API_KEY/);
    assert.deepEqual((await w.fake.invocations()).map((i) => i.argv.slice(0, 2)), [["auth", "status"]], "nothing but the login check ran");
  });

  it("kills an agent whose init reports an API key, and halts the spend", async () => {
    const w = await world({
      config: (repo) => `concurrency = 1\n[repos.app]\npath = "${repo}"\ntest = "test -f hello.txt"\n`,
      runs: [
        { stream: "stream/task-allowlist.jsonl", apiKeySource: "ANTHROPIC_API_KEY", hangAfterLine: 1 },
        { stream: "stream/task-resume.jsonl" },
      ],
    });
    await w.queue(`- { id: one, repo: "${w.repo}", prompt: "p" }\n- { id: two, repo: "${w.repo}", prompt: "p" }\n`);
    const ran = await w.syt("run", "--now");
    assert.match(ran.out, /end +one #1 +errored .*refused: API key from ANTHROPIC_API_KEY/);
    assert.match(ran.out, /halt +an agent was killed at init/);
    assert.equal((await w.agentRuns()).length, 1, "the second task never started");
  });

  it("skips a repo whose checkout has uncommitted changes, and runs it once it's clean", async () => {
    const w = await world({ runs: [{ stream: "stream/task-resume.jsonl", writeFiles: { "hello.txt": "hi\n" } }] });
    await w.queue(`- { id: t, repo: "${w.repo}", prompt: "p" }\n`);
    await writeFile(path.join(w.repo, "README.md"), "half-finished edit\n");

    const skipped = await w.syt("run", "--now");
    assert.match(skipped.out, /skip +t +repo app is dirty/);
    assert.match(skipped.out, /skipped: app \(dirty\)/);
    assert.equal((await w.agentRuns()).length, 0);

    await git(w.repo, "checkout", "README.md");
    assert.match((await w.syt("run", "--now")).out, /end +t #1 +passed/);
  });

  it("finishes an attempt whose agent exited before a crash, without starting another agent", async () => {
    const w = await world({ runs: [{ stream: "stream/task-allowlist.jsonl", writeFiles: { "hello.txt": "hi\n" } }] });
    const mark = path.join(w.root, "check-started");
    await w.queue(
      `- id: crashy\n  repo: "${w.repo}"\n  prompt: p\n  done_when: "if [ -f ${mark} ]; then test -f hello.txt; else echo $$ > ${mark}; exec sleep 60; fi"\n`,
    );
    const driver = spawn(process.execPath, [DRIVER, "run", "--now"], {
      cwd: w.repo,
      env: { ...w.fake.vars, SYT_HOME: w.home, SYT_CLAUDE_BIN: FAKE_CLAUDE, SYT_TEST_START: RECORDED_AT.toISOString() },
      stdio: "ignore",
    });
    await until("the done check to start", () => stat(mark).then(() => true, () => false));
    driver.kill("SIGKILL");
    await once(driver, "exit");
    process.kill(-Number(await readFile(mark, "utf8")), "SIGKILL");

    assert.match((await w.syt("queue")).out, /crashy .*ready: finish \(no agent\)/);
    const ran = await w.syt("run", "--now");
    assert.match(ran.out, /end +crashy #2 +passed/);
    assert.equal((await w.agentRuns()).length, 1, "no second agent was spawned");
    const report = (await w.syt("report")).out;
    assert.match(report, /interrupted +crashy #1/);
    assert.match(report, /passed +crashy #2 .*\n +finished after a crash, no tokens spent/);
  });

  it("runs two tasks at once and both complete", async () => {
    const w = await world({
      runs: [
        { stream: "stream/task-allowlist.jsonl", writeFiles: { "hello.txt": "a\n" }, lineDelayMs: 40 },
        { stream: "stream/task-allowlist.jsonl", writeFiles: { "hello.txt": "b\n" }, lineDelayMs: 40 },
      ],
    });
    await w.queue(`- { id: one, repo: "${w.repo}", prompt: "p" }\n- { id: two, repo: "${w.repo}", prompt: "p" }\n`);
    const ran = await w.syt("run", "--now");
    const lines = ran.out.split("\n");
    const firstEnd = lines.findIndex((l) => l.startsWith("end"));
    assert.equal(lines.filter((l, i) => l.startsWith("start") && i < firstEnd).length, 2, "both started before either ended");
    assert.match(ran.out, /end +one #1 +passed/);
    assert.match(ran.out, /end +two #1 +passed/);
    const cwds = new Set((await w.agentRuns()).map((i) => i.cwd));
    assert.equal(cwds.size, 2, "each in its own worktree");
  });

  it("picks up a hand-edited queue.yaml task and a task added mid-run", async () => {
    const w = await world({
      config: (repo) => `concurrency = 1\n[repos.app]\npath = "${repo}"\ntest = "test -f hello.txt"\n`,
      runs: [
        { stream: "stream/task-allowlist.jsonl", writeFiles: { "hello.txt": "a\n" }, lineDelayMs: 40 },
        { stream: "stream/task-resume.jsonl", writeFiles: { "hello.txt": "b\n" } },
      ],
    });
    await w.queue(`# written by hand\n- id: by-hand\n  repo: "${w.repo}"\n  prompt: From the editor\n`);
    const running = w.start(["run", "--now"]);
    await until("the first task to start", () => running.out.some((l) => l.startsWith("start  by-hand")));
    const added = await w.syt("add", "From another terminal");
    const id = /^added (\S+)/.exec(added.out)?.[1] ?? "";
    const ran = await running.done;
    assert.match(ran.out, /end +by-hand #1 +passed/);
    assert.match(ran.out, new RegExp(`end +${id} #1 +passed`), "the added task ran in the same spend");
  });

  it("stops at the next turn on Ctrl-C and records partial work", async () => {
    const w = await world({ runs: [{ stream: "stream/task-allowlist.jsonl", writeFiles: { "part.txt": "x\n" }, lineDelayMs: 100 }] });
    await w.queue(`- { id: t, repo: "${w.repo}", prompt: "p" }\n`);
    const stop = new AbortController();
    const running = w.start(["run", "--now"], { stop: stop.signal });
    await until("the task to start", () => running.out.some((l) => l.startsWith("start")));
    stop.abort();
    const ran = await running.done;
    assert.match(ran.out, /end +t #1 +partial .*stopped by you/);
    assert.match(ran.out, /halt +stopped by you/);
  });

  it("stops a task at its max_minutes", async () => {
    const w = await world({ runs: [{ stream: "stream/task-allowlist.jsonl", writeFiles: { "part.txt": "x\n" }, lineDelayMs: 100 }] });
    await w.queue(`- { id: t, repo: "${w.repo}", prompt: "p", max_minutes: 1 }\n`);
    const running = w.start(["run", "--now"]);
    await until("the task to start", () => running.out.some((l) => l.startsWith("start")));
    w.clock.jump(61_000);
    assert.match((await running.done).out, /end +t #1 +partial .*time cap of 1 minutes/);
  });

  it("stops running agents when /usage becomes unreadable", async () => {
    const w = await world({
      usage: ["usage/subscription-max.txt", "unreadable"],
      timing: { usagePollMs: 300 },
      runs: [{ stream: "stream/task-allowlist.jsonl", writeFiles: { "part.txt": "x\n" }, lineDelayMs: 100 }],
    });
    await w.queue(`- { id: t, repo: "${w.repo}", prompt: "p" }\n`);
    const ran = await w.syt("run", "--now");
    assert.match(ran.out, /end +t #1 +partial .*usage unreadable/);
    assert.match(ran.out, /halt +usage unreadable/);
  });

  it("allows one spend at a time", async () => {
    const w = await world({ runs: [{ stream: "stream/task-allowlist.jsonl", hangAfterLine: 2 }] });
    await w.queue(`- { id: t, repo: "${w.repo}", prompt: "p" }\n`);
    const kill = new AbortController();
    const running = w.start(["run", "--now"], { kill: kill.signal });
    await until("the task to start", () => running.out.some((l) => l.startsWith("start")));
    const second = await w.syt("run", "--now");
    assert.equal(second.code, 3);
    assert.match(second.err, /spend 1 is active/);
    kill.abort();
    assert.match((await running.done).out, /end +t #1 +partial/);
  });
});
