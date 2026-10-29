import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_LIMITS } from "../src/config.ts";
import { addTask, loadQueue } from "../src/queue.ts";
import type { AbsPath, Config, RepoKey, ShellCommand } from "../src/model.ts";
import { plainEnv, tempDir } from "./helpers.ts";

async function setup() {
  const home = await tempDir();
  const app = path.join(home, "app") as AbsPath;
  const loose = path.join(home, "loose") as AbsPath;
  await mkdir(app);
  await mkdir(loose);
  const config: Config = {
    limits: DEFAULT_LIMITS,
    repos: [{ key: "app" as RepoKey, path: app, commands: { test: "npm test" as ShellCommand, lint: null, build: null } }],
  };
  return { home, app, loose, config, env: plainEnv(home) };
}

const write = (home: string, rel: string, text: string) => writeFile(path.join(home, rel), text);

describe("loadQueue", () => {
  it("merges queue.yaml and queue.d in declaration order", async () => {
    const { home, env, config } = await setup();
    await write(home, "queue.yaml", `
- id: first
  repo: app
  prompt: one
- id: second
  repo: app
  prompt: two
  priority: high
`);
    await mkdir(path.join(home, "queue.d"));
    await write(home, "queue.d/later.yaml", "added: 2026-10-28T10:00:00Z\nrepo: app\nprompt: later\n");
    await write(home, "queue.d/earlier.yaml", "added: 2026-10-27T10:00:00Z\nrepo: app\nprompt: earlier\n");
    const q = await loadQueue(env, config);
    assert.deepEqual(q.problems, []);
    assert.deepEqual(q.tasks.map((t) => t.id), ["first", "second", "earlier", "later"]);
    assert.equal(q.tasks[1]?.priority, "high");
  });

  it("resolves the done check from done_when, else the repo's test command", async () => {
    const { home, env, config } = await setup();
    await write(home, "queue.yaml", `
- { id: uses-repo, repo: app, prompt: p }
- { id: own-check, repo: app, prompt: p, done_when: "npx vitest run" }
- { id: unconfigured, repo: loose, prompt: p, done_when: "true" }
`);
    const q = await loadQueue(env, config);
    assert.deepEqual(q.tasks.map((t) => [t.id, t.check, t.repo.key]), [
      ["uses-repo", "npm test", "app"],
      ["own-check", "npx vitest run", "app"],
      ["unconfigured", "true", "loose"],
    ]);
  });

  it("skips a broken entry with a message that names the fix and keeps the rest", async () => {
    const { home, env, config } = await setup();
    await write(home, "queue.yaml", `
- { id: no-check, repo: loose, prompt: p }
- { id: bare-tool, repo: app, prompt: p, tools: [Read, curl] }
- { id: recurring, repo: app, prompt: p, kind: recurring }
- { id: dash, repo: app, prompt: "--help" }
- { id: typo, repo: app, prompt: p, prompts: x }
- { id: fine, repo: app, prompt: p }
`);
    const q = await loadQueue(env, config);
    assert.deepEqual(q.tasks.map((t) => t.id), ["fine"]);
    const byItem = new Map(q.problems.map((p) => [p.where, p.message]));
    assert.match(byItem.get("queue.yaml item 1") ?? "", /done_when/);
    assert.match(byItem.get("queue.yaml item 2") ?? "", /Bash\(curl \*\)/);
    assert.match(byItem.get("queue.yaml item 3") ?? "", /M2/);
    assert.match(byItem.get("queue.yaml item 4") ?? "", /flag/);
    assert.match(byItem.get("queue.yaml item 5") ?? "", /prompts/);
  });

  it("drops every copy of an id declared twice", async () => {
    const { home, env, config } = await setup();
    await write(home, "queue.yaml", "- { id: twin, repo: app, prompt: a }\n- { id: solo, repo: app, prompt: b }\n");
    await mkdir(path.join(home, "queue.d"));
    await write(home, "queue.d/twin.yaml", "repo: app\nprompt: c\n");
    const q = await loadQueue(env, config);
    assert.deepEqual(q.tasks.map((t) => t.id), ["solo"]);
    assert.ok(q.problems.some((p) => p.where === "task twin"));
  });

  it("loses only the source that is mid-save when its YAML is broken", async () => {
    const { home, env, config } = await setup();
    await write(home, "queue.yaml", "- id: half\n  repo: app\n  prompt: [unclosed\n");
    await mkdir(path.join(home, "queue.d"));
    await write(home, "queue.d/intact.yaml", "repo: app\nprompt: still here\n");
    const q = await loadQueue(env, config);
    assert.deepEqual(q.tasks.map((t) => t.id), ["intact"]);
    assert.deepEqual(q.problems.map((p) => p.where), ["queue.yaml"]);
  });

  it("rejects an id field inside a queue.d file", async () => {
    const { home, env, config } = await setup();
    await mkdir(path.join(home, "queue.d"));
    await write(home, "queue.d/named.yaml", "id: other\nrepo: app\nprompt: p\n");
    const q = await loadQueue(env, config);
    assert.deepEqual(q.tasks, []);
    assert.equal(q.problems[0]?.where, "queue.d/named.yaml");
  });
});

describe("addTask", () => {
  it("creates one queue.d file that loads back as the same task", async () => {
    const { home, app, env, config } = await setup();
    const added = await addTask(env, config, {
      prompt: "Refresh the README install section",
      repo: app,
      priority: "low",
      tools: ["Bash(npx eslint *)"],
      maxMinutes: 30,
    });
    assert.equal(added.kind, "added");
    if (added.kind !== "added") return;
    assert.match(added.task.id, /^refresh-the-readme-install-[a-z2-7]{4}$/);
    assert.equal(added.file, path.join(home, "queue.d", `${added.task.id}.yaml`));
    assert.deepEqual(await readdir(path.join(home, "queue.d")), [`${added.task.id}.yaml`]);

    const q = await loadQueue(env, config);
    const loaded = q.tasks.find((t) => t.id === added.task.id);
    assert.ok(loaded, "the added task is in the queue");
    assert.deepEqual(
      [loaded.prompt, loaded.priority, loaded.tools, loaded.maxMinutes, loaded.check, loaded.repo.key],
      ["Refresh the README install section", "low", ["Bash(npx eslint *)"], 30, "npm test", "app"],
    );
  });

  it("gives each add its own id", async () => {
    const { app, env, config } = await setup();
    const a = await addTask(env, config, { prompt: "same words", repo: app });
    const b = await addTask(env, config, { prompt: "same words", repo: app });
    assert.ok(a.kind === "added" && b.kind === "added" && a.task.id !== b.task.id);
  });

  it("writes nothing for an invalid task", async () => {
    const { home, loose, env, config } = await setup();
    const result = await addTask(env, config, { prompt: "no check here", repo: loose });
    assert.equal(result.kind, "invalid");
    assert.deepEqual(await readdir(path.join(home, "queue.d")), []);
  });
});
