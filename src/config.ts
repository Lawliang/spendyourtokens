/**
 * The process's surroundings (Env) and the user's settings (Config).
 *
 * Env is built once in cli.ts from process.env. Tests build their own, with a temp home, a fake
 * claude and short timings. Nothing else reads process.env.
 */

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { isRepoKey, isShellCommand, percentOrThrow } from "./model.ts";
import type { AbsPath, Config, Limits, Repo, RepoKey, ShellCommand } from "./model.ts";

export type Timing = {
  /** Re-read `/usage` this often while a spend runs. */
  readonly usagePollMs: number;
  /** Before a new start, re-read `/usage` if the last probe is older than this. */
  readonly usageFreshMs: number;
  /** A window reading older than this is unknown. */
  readonly maxReadingAgeMs: number;
  /** Re-check time-based stop rules for agents that haven't reached a turn boundary. */
  readonly tickMs: number;
  /** After a stop request, wait this long for a turn boundary, then stop anyway. */
  readonly stopGraceMs: number;
  /** SIGTERM, then SIGKILL after this long. */
  readonly killGraceMs: number;
  /** Kill the agent if `init` hasn't arrived by now. */
  readonly initTimeoutMs: number;
  readonly probeTimeoutMs: number;
  readonly checkTimeoutMs: number;
};

export const DEFAULT_TIMING: Timing = {
  usagePollMs: 5 * 60_000,
  usageFreshMs: 60_000,
  maxReadingAgeMs: 10 * 60_000,
  tickMs: 15_000,
  stopGraceMs: 2 * 60_000,
  killGraceMs: 10_000,
  initTimeoutMs: 60_000,
  probeTimeoutMs: 60_000,
  checkTimeoutMs: 10 * 60_000,
};

export type Env = {
  /** `SYT_HOME`, else `~/.spendyourtokens`. */
  readonly home: AbsPath;
  /** `SYT_CLAUDE_BIN`, else `claude` on PATH. */
  readonly claudeBin: string;
  readonly now: () => Date;
  readonly timing: Timing;
  /** The environment every child process gets, passed through untouched. */
  readonly vars: Readonly<Record<string, string | undefined>>;
};

/** A relative SYT_HOME is an error, not a guess. */
export function envFromProcess(vars: Readonly<Record<string, string | undefined>>): Env {
  const raw = vars.SYT_HOME;
  const expanded = raw === undefined || raw === "" ? path.join(os.homedir(), ".spendyourtokens") : expandTilde(raw);
  if (!path.isAbsolute(expanded)) throw new Error(`SYT_HOME must be an absolute path, got "${raw}"`);
  return {
    home: path.resolve(expanded) as AbsPath,
    claudeBin: vars.SYT_CLAUDE_BIN || "claude",
    now: () => new Date(),
    timing: DEFAULT_TIMING,
    vars,
  };
}

