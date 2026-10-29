# spendyourtokens

Spends what's left of your Claude plan on work you queued, and never what you'll need.

Claude subscription plans meter Claude Code in a 5-hour session window and a weekly window. Usage you don't spend before a reset is gone. `syt` keeps a queue of tasks you wrote, runs them in headless Claude Code sessions, and stops before your reserves. Each task works on its own git branch. You review the branches and the report, and you decide what to merge.

This is pre-release software at milestone M1. It runs only when you type `syt run --now`. Scheduled spending before the weekly reset arrives in M2.

## Requirements

- macOS.
- Node.js 22.18 or later.
- Claude Code, on your `PATH` as `claude`, logged in with a Claude subscription. `syt` was verified against Claude Code 2.1.312. It refuses to run on an API key.
- git.

## Install

`syt` is not on npm yet. Install it from a checkout.

```sh
git clone <this repo> spendyourtokens
cd spendyourtokens
npm install
npm run build
npm link
```

`npm link` puts the `syt` command on your `PATH`.

## Run your first task

1. Tell `syt` about a repo and its test command. Create `~/.spendyourtokens/config.toml`.

   ```toml
   [repos.app]
   path = "~/code/app"
   test = "npm test"
   ```

2. Queue a task from inside the repo.

   ```sh
   cd ~/code/app
   syt add "Add unit tests for src/parser covering the error paths"
   ```

3. Check your usage and what would run.

   ```sh
   syt status
   ```

4. Spend.

   ```sh
   syt run --now
   ```

5. Review the result.

   ```sh
   syt report
   git log syt/<task-id>
   ```

The task's work is on the branch `syt/<task-id>`. Your own checkout is not touched. Merge the branch, or delete it.

## Commands

| Command | What it does |
| --- | --- |
| `syt add "<prompt>"` | Adds a task to the queue. |
| `syt queue` | Lists tasks in run order, with their status. |
| `syt status` | Shows the login, both usage windows, the last spend, and what would run next. |
| `syt run --now [--task <id>]` | Spends now, down to your reserves. |
| `syt report [--since <when>]` | Lists one row per attempt, failures first. |

`syt add` takes these flags.

- `--repo <path>` names the repo. The default is the git repo that contains the current directory.
- `--priority high|normal|low` sets the priority. The default is `normal`.
- `--tools <rule>` allows one more Claude Code tool. Repeat the flag for more tools.
- `--model <name>` picks the model. The default is Claude Code's default.
- `--max-minutes <n>` caps the task's run time. The default is `max_minutes` from `config.toml`.
- `--done-when <command>` sets the done check. The default is the repo's `test` command.

`syt run --now --task <id>` runs only that task. It also runs a flagged task, which is how you give a task another try. It never skips the login check, the reserves, or the clean-checkout check.

`syt report --since` takes `7d`, `24h`, `90m`, or a date such as `2026-10-01`. The default is `7d`.

Every command exits with one of these codes.

| Code | Meaning |
| --- | --- |
| 0 | OK. A spend that stopped at a reserve is a normal ending. |
| 1 | Refused. The login is not a subscription, or `/usage` can't be read. |
| 2 | Bad input, such as an unknown flag, an invalid task, or a problem in `config.toml`. |
| 3 | Another spend is running. |

## config.toml

`syt` reads `~/.spendyourtokens/config.toml`. Every key is optional. An unknown key is an error, so a typo can't fall back to a default without you noticing. `syt` reports every problem in the file at once.

```toml
concurrency = 2              # tasks at once, 1 to 4
max_minutes = 60             # default time cap per task, 1 to 600

[reserves]
session_pct = 15             # never spend the last 15% of the session window
week_pct = 5                 # never spend the last 5% of the week
start_margin_pts = 5         # no new task within 5 points of either reserve
reset_guard_minutes = 5      # stop running tasks 5 minutes before either window resets
start_runway_minutes = 15    # no new task within 15 minutes of either reset

[repos.app]                  # "app" names the repo's worktree folder
path = "~/code/app"          # required. ~ expands. A relative path starts at ~/.spendyourtokens
test = "npm test"            # the default done check
lint = "npm run lint"
build = "npm run build"
```

