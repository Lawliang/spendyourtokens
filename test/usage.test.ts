import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { mergeUpdate, parseUsageText, readRateLimitInfo, readWindow, sameWindow } from "../src/usage.ts";
import { percentOrThrow } from "../src/model.ts";
import type { UsageSnapshot } from "../src/model.ts";

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const NOW = new Date("2026-10-28T19:00:00-07:00");
const BANNER = "You are currently using your subscription to power your Claude Code usage";
const WEEK = "Current week (all models): 22% used · resets Oct 29 at 8:59pm (America/Los_Angeles)";
const SESSION = "Current session: 6% used · resets Oct 28 at 10:19pm (America/Los_Angeles)";

function report(...windowLines: string[]): string {
  return [BANNER, "", ...windowLines, "", "What's contributing to your usage?", "  73%  Start fresh"].join("\n");
}

function ok(text: string, now = NOW): UsageSnapshot {
  const parsed = parseUsageText(text, now);
  assert.equal(parsed.kind, "ok", `expected ok, got ${JSON.stringify(parsed)}`);
  if (parsed.kind !== "ok") throw new Error("unreachable");
  return parsed.snapshot;
}

describe("parseUsageText", () => {
  it("reads the real subscription report", async () => {
    const snap = ok(await fixture("usage/subscription-max.txt"));
    assert.equal(snap.session.kind, "open");
    if (snap.session.kind !== "open") return;
    assert.equal(snap.session.usedPct, 6);
    assert.equal(snap.session.resetsAt.toISOString(), "2026-10-29T05:19:00.000Z");
    assert.equal(snap.week.usedPct, 22);
    assert.equal(snap.week.resetsAt.toISOString(), "2026-10-30T03:59:00.000Z");
    assert.deepEqual(
      snap.modelWeeks.map((m) => [m.model, m.window.usedPct, m.window.resetsAt.toISOString()]),
      [["Fable", 0, "2026-10-30T04:00:00.000Z"]],
    );
  });

  it("reports the real API-key cost summary as not-subscription", async () => {
    assert.deepEqual(parseUsageText(await fixture("usage/api-key.txt"), NOW), { kind: "not-subscription" });
  });

  it("calls a missing banner without the cost signature unrecognized", () => {
    const parsed = parseUsageText("Welcome to Claude\n" + SESSION + "\n" + WEEK, NOW);
    assert.deepEqual(parsed, { kind: "unrecognized", reason: "missing-banner", line: "Welcome to Claude" });
  });

  it("accepts both 9pm and 8:59pm", () => {
    const at = (when: string) => ok(report(SESSION, `Current week (all models): 1% used · resets ${when}`)).week.resetsAt.toISOString();
    assert.equal(at("Oct 29 at 9pm (America/Los_Angeles)"), "2026-10-30T04:00:00.000Z");
    assert.equal(at("Oct 29 at 8:59pm (America/Los_Angeles)"), "2026-10-30T03:59:00.000Z");
    assert.equal(at("Oct 29 at 12am (America/Los_Angeles)"), "2026-10-29T07:00:00.000Z");
    assert.equal(at("Oct 29 at 12pm (America/Los_Angeles)"), "2026-10-29T19:00:00.000Z");
  });

  it("rolls a January reset read in December into the next year", () => {
    const snap = ok(
      report("Current session: 1% used", "Current week (all models): 1% used · resets Jan 2 at 9am (America/Los_Angeles)"),
      new Date("2026-12-30T12:00:00-08:00"),
    );
    assert.equal(snap.week.resetsAt.toISOString(), "2027-01-02T17:00:00.000Z");
  });

  it("keeps a reset that passed within the last hour, and rolls an older one a year ahead", () => {
    const text = report(SESSION, WEEK);
    const justAfter = ok(text, new Date("2026-10-28T22:30:00-07:00"));
    assert.equal(justAfter.session.kind === "open" && justAfter.session.resetsAt.toISOString(), "2026-10-29T05:19:00.000Z");
    const hoursAfter = ok(text, new Date("2026-10-28T23:30:00-07:00"));
    assert.equal(hoursAfter.session.kind === "open" && hoursAfter.session.resetsAt.toISOString(), "2027-10-29T05:19:00.000Z");
  });

  it("resolves other zones and DST edges", () => {
    const at = (when: string, now = NOW) =>
      ok(report(SESSION, `Current week (all models): 1% used · resets ${when}`), now).week.resetsAt.toISOString();
    assert.equal(at("Oct 29 at 9pm (Europe/London)"), "2026-10-29T21:00:00.000Z", "London is back on GMT after Oct 25");
    assert.equal(at("Oct 29 at 9:30am (Asia/Kolkata)"), "2026-10-29T04:00:00.000Z");
    assert.equal(at("Nov 1 at 1:30am (America/Los_Angeles)"), "2026-11-01T08:30:00.000Z", "a repeated wall time takes the earlier instant");
    assert.equal(
      at("Mar 14 at 2:30am (America/Los_Angeles)", new Date("2027-01-15T12:00:00Z")),
      "2027-03-14T10:30:00.000Z",
      "a skipped wall time lands after the gap",
    );
  });

  it("rejects an unknown zone", () => {
    const parsed = parseUsageText(report(SESSION, "Current week (all models): 1% used · resets Oct 29 at 9pm (Mars/Olympus)"), NOW);
    assert.equal(parsed.kind === "unrecognized" && parsed.reason, "unknown-time-zone");
  });

  it("reads a session line with no reset clause as no open window", () => {
    const snap = ok(report("Current session: 0% used", WEEK));
    assert.deepEqual(snap.session, { kind: "none", usedPct: 0, observedAt: NOW });
  });

  it("requires the session and all-models week lines", () => {
    const noSession = parseUsageText(report(WEEK), NOW);
    assert.equal(noSession.kind === "unrecognized" && noSession.reason, "missing-session-line");
    const noWeek = parseUsageText(report(SESSION, "Current week (Fable): 0% used · resets Oct 29 at 9pm (America/Los_Angeles)"), NOW);
    assert.equal(noWeek.kind === "unrecognized" && noWeek.reason, "missing-week-line");
  });

  it("fails on any off-grammar Current line instead of skipping it", () => {
    for (const line of [
      "Current session: 6% used · resets soon",
      "Current session: 6.5% used · resets Oct 28 at 10:19pm (America/Los_Angeles)",
      "Current session: 101% used",
      "Current month: 3% used · resets Nov 1 at 9pm (America/Los_Angeles)",
      "Current week (all models): 22% used",
      "Current week (all models): 22% used · resets Oct 29 at 21:00 (America/Los_Angeles)",
      "Current week (all models): 22% used · resets Sept 29 at 9pm (America/Los_Angeles)",
    ]) {
      const parsed = parseUsageText(report(SESSION, WEEK, line), NOW);
      assert.deepEqual(parsed, { kind: "unrecognized", reason: "malformed-window-line", line }, line);
    }
  });

  it("fails on a duplicated window line", () => {
    const parsed = parseUsageText(report(SESSION, WEEK, WEEK), NOW);
    assert.equal(parsed.kind === "unrecognized" && parsed.reason, "malformed-window-line");
  });

  it("ignores the breakdown, whatever it says", async () => {
    const real = await fixture("usage/subscription-max.txt");
    const edited = real.replace(/What's contributing[\s\S]*$/, "What's new\n  Current tip: 99% of nothing\n  12%  Something else\n");
    assert.deepEqual(ok(edited), ok(real));
  });
});

describe("readRateLimitInfo", () => {
  it("reads both windows from a real stream event", async () => {
    const stream = await fixture("stream/task-allowlist.jsonl");
    const line = stream.split("\n").find((l) => l.includes('"rate_limit_event"'));
    assert.ok(line, "fixture has a rate_limit_event");
    const update = readRateLimitInfo(JSON.parse(line).rate_limit_info, NOW);
    assert.deepEqual(update, {
      session: { usedPct: 6, resetsAt: new Date(1793251200 * 1000), observedAt: NOW },
      week: { usedPct: 22, resetsAt: new Date(1793332800 * 1000), observedAt: NOW },
    });
  });

  it("drops unreadable windows and returns null when nothing is readable", () => {
    const partial = readRateLimitInfo({ unifiedWindows: { five_hour: { utilization: 0.5 }, seven_day: { utilization: 0.3, resetsAt: 1793332800 } } }, NOW);
    assert.equal(partial?.session, null);
    assert.equal(partial?.week?.usedPct, 30);
    assert.equal(readRateLimitInfo({ status: "allowed" }, NOW), null);
    assert.equal(readRateLimitInfo("garbage", NOW), null);
  });
});

describe("windows", () => {
  it("treats the text and stream readings of one reset as the same window", async () => {
    const snap = ok(await fixture("usage/subscription-max.txt"));
    assert.ok(snap.session.kind === "open" && sameWindow(snap.session, { resetsAt: new Date(1793251200 * 1000) }));
    assert.ok(sameWindow(snap.week, { resetsAt: new Date(1793332800 * 1000) }));
    assert.ok(!sameWindow(snap.week, { resetsAt: new Date(snap.week.resetsAt.getTime() + 5 * 3600_000) }));
  });

  it("opens a none session when the stream reports one", () => {
    const snap = ok(report("Current session: 0% used", WEEK));
    const later = new Date(NOW.getTime() + 60_000);
    const merged = mergeUpdate(snap, { session: { usedPct: percentOrThrow(2), resetsAt: new Date(NOW.getTime() + 5 * 3600_000), observedAt: later }, week: null });
    assert.equal(merged.session.kind, "open");
    assert.equal(merged.week, snap.week);
    assert.equal(merged.probedAt, snap.probedAt);
  });

  it("reads a stale or rolled-over window as unknown", () => {
    const snap = ok(report(SESSION, WEEK));
    const tenMin = 10 * 60_000;
    assert.equal(readWindow(snap, "session", new Date(NOW.getTime() + tenMin), tenMin).kind, "open");
    assert.deepEqual(readWindow(snap, "week", new Date(NOW.getTime() + tenMin + 1), tenMin), { kind: "unknown", why: "stale" });
    const pastReset = new Date("2026-10-28T22:20:00-07:00");
    assert.deepEqual(readWindow(snap, "session", pastReset, 4 * 3600_000), { kind: "unknown", why: "rolled-over" });
    assert.equal(readWindow(ok(report("Current session: 3% used", WEEK)), "session", NOW, tenMin).kind, "none");
  });
});