function expandTilde(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

/** Expands `~`, resolves a relative path against `base`, and normalizes. */
export function toAbsPath(input: string, base: AbsPath): AbsPath {
  return path.resolve(base, expandTilde(input)) as AbsPath;
}

export const DEFAULT_LIMITS: Limits = {
  concurrency: 2,
  sessionReservePct: percentOrThrow(15),
  weekReservePct: percentOrThrow(5),
  startMarginPts: 5,
  resetGuardMinutes: 5,
  startRunwayMinutes: 15,
  defaultMaxMinutes: 60,
};

export type ConfigLoad =
  | { readonly kind: "ok"; readonly config: Config }
  | { readonly kind: "invalid"; readonly file: AbsPath; readonly problems: readonly string[] };

const TOP_KEYS = ["concurrency", "max_minutes", "reserves", "repos"];
const REPO_KEYS = ["path", "test", "lint", "build"];

type NumberRule = { readonly min: number; readonly max: number; readonly integer: boolean };
const RESERVE_RULES: Readonly<Record<string, NumberRule>> = {
  session_pct: { min: 0, max: 50, integer: false },
  week_pct: { min: 0, max: 50, integer: false },
  start_margin_pts: { min: 0, max: 20, integer: false },
  reset_guard_minutes: { min: 0, max: 60, integer: true },
  start_runway_minutes: { min: 0, max: 120, integer: true },
};

/**
 * Parses `<home>/config.toml`. A missing file gives defaults and no repos. Strict: unknown keys,
 * out-of-range numbers, and two repos with the same path are problems, all reported at once.
 */
export async function loadConfig(env: Env): Promise<ConfigLoad> {
  const file = path.join(env.home, "config.toml") as AbsPath;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (isNotFound(e)) return { kind: "ok", config: { limits: DEFAULT_LIMITS, repos: [] } };
    throw e;
  }

  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text);
  } catch (e) {
    return { kind: "invalid", file, problems: [`not valid TOML: ${(e as Error).message.split("\n")[0]}`] };
  }

  const problems: string[] = [];
  for (const key of Object.keys(doc)) if (!TOP_KEYS.includes(key)) problems.push(`unknown key "${key}"`);

  const num = (where: string, value: unknown, rule: NumberRule, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < rule.min || value > rule.max || (rule.integer && !Number.isInteger(value))) {
      problems.push(`${where} must be ${rule.integer ? "a whole number" : "a number"} from ${rule.min} to ${rule.max}`);
      return fallback;
    }
    return value;
  };

  const concurrency = num("concurrency", doc.concurrency, { min: 1, max: 4, integer: true }, DEFAULT_LIMITS.concurrency) as Limits["concurrency"];
  const defaultMaxMinutes = num("max_minutes", doc.max_minutes, { min: 1, max: 600, integer: true }, DEFAULT_LIMITS.defaultMaxMinutes);

  const reserves = table(doc.reserves, "reserves", problems);
  for (const key of Object.keys(reserves)) if (!(key in RESERVE_RULES)) problems.push(`unknown key "reserves.${key}"`);
  const reserve = (key: string, fallback: number) => num(`reserves.${key}`, reserves[key], RESERVE_RULES[key] as NumberRule, fallback);
  const limits: Limits = {
    concurrency,
    defaultMaxMinutes,
    sessionReservePct: percentOrThrow(reserve("session_pct", DEFAULT_LIMITS.sessionReservePct)),
    weekReservePct: percentOrThrow(reserve("week_pct", DEFAULT_LIMITS.weekReservePct)),
    startMarginPts: reserve("start_margin_pts", DEFAULT_LIMITS.startMarginPts),
    resetGuardMinutes: reserve("reset_guard_minutes", DEFAULT_LIMITS.resetGuardMinutes),
    startRunwayMinutes: reserve("start_runway_minutes", DEFAULT_LIMITS.startRunwayMinutes),
  };

  const repos: Repo[] = [];
  for (const [key, raw] of Object.entries(table(doc.repos, "repos", problems))) {
    const where = `repos.${key}`;
    if (!isRepoKey(key)) {
      problems.push(`[${where}]: a repo name may use letters, digits, ".", "_" and "-"`);
      continue;
    }
    const entry = table(raw, where, problems);
    for (const k of Object.keys(entry)) if (!REPO_KEYS.includes(k)) problems.push(`unknown key "${where}.${k}"`);
    if (typeof entry.path !== "string" || entry.path === "") {
      problems.push(`${where}.path is required`);
      continue;
    }
    const real = await realpathOrNull(toAbsPath(entry.path, env.home));
    if (real === null) {
      problems.push(`${where}.path: ${entry.path} does not exist`);
      continue;
    }
    const command = (k: string): ShellCommand | null => {
      const v = entry[k];
      if (v === undefined) return null;
      if (typeof v === "string" && isShellCommand(v)) return v;
      problems.push(`${where}.${k} must be a non-empty command`);
      return null;
    };
    const dup = repos.find((r) => r.path === real);
    if (dup) problems.push(`${where}.path is the same repo as repos.${dup.key}`);
    repos.push({ key, path: real, commands: { test: command("test"), lint: command("lint"), build: command("build") } });
  }

  return problems.length > 0 ? { kind: "invalid", file, problems } : { kind: "ok", config: { limits, repos } };
}

function table(value: unknown, where: string, problems: string[]): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)) return value as Record<string, unknown>;
  problems.push(`${where} must be a table`);
  return {};
}

/**
 * The Repo a task's realpath names. An unconfigured repo gets its basename as key, suffixed with
 * a short hash when that collides with a configured key, and no commands.
 */
export function resolveRepo(config: Config, realRepoPath: AbsPath): Repo {
  const configured = config.repos.find((r) => r.path === realRepoPath);
  if (configured) return configured;
  const base = path.basename(realRepoPath).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "") || "repo";
  const hash = createHash("sha1").update(realRepoPath).digest("hex").slice(0, 6);
  const plain = base.slice(0, 56);
  const key = config.repos.some((r) => r.key === plain) || !isRepoKey(plain) ? `${plain}-${hash}` : plain;
  return { key: key as RepoKey, path: realRepoPath, commands: { test: null, lint: null, build: null } };
}

export async function realpathOrNull(p: string): Promise<AbsPath | null> {
  try {
    return (await realpath(p)) as AbsPath;
  } catch {
    return null;
  }
}

export function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT";
}