The `test`, `lint`, and `build` commands are the shell commands an agent may run in that repo. Each becomes two allowed tools, `Bash(npm test)` and `Bash(npm test *)`.

A task can also name a repo that has no `[repos.<name>]` section. That task gets only the default tools and needs its own `done_when`.

## The queue

You declare tasks in two places. `syt` reads both and never rewrites either.

- `~/.spendyourtokens/queue.yaml` is a list you edit by hand.
- `~/.spendyourtokens/queue.d/<id>.yaml` holds one task each. `syt add` creates these files. The file name is the task's id.

Two sources mean `syt add` never writes a file your editor has open.

```yaml
- id: parser-tests
  repo: ~/code/app
  prompt: |
    Add unit tests for src/parser covering the error paths.
    Don't change src/.
  priority: high                  # high, normal, or low
  tools: ["Bash(npx vitest *)"]   # added to the default tools
  model: claude-sonnet-5          # or default
  max_minutes: 45
  done_when: npx vitest run src/parser
```

These are the keys.

| Key | Required | Meaning |
| --- | --- | --- |
| `id` | In `queue.yaml` only | Lowercase letters, digits, and inner hyphens, up to 64 characters. The id names the branch `syt/<id>`. |
| `repo` | Yes | The repo's path. |
| `prompt` | Yes | What the agent should do. It can't start with `-`. |
| `priority` | No | `high`, `normal`, or `low`. |
| `tools` | No | Claude Code permission rules added to the defaults, such as `WebFetch` or `Bash(curl *)`. |
| `model` | No | A model name, or `default`. |
| `max_minutes` | No | The task's time cap, 1 to 600. |
| `done_when` | No | The done check, a shell command. The default is the repo's `test` command. |
| `kind` | No | Only `one-shot` in M1. |

Every task needs a done check. If a task has no `done_when` and its repo has no `test` command, `syt` skips the task and tells you how to fix it. Write `done_when: "true"` to run a task with no check.

A broken entry doesn't stop the others. `syt queue` lists each problem with its file and item number.

A task's id is the key to its history. To run a passed task again, give it a new id.

## How a spend works

`syt run --now` first checks the login with `claude auth status`. It then reads both usage windows with `claude -p "/usage"`, which costs no tokens. Then it starts tasks in run order, up to `concurrency` at once.

The run order puts resumes of partial work first. Fresh tasks come next, by priority and then by the order you declared them. Retries of failed or errored tasks come last. Each task runs at most once per spend. `syt` reads the queue again each time a slot frees up, so a task you add mid-run can still start.

A new task starts only when all of these hold:

- both windows have a reading from the last 10 minutes,
- neither window resets within `start_runway_minutes`,
- the session is below `100 - session_pct - start_margin_pts` percent used (80% by default),
- the week is below `100 - week_pct - start_margin_pts` percent used (90% by default),
- and, for a fresh task, the repo's checkout has no uncommitted changes to tracked files. Untracked files don't count. A resume runs in its own worktree, so it doesn't need a clean checkout.

A running task stops at its next turn boundary when any of these happens:

- either window is within `reset_guard_minutes` of its reset,
- the session reaches `100 - session_pct` percent used, or the week reaches `100 - week_pct`,
- the task reaches its `max_minutes`,
- `/usage` can't be read or parsed,
- or you press Ctrl-C.

A second Ctrl-C kills running tasks at once. Between `/usage` reads, `syt` updates usage from the `rate_limit_event` lines in each task's stream.

After the agent stops, `syt` commits all of the task's changes to `syt/<task-id>`. Then it runs the done check itself and records one outcome.

| Outcome | Meaning |
| --- | --- |
| `passed` | The agent finished and the done check exited 0. |
| `failed` | The agent finished and the done check failed or timed out. |
| `partial` | A stop rule stopped the agent. The work so far is on the branch. |
| `no-op` | The agent finished without changing anything. The check doesn't run. |
| `errored` | The agent crashed, reported an error, or was refused at start. |

