import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { DEFAULT_TIMING } from "../src/config.ts";
import type { Env } from "../src/config.ts";
import type { AbsPath } from "../src/model.ts";

const made: string[] = [];
after(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

export async function tempDir(prefix = "syt-test-"): Promise<AbsPath> {
  const dir = (await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)))) as AbsPath;
  made.push(dir);
  return dir;
}

export function plainEnv(home: AbsPath, now = () => new Date("2026-10-28T19:05:00-07:00")): Env {
  return { home, claudeBin: "/nonexistent/claude", now, timing: DEFAULT_TIMING, vars: { PATH: process.env.PATH } };
}
