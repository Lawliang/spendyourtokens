import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { AbsPath, BranchName, CommitSha, ShellCommand } from "../src/model.ts";
import { tokenOf } from "../src/proc.ts";
import { ensureWorktree, inspectBase, runCheck, sealWork } from "../src/worktree.ts";
import { git, gitRepo, tempDir } from "./helpers.ts";

async function setup() {
  const dir = await tempDir();
  const repo = await gitRepo(path.join(dir, "repo"), { "README.md": "hello\n", "src/a.txt": "a\n" });
  const base = (await git(repo, "rev-parse", "HEAD")) as CommitSha;
  const wt = path.join(dir, "home/worktrees/repo/t1") as AbsPath;
  const branch = "syt/t1" as BranchName;
  return { dir, repo, base, wt, branch };
}

describe("inspectBase", () => {
  it("is clean at HEAD, ignores untracked files, and is dirty on a tracked change", async () => {
    const { repo, base } = await setup();
    assert.deepEqual(await inspectBase(repo), { kind: "clean", head: base });
    await writeFile(path.join(repo, "scratch.txt"), "untracked\n");
    assert.deepEqual(await inspectBase(repo), { kind: "clean", head: base }, "untracked files never reach a worktree");
    await writeFile(path.join(repo, "README.md"), "edited\n");
    assert.equal((await inspectBase(repo)).kind, "dirty");
  });

  it("knows a directory that isn't a repo", async () => {
    assert.equal((await inspectBase((await tempDir()) as AbsPath)).kind, "not-a-repo");
  });
});

describe("ensureWorktree", () => {
  it("creates the branch at the base, then reuses it", async () => {
    const { repo, base, wt, branch } = await setup();
    assert.deepEqual(await ensureWorktree({ repo, path: wt, branch, base }), { kind: "ready", created: true });
    assert.equal(await git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "syt/t1");
    assert.equal(await git(wt, "rev-parse", "HEAD"), base);
    assert.deepEqual(await ensureWorktree({ repo, path: wt, branch, base }), { kind: "ready", created: false });
  });

  it("re-attaches the existing branch when the directory was deleted", async () => {
    const { repo, base, wt, branch } = await setup();
    await ensureWorktree({ repo, path: wt, branch, base });
    await writeFile(path.join(wt, "work.txt"), "kept\n");
    await sealWork({ path: wt, base, message: "work" });
    await rm(wt, { recursive: true, force: true });
    assert.deepEqual(await ensureWorktree({ repo, path: wt, branch, base }), { kind: "ready", created: true });
    assert.equal(await readFile(path.join(wt, "work.txt"), "utf8"), "kept\n", "the branch's commits survive");
  });

  it("refuses a directory it can't prove is its own, and leaves it alone", async () => {
    const { repo, base, wt, branch } = await setup();
    await mkdir(wt, { recursive: true });
    await writeFile(path.join(wt, "precious.txt"), "mine\n");
    assert.equal((await ensureWorktree({ repo, path: wt, branch, base })).kind, "conflict");
    assert.equal(await readFile(path.join(wt, "precious.txt"), "utf8"), "mine\n");
  });

  it("reports a branch checked out elsewhere as a conflict", async () => {
    const { repo, base, wt, branch } = await setup();
    await git(repo, "checkout", "-q", "-b", "syt/t1");
    assert.equal((await ensureWorktree({ repo, path: wt, branch, base })).kind, "conflict");
  });
});

describe("sealWork", () => {
  it("commits everything with hooks off and measures the cumulative diff", async () => {
    const { repo, base, wt, branch } = await setup();
    await ensureWorktree({ repo, path: wt, branch, base });
    const hook = path.join(repo, ".git/hooks/pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    await writeFile(path.join(wt, "new.txt"), "one\ntwo\n");
    await writeFile(path.join(wt, "README.md"), "hello again\n");
    const first = await sealWork({ path: wt, base, message: "syt: t1 attempt 1" });
    assert.ok(first.commit, "a commit was made despite the failing hook");
    assert.equal(await git(wt, "log", "-1", "--format=%s%n%an"), "syt: t1 attempt 1\nSyt Test");
    assert.deepEqual(first.diff, { files: 2, insertions: 3, deletions: 1 });
    assert.equal(await git(repo, "status", "--porcelain"), "", "the user's checkout is untouched");

    const again = await sealWork({ path: wt, base, message: "syt: t1 attempt 2" });
    assert.deepEqual(again, { commit: null, diff: first.diff }, "sealing twice changes nothing");
  });
});

describe("runCheck", () => {
  it("returns the exit code and output tail, then restores the sealed commit", async () => {
    const { dir, repo, base, wt, branch } = await setup();
    await ensureWorktree({ repo, path: wt, branch, base });
    const log = path.join(dir, "logs/check.log") as AbsPath;
    const check = await runCheck({
      path: wt,
      command: "echo checking; echo leaked > leaked.txt; echo changed > README.md; echo 'nope' >&2; exit 3" as ShellCommand,
      timeoutMs: 5_000,
      log,
      restore: null,
    });
    assert.deepEqual(check, { kind: "exited", code: 3, tail: "checking\nnope" });
    assert.match(await readFile(log, "utf8"), /checking/);
    assert.equal(await git(wt, "status", "--porcelain"), "", "the check's edits and stray files are gone");
  });

  it("times out, killing the check's whole process group", async () => {
    const { dir, repo, base, wt, branch } = await setup();
    await ensureWorktree({ repo, path: wt, branch, base });
    const pidFile = path.join(dir, "sleeper.pid");
    const check = await runCheck({
      path: wt,
      command: `sleep 30 & echo $! > ${pidFile}; wait` as ShellCommand,
      timeoutMs: 300,
      log: path.join(dir, "logs/check.log") as AbsPath,
      restore: null,
    });
    assert.equal(check.kind, "timed-out");
    const sleeper = Number(await readFile(pidFile, "utf8"));
    assert.equal(await tokenOf(sleeper), null, "the check's child died with it");
  });
});
