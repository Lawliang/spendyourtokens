/**
 * Everything that touches a git checkout: the base checkout's cleanliness, the task worktree's
 * lifecycle, sealing work into commits, and the done check. Every operation converges, because a
 * crash can interrupt any of them and the next attempt calls them again.
 *
 * Git mutations are serialized within the process, since two slots may share a repo and git takes
 * repo-wide locks. Exclusivity across processes comes from the spend lock.
 */

import { spawn } from "node:child_process";
import { open, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Env } from "./config.ts";
import { realpathOrNull } from "./config.ts";
import { isCommitSha } from "./model.ts";
import type { AbsPath, BranchName, CheckRun, CommitSha, DiffStat, Repo, Sealed, ShellCommand, TaskId } from "./model.ts";

export function branchFor(task: TaskId): BranchName {
  return `syt/${task}` as BranchName;
}

export function worktreePathFor(env: Env, repo: Repo, task: TaskId): AbsPath {
  return path.join(env.home, "worktrees", repo.key, task) as AbsPath;
}

let gitChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = gitChain.then(fn, fn);
  gitChain = next.catch(() => {});
  return next;
}

type GitResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

const GIT_ENV = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

function git(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function must(cwd: string, args: readonly string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout;
}

/** The git toplevel containing `dir`, or null outside a repo. */
export async function repoRoot(dir: string): Promise<AbsPath | null> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? realpathOrNull(r.stdout.trim()) : null;
}

export type BaseState =
  | { readonly kind: "clean"; readonly head: CommitSha }
  | { readonly kind: "dirty"; readonly detail: string }
  | { readonly kind: "not-a-repo"; readonly detail: string };

/**
 * Is the user's checkout safe to branch from? Changes to tracked files make it dirty. Untracked
 * files don't, because they never reach a worktree built from HEAD.
 */
export async function inspectBase(repo: AbsPath): Promise<BaseState> {
  const head = await git(repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  const sha = head.stdout.trim();
  if (head.code !== 0 || !isCommitSha(sha)) return { kind: "not-a-repo", detail: head.stderr.trim() || "no commits yet" };
  const status = await git(repo, ["status", "--porcelain", "--untracked-files=no"]);
  if (status.code !== 0) return { kind: "not-a-repo", detail: status.stderr.trim() };
  const changed = status.stdout.split("\n").filter((l) => l.trim() !== "");
  if (changed.length > 0) return { kind: "dirty", detail: changed.slice(0, 3).join("; ") };
  return { kind: "clean", head: sha };
}

export type Ensure = { readonly kind: "ready"; readonly created: boolean } | { readonly kind: "conflict"; readonly detail: string };

/**
 * Converges to "path is a worktree of repo with `branch` checked out", whatever a crash left:
 *   path registered on branch          reuse
 *   path missing, branch missing       worktree add -b <branch> <path> <base>
 *   path missing, branch present       prune, then worktree add <path> <branch>
 *   path exists but isn't that worktree, or git refuses (branch checked out elsewhere)
 *                                      conflict. It never deletes a directory it can't prove is its own.
 */
export function ensureWorktree(input: { readonly repo: AbsPath; readonly path: AbsPath; readonly branch: BranchName; readonly base: CommitSha }): Promise<Ensure> {
  return serialized(async () => {
    const list = await git(input.repo, ["worktree", "list", "--porcelain"]);
    if (list.code !== 0) return { kind: "conflict", detail: list.stderr.trim() };
    const real = (await realpathOrNull(input.path)) ?? input.path;
    const here = parseWorktrees(list.stdout).find((w) => w.path === input.path || w.path === real);
    const present = await exists(input.path);

    if (present && here) {
      return here.branch === `refs/heads/${input.branch}`
        ? { kind: "ready", created: false }
        : { kind: "conflict", detail: `${input.path} is a worktree on ${here.branch ?? "a detached HEAD"}, not ${input.branch}` };
    }
    if (present) return { kind: "conflict", detail: `${input.path} exists and is not a worktree of ${input.repo}` };

    await mkdir(path.dirname(input.path), { recursive: true });
    await git(input.repo, ["worktree", "prune"]);
    const hasBranch = (await git(input.repo, ["rev-parse", "--verify", "-q", `refs/heads/${input.branch}`])).code === 0;
    const added = await git(
      input.repo,
      hasBranch ? ["worktree", "add", input.path, input.branch] : ["worktree", "add", "-b", input.branch, input.path, input.base],
    );
    return added.code === 0 ? { kind: "ready", created: true } : { kind: "conflict", detail: added.stderr.trim() };
  });
}

function parseWorktrees(porcelain: string): { path: string; branch: string | null }[] {
  return porcelain
    .split("\n\n")
    .map((block) => {
      const lines = block.split("\n");
      const wt = lines.find((l) => l.startsWith("worktree "));
      const br = lines.find((l) => l.startsWith("branch "));
      return wt ? { path: wt.slice("worktree ".length), branch: br ? br.slice("branch ".length) : null } : null;
    })
    .filter((w) => w !== null);
}

const COMMIT_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m"];

/**
 * Commits everything in the worktree with hooks off and the repo's own identity, then measures the
 * cumulative diff against the task's base. Runs after every agent exit and before the done check,
 * so the branch holds the work and check artifacts never get committed. A second run does nothing.
 */
export function sealWork(input: { readonly path: AbsPath; readonly base: CommitSha; readonly message: string }): Promise<Sealed> {
  return serialized(async () => {
    await must(input.path, ["add", "-A"]);
    const staged = await git(input.path, ["diff", "--cached", "--quiet"]);
    let commit: CommitSha | null = null;
    if (staged.code === 1) {
      await must(input.path, [...COMMIT_FLAGS, input.message]);
      const sha = (await must(input.path, ["rev-parse", "HEAD"])).trim();
      if (isCommitSha(sha)) commit = sha;
    } else if (staged.code !== 0) {
      throw new Error(`git diff failed: ${staged.stderr.trim()}`);
    }
    return { commit, diff: parseShortstat(await must(input.path, ["diff", "--shortstat", input.base, "HEAD"])) };
  });
}

function parseShortstat(s: string): DiffStat {
  const n = (re: RegExp) => Number(re.exec(s)?.[1] ?? 0);
  return { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?\(\+\)/), deletions: n(/(\d+) deletions?\(-\)/) };
}

