/**
 * Process identity that survives crashes and pid reuse. Locks, claims and orphan detection all
 * reduce to "is this token's process still the one that wrote it?"
 *
 * No leases or heartbeats: a laptop that sleeps through a lease would look dead and be taken over
 * while still running. A pid plus its exact start time can't be mistaken for another process.
 */

import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { ProcessToken } from "./model.ts";

let self: Promise<ProcessToken> | null = null;

export function selfToken(): Promise<ProcessToken> {
  self ??= tokenOf(process.pid).then((t) => {
    if (t === null) throw new Error("ps can't see this process");
    return t;
  });
  return self;
}

/** `ps -o lstart= -p <pid>`, trimmed. null when no such process exists. */
export function tokenOf(pid: number): Promise<ProcessToken | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { env: { LC_ALL: "C", PATH: "/bin:/usr/bin" } }, (err, stdout) => {
      const lstart = err ? "" : stdout.trim();
      resolve(lstart === "" ? null : { pid, lstart });
    });
  });
}

export async function isAlive(token: ProcessToken): Promise<boolean> {
  const now = await tokenOf(token.pid);
  return now !== null && now.lstart === token.lstart;
}

/**
 * Stops the process group the token leads: SIGTERM, then SIGKILL after `graceMs`. A no-op when the
 * token no longer matches, so it never signals a stranger that inherited the pid.
 */
export async function stopGroup(token: ProcessToken, graceMs: number): Promise<void> {
  if (!(await isAlive(token))) return;
  signalGroup(token.pid, "SIGTERM");
  if (await gone(token, graceMs)) return;
  signalGroup(token.pid, "SIGKILL");
  await gone(token, 5_000);
}

export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

async function gone(token: ProcessToken, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    if (!(await isAlive(token))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}