The next spend continues unfinished work.

- A partial task resumes first, with `claude --resume` in the same worktree. After two resumes, it is flagged.
- A failed task gets one retry in the same session. The retry prompt includes the end of the check's output. After a second failure, it is flagged.
- An errored task gets one retry. After a second error, it is flagged.

`syt queue` shows flagged tasks. Run `syt run --now --task <id>` to give one another try.

If `syt` itself dies mid-task, the next spend recovers the task. If the agent had already exited, `syt` commits its work and runs the check without starting a new agent. Otherwise the task resumes in the same worktree. The next spend also stops any `claude` process that a dead spend left running.

## Safety guarantees

These hold for every task `syt` runs.

- **Subscription only.** `syt` refuses to spend unless `claude auth status` reports a claude.ai login. It kills an agent before its first turn if the agent's `init` event reports any `apiKeySource` other than `none`. It halts the spend if `/usage` ever reports a cost. It never strips an API key from your environment. It refuses instead.
- **Least privilege.** Agents run with `--permission-mode dontAsk`, so a tool outside the allowlist is denied and the run carries on. The allowlist is `Read`, `Glob`, `Grep`, `Edit`, and `Write`, plus the repo's `test`, `lint`, and `build` commands, plus the task's own `tools`. Network tools are off unless a task lists them.
- **No outward actions.** `Bash(git push*)` and `Bash(gh *)` are always denied. `syt` never pushes, merges, or opens a pull request.
- **No bypasses.** `syt` never passes `--bare` or `--dangerously-skip-permissions`. Every flag it passes to `claude` is fixed in the source.
- **Your settings stay out.** Agents run with `--setting-sources project,local`, which skips your user settings, hooks, and plugins. A repo's own checked-in `.claude/settings.json` still applies.
- **Your checkout stays untouched.** Each task works in `~/.spendyourtokens/worktrees/<repo>/<task-id>` on the branch `syt/<task-id>`. `syt` commits there with git hooks off. If a directory is in the way of a worktree, `syt` reports a conflict instead of deleting it.
- **Your reserves stay yours.** `/usage` counts claude.ai, the desktop app, and your other machines, so the reserves protect usage you spend anywhere.
- **One spend at a time.** A second `syt run` exits with code 3 while one is running.
- **A full audit trail.** Every task keeps its raw stream log, its stderr, its done-check output, and a record with the exact `claude` command line.

## Files

Everything lives under `~/.spendyourtokens`. Set `SYT_HOME` to use another directory.

```
config.toml                    you write it
queue.yaml                     you write it
queue.d/<id>.yaml              syt add creates it, then it's yours
spends/<n>.json                one record per syt run
runs/<task-id>/<n>.json        one record per attempt
logs/<task-id>/<n>.jsonl       the raw claude stream
logs/<task-id>/<n>.stderr.log  claude's stderr
logs/<task-id>/<n>.check.log   the done check's output
worktrees/<repo>/<task-id>/    the task's git worktree
```

Each record has one writer. `syt` works out every status from these records when you ask, so a crash leaves nothing to repair.

`SYT_CLAUDE_BIN` replaces the `claude` binary. The tests use it to run a fake `claude` that replays recorded sessions.

## Plan terms

`syt` runs your own `claude` binary with your own login. It never reads a login token and never handles a login. It uses only `claude -p` and `claude -p "/usage"`.

Anthropic's [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) say plan limits assume ordinary, individual usage. The defaults keep to one user and one account, and they keep reserves for your own work. Read the terms before you raise the reserves or the concurrency.

## Development

```sh
npm run typecheck
npm test
npm run build
```

The tests never run the real `claude`. They use `test/fake-claude.ts`, which replays the recorded sessions in `test/fixtures`. `docs/m0-findings.md` records how those sessions were captured.

## License

MIT
