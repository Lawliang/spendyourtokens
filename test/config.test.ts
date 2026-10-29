import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_LIMITS, envFromProcess, loadConfig } from "../src/config.ts";
import { plainEnv, tempDir } from "./helpers.ts";

async function homeWith(toml: string | null) {
  const home = await tempDir();
  if (toml !== null) await writeFile(path.join(home, "config.toml"), toml);
  return home;
}

describe("loadConfig", () => {
  it("gives defaults and no repos when there is no config file", async () => {
    const result = await loadConfig(plainEnv(await homeWith(null)));
    assert.deepEqual(result, { kind: "ok", config: { limits: DEFAULT_LIMITS, repos: [] } });
  });

  it("reads limits and repos, resolving a relative repo path against the home", async () => {
    const home = await homeWith(`
concurrency = 3
max_minutes = 45

[reserves]
session_pct = 20
week_pct = 7.5
start_margin_pts = 3
reset_guard_minutes = 10
start_runway_minutes = 30

[repos.app]
path = "code/app"
test = "npm test"
lint = "npm run lint"
`);
    await mkdir(path.join(home, "code/app"), { recursive: true });
    const result = await loadConfig(plainEnv(home));
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.deepEqual(result.config.limits, {
      concurrency: 3,
      defaultMaxMinutes: 45,
      sessionReservePct: 20,
      weekReservePct: 7.5,
      startMarginPts: 3,
      resetGuardMinutes: 10,
      startRunwayMinutes: 30,
    });
    assert.deepEqual(result.config.repos, [
      { key: "app", path: path.join(home, "code/app"), commands: { test: "npm test", lint: "npm run lint", build: null } },
    ]);
  });

  it("reports every problem at once", async () => {
    const home = await homeWith(`
concurrency = 9
colour = "blue"

[reserves]
session_pct = 80
reset_guard_minute = 5

[repos.app]
path = "missing/dir"

[repos.web]
test = "npm test"
`);
    const result = await loadConfig(plainEnv(home));
    assert.equal(result.kind, "invalid");
    if (result.kind !== "invalid") return;
    assert.deepEqual([...result.problems].sort(), [
      "concurrency must be a whole number from 1 to 4",
      "repos.app.path: missing/dir does not exist",
      "repos.web.path is required",
      "reserves.session_pct must be a number from 0 to 50",
      'unknown key "colour"',
      'unknown key "reserves.reset_guard_minute"',
    ]);
  });

  it("rejects two repo sections naming the same directory", async () => {
    const home = await homeWith(`
[repos.a]
path = "app"
[repos.b]
path = "./app/"
`);
    await mkdir(path.join(home, "app"));
    const result = await loadConfig(plainEnv(home));
    assert.equal(result.kind === "invalid" && result.problems.join(), "repos.b.path is the same repo as repos.a");
  });

  it("reports a TOML syntax error as one problem", async () => {
    const result = await loadConfig(plainEnv(await homeWith("concurrency = = 2")));
    assert.equal(result.kind === "invalid" && result.problems.length, 1);
  });
});

describe("envFromProcess", () => {
  it("refuses a relative SYT_HOME", () => {
    assert.throws(() => envFromProcess({ SYT_HOME: "relative/home" }), /absolute/);
  });

  it("takes SYT_HOME and SYT_CLAUDE_BIN from the environment", () => {
    const env = envFromProcess({ SYT_HOME: "/tmp/syt-home/", SYT_CLAUDE_BIN: "/opt/claude" });
    assert.equal(env.home, "/tmp/syt-home");
    assert.equal(env.claudeBin, "/opt/claude");
    assert.equal(envFromProcess({}).claudeBin, "claude");
  });
});
