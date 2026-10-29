/**
 * Runs `syt` in its own process, like the bin, but on a clock that starts at SYT_TEST_START, so
 * a test can SIGKILL a real spend mid-attempt while the fixtures' usage windows stay current.
 */

import { brakesFromSignals, main } from "../../src/cli.ts";
import { envFromProcess } from "../../src/config.ts";

const start = Date.parse(process.env.SYT_TEST_START ?? "");
const t0 = Date.now();
const env = { ...envFromProcess(process.env), now: () => new Date(start + (Date.now() - t0)) };
process.exitCode = await main(process.argv.slice(2), env, {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  cwd: process.cwd(),
  brakes: () => brakesFromSignals(process),
});
