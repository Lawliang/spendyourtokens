import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_TIMING } from "../src/config.ts";
import type { Env, Timing } from "../src/config.ts";
import type { AbsPath } from "../src/model.ts";
import type { Invocation, Scenario } from "./fake-claude.ts";

export const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.ts", import.meta.url));
export const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
export const RECORDED_AT = new Date("2026-10-28T19:05:00-07:00");

const made: string[] = [];
after(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

export async function tempDir(prefix = "syt-test-"): Promise<AbsPath> {
  const dir = (await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)))) as AbsPath;
  made.push(dir);
  return dir;
}

export function plainEnv(home: AbsPath, now = () => RECORDED_AT): Env {
  return { home, claudeBin: "/nonexistent/claude", now, timing: DEFAULT_TIMING, vars: { PATH: process.env.PATH } };
}

export function testClock(start = RECORDED_AT) {
  const t0 = Date.now();
  let offset = 0;
  return {
    now: () => new Date(start.getTime() + offset + (Date.now() - t0)),
    jump: (ms: number) => {
      offset += ms;
    },
  };
}

export const FAST: Timing = {
  usagePollMs: 60_000,
  usageFreshMs: 60_000,
  maxReadingAgeMs: 10 * 60_000,
  tickMs: 100,
  stopGraceMs: 1_500,
  killGraceMs: 500,
  initTimeoutMs: 5_000,
  probeTimeoutMs: 10_000,
  checkTimeoutMs: 10_000,
};

export type Fake = { readonly path: string; readonly invocations: () => Promise<Invocation[]>; readonly vars: Record<string, string | undefined> };

export async function fakeScenario(dir: string, s: Partial<Pick<Scenario, "auth" | "usage" | "runs">>): Promise<Fake> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "scenario.json");
  const log = path.join(dir, "invocations.jsonl");
  const scenario: Scenario = {
    fixtures: FIXTURES,
    auth: s.auth ?? "auth/subscription.json",
    usage: s.usage ?? ["usage/subscription-max.txt"],
    runs: s.runs ?? [],
    log,
  };
  await writeFile(file, JSON.stringify(scenario));
  await writeFile(log, "");
  return {
    path: file,
    vars: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_CLAUDE_SCENARIO: file },
    invocations: async () =>
      (await readFile(log, "utf8"))
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as Invocation),
  };
}

export function fakeEnv(home: AbsPath, fake: Fake, opts: { now?: () => Date; timing?: Partial<Timing> } = {}): Env {
  return { home, claudeBin: FAKE_CLAUDE, now: opts.now ?? testClock().now, timing: { ...FAST, ...opts.timing }, vars: fake.vars };
}

const execFileP = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileP("git", args, { cwd })).stdout.trim();
}

export async function gitRepo(dir: string, files: Readonly<Record<string, string>>): Promise<AbsPath> {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "Syt Test");
  await git(dir, "config", "user.email", "syt@example.com");
  await git(dir, "config", "commit.gpgsign", "false");
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "initial");
  return (await realpath(dir)) as AbsPath;
}
