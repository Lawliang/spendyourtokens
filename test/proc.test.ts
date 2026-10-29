import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { isAlive, selfToken, stopGroup, tokenOf } from "../src/proc.ts";
import type { ProcessToken } from "../src/model.ts";

async function group(script: string): Promise<{ leader: ProcessToken; child: number }> {
  const p = spawn("sh", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const [line] = (await once(p.stdout, "data")) as [Buffer];
  const leader = await tokenOf(p.pid ?? 0);
  assert.ok(leader, "the group leader has a token");
  return { leader, child: Number(line.toString().trim()) };
}

async function eventuallyDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if ((await tokenOf(pid)) === null) return true;
    await sleep(50);
  }
  return false;
}

describe("process tokens", () => {
  it("identify this process and reject a reused pid", async () => {
    const self = await selfToken();
    assert.equal(self.pid, process.pid);
    assert.equal(await isAlive(self), true);
    assert.equal(await isAlive({ pid: self.pid, lstart: "Thu Jan  1 00:00:00 1970" }), false);
    assert.equal(await tokenOf(2 ** 30), null);
  });
});

describe("stopGroup", () => {
  it("stops the leader and its children", async () => {
    const { leader, child } = await group("sleep 30 & echo $!; wait");
    await stopGroup(leader, 2_000);
    assert.equal(await isAlive(leader), false);
    assert.ok(await eventuallyDead(child), "the grandchild died with its group");
  });

  it("kills a group that ignores SIGTERM once the grace runs out", async () => {
    const { leader } = await group("trap '' TERM; echo ready; while :; do sleep 0.05; done");
    const started = Date.now();
    await stopGroup(leader, 300);
    assert.equal(await isAlive(leader), false);
    assert.ok(Date.now() - started >= 300, "it waited out the grace first");
  });

  it("never signals a process whose start time doesn't match", async () => {
    const { leader, child } = await group("sleep 30 & echo $!; wait");
    try {
      await stopGroup({ pid: leader.pid, lstart: "Thu Jan  1 00:00:00 1970" }, 100);
      assert.equal(await isAlive(leader), true);
    } finally {
      await stopGroup(leader, 1_000);
      await eventuallyDead(child);
    }
  });
});