/** Puts the worktree back to a commit (HEAD when null): tracked edits reverted, untracked files removed, ignored files kept. */
export function resetWorktree(input: { readonly path: AbsPath; readonly to: CommitSha | null }): Promise<void> {
  return serialized(async () => {
    await must(input.path, ["reset", "-q", "--hard", input.to ?? "HEAD"]);
    await must(input.path, ["clean", "-fdq"]);
  });
}

const CHECK_TAIL_LINES = 40;

/**
 * Runs the done check with `/bin/sh -c` in the worktree, output to `log`. On timeout its process
 * group gets SIGTERM, then SIGKILL. Anything it left running is killed, and the worktree is reset to
 * `restore`, so a check's edits and stray files don't leak into the next attempt.
 */
export async function runCheck(input: {
  readonly path: AbsPath;
  readonly command: ShellCommand;
  readonly timeoutMs: number;
  readonly log: AbsPath;
  readonly restore: CommitSha | null;
}): Promise<CheckRun> {
  await mkdir(path.dirname(input.log), { recursive: true });
  const log = await open(input.log, "w");
  let timedOut = false;
  let code: number;
  try {
    code = await new Promise<number>((resolve) => {
      const child = spawn("/bin/sh", ["-c", input.command], { cwd: input.path, detached: true, stdio: ["ignore", log.fd, log.fd] });
      const killGroup = (signal: NodeJS.Signals) => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal);
        } catch {
          // the group is already gone
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), 5_000).unref();
      }, input.timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        void log.write(`syt: could not run the check: ${e.message}\n`);
        resolve(127);
      });
      child.on("close", (c, signal) => {
        clearTimeout(timer);
        killGroup("SIGKILL");
        resolve(c ?? (signal ? 128 : 1));
      });
    });
  } finally {
    await log.close();
  }
  const tail = await tailOf(input.log, CHECK_TAIL_LINES);
  await resetWorktree({ path: input.path, to: input.restore });
  return timedOut ? { kind: "timed-out", tail } : { kind: "exited", code, tail };
}

async function tailOf(file: string, lines: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    return buf.toString("utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } finally {
    await handle.close();
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
