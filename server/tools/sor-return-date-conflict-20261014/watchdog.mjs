// Use the existing Stock Check regression deadline without changing test assertions.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

if (process.env.MBT_TEST_ISOLATED !== "1") { throw new Error("Use the bounded isolated test container"); }
const ticks = Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim());
if (!(ticks > 0)) { throw new Error("Unable to read process clock ticks"); }
const out = "test-artifacts/sor-return-date-conflict-20261014/watchdog.json";
const reports = [];
writeFileSync(out, "[]\n");
function processes() {
  const result = [];
  for (const name of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const pid = Number(name), raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(") ") + 2).split(" ");
      result.push({ pid, parent: Number(fields[1]), started: Number(fields[19]) / ticks,
        args: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) });
    } catch { /* Processes may exit between reads. */ }
  }
  return result;
}
while (true) {
  const rows = processes();
  if (!rows.some(row => row.args.some(arg => arg.endsWith("sor-return-date-conflict-20261014/check.mjs")))) { break; }
  const now = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
  for (const row of rows.filter(row => row.args.includes("--test-reporter=spec") && now - row.started > 90)) {
    const file = row.args.find(arg => arg.includes("/test/"));
    if (!file) { continue; }
    const descendants = [row.pid];
    for (let index = 0; index < descendants.length; index++) {
      descendants.push(...rows.filter(child => child.parent === descendants[index]).map(child => child.pid));
    }
    const report = { file, deadlineSeconds: 90, elapsedSeconds: Math.round(now - row.started), pids: descendants,
      result: "unverified: test file timed out" };
    reports.push(report); writeFileSync(out, JSON.stringify(reports, null, 2) + "\n");
    console.log(JSON.stringify(report));
    for (const pid of descendants.reverse()) { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } }
  }
  await delay(1000);
}
writeFileSync(out, JSON.stringify(reports, null, 2) + "\n");
