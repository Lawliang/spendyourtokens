import { randomBytes } from "node:crypto";
import { link, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { isNotFound, realpathOrNull, resolveRepo, toAbsPath } from "./config.ts";
import type { Env } from "./config.ts";
import { isShellCommand, isTaskId, isToolPattern } from "./model.ts";
import type { AbsPath, Config, Priority, QueueProblem, Task, TaskId, TaskSource, ToolPattern } from "./model.ts";

export type Queue = {
  readonly tasks: readonly Task[];
  readonly problems: readonly QueueProblem[];
};

export async function loadQueue(env: Env, config: Config): Promise<Queue> {
  const problems: QueueProblem[] = [];
  const parsed: Task[] = [];

  const items = await readQueueYaml(env, problems);
  for (const [index, raw] of items.entries()) {
    const where = `queue.yaml item ${index + 1}`;
    const id = typeof field(raw, "id") === "string" ? (field(raw, "id") as string) : null;
    const result = await parseEntry(raw, { kind: "queue-file", index }, id, where, config, env);
    if ("where" in result) problems.push(result);
    else parsed.push(result);
  }

  const added: Task[] = [];
  const dir = path.join(env.home, "queue.d");
  for (const name of await readdirOrEmpty(dir)) {
    if (!name.endsWith(".yaml") || name.startsWith(".")) continue;
    const where = `queue.d/${name}`;
    const file = path.join(dir, name) as AbsPath;
    let raw: unknown;
    try {
      raw = YAML.parse(await readFile(file, "utf8"));
    } catch (e) {
      problems.push({ where, message: `not valid YAML: ${firstLine(e)}` });
      continue;
    }
    if (field(raw, "id") !== undefined) {
      problems.push({ where, message: "a queue.d file takes its id from its file name; remove the id field" });
      continue;
    }
    const addedRaw = field(raw, "added");
    const addedAt = typeof addedRaw === "string" && !Number.isNaN(Date.parse(addedRaw)) ? new Date(addedRaw) : null;
    const result = await parseEntry(raw, { kind: "added", file, addedAt }, name.slice(0, -".yaml".length), where, config, env);
    if ("where" in result) problems.push(result);
    else added.push(result);
  }
  added.sort((a, b) => addedTime(a) - addedTime(b) || a.id.localeCompare(b.id));

  const all = [...parsed, ...added];
  const counts = new Map<TaskId, number>();
  for (const t of all) counts.set(t.id, (counts.get(t.id) ?? 0) + 1);
  for (const [id, n] of counts) {
    if (n > 1) problems.push({ where: `task ${id}`, message: `declared ${n} times; give each task its own id` });
  }
  return { tasks: all.filter((t) => counts.get(t.id) === 1), problems };
}

function addedTime(t: Task): number {
  return t.source.kind === "added" && t.source.addedAt !== null ? t.source.addedAt.getTime() : Number.MAX_SAFE_INTEGER;
}

async function readQueueYaml(env: Env, problems: QueueProblem[]): Promise<readonly unknown[]> {
  let text: string;
  try {
    text = await readFile(path.join(env.home, "queue.yaml"), "utf8");
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    problems.push({ where: "queue.yaml", message: `not valid YAML: ${firstLine(e)}` });
    return [];
  }
  if (doc === null || doc === undefined) return [];
  if (!Array.isArray(doc)) {
    problems.push({ where: "queue.yaml", message: "must be a list of tasks" });
    return [];
  }
  return doc;
}

export type AddInput = {
  readonly prompt: string;
  readonly repo: AbsPath;
  readonly priority?: string;
  readonly tools?: readonly string[];
  readonly model?: string;
  readonly maxMinutes?: number;
  readonly doneWhen?: string;
};

export type AddResult =
  | { readonly kind: "added"; readonly task: Task; readonly file: AbsPath }
  | { readonly kind: "invalid"; readonly problems: readonly QueueProblem[] };

export async function addTask(env: Env, config: Config, input: AddInput): Promise<AddResult> {
  const doc: Record<string, unknown> = { added: env.now().toISOString(), repo: input.repo };
  if (input.priority !== undefined) doc.priority = input.priority;
  if (input.tools !== undefined && input.tools.length > 0) doc.tools = [...input.tools];
  if (input.model !== undefined) doc.model = input.model;
  if (input.maxMinutes !== undefined) doc.max_minutes = input.maxMinutes;
  if (input.doneWhen !== undefined) doc.done_when = input.doneWhen;
  doc.prompt = input.prompt;

  const dir = path.join(env.home, "queue.d");
  await mkdir(dir, { recursive: true });
  const taken = new Set((await readQueueYaml(env, [])).map((raw) => field(raw, "id")));
  const slug = slugOf(input.prompt);

  for (;;) {
    const id = `${slug}-${suffix()}`;
    if (!isTaskId(id)) throw new Error(`generated an invalid id: ${id}`);
    if (taken.has(id) || (await exists(path.join(env.home, "runs", id)))) continue;
    const file = path.join(dir, `${id}.yaml`) as AbsPath;
    const result = await parseEntry(doc, { kind: "added", file, addedAt: env.now() }, id, `syt add`, config, env);
    if ("where" in result) return { kind: "invalid", problems: [result] };

    const tmp = path.join(dir, `.${id}.yaml.tmp-${process.pid}`);
    await writeFile(tmp, YAML.stringify(doc));
    try {
      await link(tmp, file);
      return { kind: "added", task: result, file };
    } catch (e) {
      if ((e as { code?: unknown }).code !== "EEXIST") throw e;
    } finally {
      await unlink(tmp);
    }
  }
}

function slugOf(prompt: string): string {
  const words = prompt.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  let slug = "";
  for (const w of words.slice(0, 4)) {
    const next = slug === "" ? w : `${slug}-${w}`;
    if (next.length > 40) break;
    slug = next;
  }
  return slug === "" ? "task" : slug.slice(0, 40);
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function suffix(): string {
  return [...randomBytes(4)].map((b) => BASE32[b % 32]).join("");
}

const KEYS = new Set(["id", "repo", "prompt", "priority", "tools", "model", "max_minutes", "done_when", "kind", "added"]);
const PRIORITIES: readonly Priority[] = ["high", "normal", "low"];

async function parseEntry(
  raw: unknown,
  source: TaskSource,
  idHint: string | null,
  where: string,
  config: Config,
  env: Env,
): Promise<Task | QueueProblem> {
  const problem = (message: string): QueueProblem => ({ where, message });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return problem("must be a mapping with at least repo and prompt");
  const entry = raw as Record<string, unknown>;

  const unknown = Object.keys(entry).filter((k) => !KEYS.has(k) || (k === "added" && source.kind !== "added"));
  if (unknown.length > 0) return problem(`unknown key${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")}`);

  if (idHint === null) return problem("id is required");
  if (!isTaskId(idHint)) return problem(`id "${idHint}" must be lowercase letters, digits and inner hyphens, at most 64 characters`);

  if (entry.kind !== undefined && entry.kind !== "one-shot") {
    return problem(entry.kind === "recurring" ? "recurring tasks arrive in M2; use kind: one-shot or remove kind" : `kind must be one-shot`);
  }

  if (typeof entry.prompt !== "string" || entry.prompt.trim() === "") return problem("prompt is required");
  if (entry.prompt.trimStart().startsWith("-")) return problem("prompt can't start with '-', because claude would read it as a flag");

  if (typeof entry.repo !== "string" || entry.repo === "") return problem("repo is required");
  const repoPath = await realpathOrNull(toAbsPath(entry.repo, env.home));
  if (repoPath === null) return problem(`repo ${entry.repo} does not exist`);
  const repo = resolveRepo(config, repoPath);

  const priority = entry.priority ?? "normal";
  if (!PRIORITIES.includes(priority as Priority)) return problem(`priority must be high, normal or low`);

  const toolsRaw = entry.tools ?? [];
  if (!Array.isArray(toolsRaw)) return problem("tools must be a list");
  const tools: ToolPattern[] = [];
  for (const [i, t] of toolsRaw.entries()) {
    if (typeof t !== "string" || !isToolPattern(t)) {
      const hint = typeof t === "string" && !t.includes("(") ? ` (try "Bash(${t} *)")` : "";
      return problem(`tools[${i}] ${JSON.stringify(t)} is not a tool pattern${hint}`);
    }
    tools.push(t);
  }

  if (entry.model !== undefined && (typeof entry.model !== "string" || entry.model.trim() === "")) return problem("model must be a model name or default");
  const model = entry.model === undefined || entry.model === "default" ? null : (entry.model as string);

  const maxRaw = entry.max_minutes ?? config.limits.defaultMaxMinutes;
  if (typeof maxRaw !== "number" || !Number.isInteger(maxRaw) || maxRaw < 1 || maxRaw > 600) return problem("max_minutes must be a whole number from 1 to 600");

  if (entry.done_when !== undefined && (typeof entry.done_when !== "string" || !isShellCommand(entry.done_when))) {
    return problem("done_when must be a shell command");
  }
  const check = (entry.done_when as string | undefined) ?? repo.commands.test;
  if (check === null || !isShellCommand(check)) {
    return problem(
      config.repos.some((r) => r.path === repo.path)
        ? `no done check. Add done_when, or test = "..." under [repos.${repo.key}]`
        : `no done check. Add done_when (write done_when: "true" to skip the check), or configure the repo under [repos.<name>] with a test command`,
    );
  }

  return { id: idHint, repo, prompt: entry.prompt, priority: priority as Priority, tools, model, maxMinutes: maxRaw, check, source };
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
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

function firstLine(e: unknown): string {
  return String((e as Error).message ?? e).split("\n")[0] ?? "";
}
