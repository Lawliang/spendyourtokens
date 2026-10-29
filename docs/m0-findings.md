# M0 findings

M0 asked two things before any runner code exists. Does `claude -p` spend the subscription, and can a script read both usage windows reliably? Both answers are yes on Claude Code 2.1.312, checked on 2026-10-28. The fixtures under `test/fixtures/` are the raw output of these probes, with personal paths replaced.

## `claude -p` uses the subscription login

Three signals agree, and none of them reads a token.

| Signal | Subscription | API key in the environment |
| --- | --- | --- |
| `claude auth status --json`, field `authMethod` | `"claude.ai"`, plus `subscriptionType` | `"api_key"`, plus `apiKeySource: "ANTHROPIC_API_KEY"` |
| `init` event of a `claude -p --output-format stream-json --verbose` run, field `apiKeySource` | `"none"` | the key's source |
| First line of `claude -p "/usage"` | `You are currently using your subscription to power your Claude Code usage` | a cost summary with no windows at all |

`syt` checks `authMethod` before it spends anything. It also aborts a task whose `init` event reports any `apiKeySource` other than `"none"`. Setting `ANTHROPIC_API_KEY` flips both signals, so either one alone would catch it.

## `/usage` parses and costs nothing

`claude -p "/usage" --output-format json` returns `total_cost_usd: 0`, `num_turns: 0`, and the report text in `result`. It takes about 5 seconds of wall time. The lines that matter:

```
Current session: 6% used · resets Oct 28 at 10:19pm (America/Los_Angeles)
Current week (all models): 22% used · resets Oct 29 at 8:59pm (America/Los_Angeles)
Current week (Fable): 0% used · resets Oct 29 at 9pm (America/Los_Angeles)
```

Things a strict parser has to handle:

- Reset times appear both as `9pm` and as `8:59pm`. The weekly reset moved from 9pm to 8:59pm between two reads on the same day.
- Dates carry no year. The parser picks the first matching date at or after now, so a December read of a January reset lands in the next year.
- Every time carries an IANA zone name in parentheses.
- Everything after the window lines is a usage breakdown that changes between reads. The parser ignores it.
- Under an API key the output has no window lines. The parser rejects it, which is a second guard on top of `authMethod`.

Not yet observed: the session line when no 5-hour window is open. The parser accepts `Current session: N% used` without a reset clause as "no window open" and rejects any other shape.

## Headless runs need `dontAsk`, not `default`

The design doc's runner command passes `--permission-mode default`. Claude Code 2.1.312 lists the modes `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk` and `plan`. With `--permission-mode dontAsk --permission-prompts none`, tools outside `--allowedTools` are denied and the run carries on. Denials show up in the `result` event's `permission_denials`. Claude Code's built-in read-only commands such as `ls` still run without being listed.

## Headless runs skip your user settings

A plain `claude -p` loads `~/.claude/settings.json`. On the author's machine that means 14 hooks, 13 plugins and `defaultMode: bypassPermissions`. A `PermissionRequest` or `PreToolUse` hook can approve tools outside the allowlist, and plugins add context to every request.

`--setting-sources project,local` drops the user file. In the probes, hook events fell from 6 to 0 and input tokens fell from about 135k to 42k across the run. The two probe prompts differed, so that ratio is indicative, not measured like for like. Login is unaffected, since auth does not live in settings.

## `--resume` keeps the session

`claude -p "<prompt>" --resume <session_id>` continues with the earlier context and reports the same `session_id`. It has to run from the same working directory, because sessions are stored per project folder. Partial tasks resume from their own worktree.

## Plan terms

- The Agent SDK docs say third parties may not offer claude.ai login without approval. `syt` never handles a login. It runs the user's own `claude` binary.
- Anthropic's support article, updated 2026-10-07, says `claude -p` draws from subscription limits.
- The consumer terms say limits "assume ordinary, individual usage". `syt` defaults to one user, one account, spending only before the weekly reset, and it never reads login tokens.
