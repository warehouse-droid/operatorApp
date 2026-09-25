import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "arrival-mutants-"));
const property = "test/dispatch/property/dispatch-actual-arrival-evidence.test.js";
const integration = "test/dispatch/integration/dispatch-actual-arrival-repair.test.js";
const backfill = "test/dispatch/integration/dispatch-actual-arrival-backfill.test.js";
const frontend = "test/dispatch/frontend/dispatch-actual-arrival-repair.test.js";
const cases = [
  ["wrong destination accepted", "src/dispatch-actual-arrival-evidence.js", "addressKey(address) !== addressKey(destinationAddress)", "false", property],
  ["wrong driver accepted", "src/dispatch-actual-arrival-evidence.js", "text(record.driver_login).toLowerCase() !== text(verification.driver_login).toLowerCase()", "false", property],
  ["future evidence accepted", "src/dispatch-actual-arrival-evidence.js", "checked > completed", "false", property],
  ["valid evidence rejected", "src/dispatch-actual-arrival-evidence.js", "return { latitude, longitude };", "return null;", property],
  ["latitude bounds removed", "src/dispatch-actual-arrival-evidence.js", "Math.abs(latitude) > 90", "false", property],
  ["stored verifications ignored", "src/dispatch-actual-arrival-service.js", "const verifications = await listActualArrivalVerifications(records);", "const verifications = [];", integration],
  ["false job-start arrival restored", "src/dispatch-forecast-service.js", "actualStart: unresolved ? null : starts.length ? Math.min(...starts) : null", "actualStart: unresolved ? recordStartedEpoch(active[0]) : starts.length ? Math.min(...starts) : null", integration],
  ["long-stop earlier history skipped", "src/dispatch-actual-arrival-service.js", "resolution.status !== \"resolved\" || clusterTouchesWindowStart", "resolution.status !== \"resolved\"", integration],
  ["UI restores unresolved job start", "public/dispatch.js", 'actualStart: arrivalUnavailable ? "" : arrival || recordStartedAt(record)', "actualStart: arrival || recordStartedAt(record)", frontend],
  ["old history omitted", "tools/actual-arrival-backfill.mjs", "AND completed_at IS NOT NULL AND plan_date <= $1::date", "AND completed_at IS NOT NULL AND plan_date = $1::date", backfill],
  ["database timestamp precision mismatch restored", "src/driver-repository.js", "date_trunc('milliseconds', result.completed_at) = date_trunc('milliseconds', record.completed_at)", "result.completed_at = record.completed_at", integration]
];
const results = [];
try {
  for (const folder of ["src", "public", "test", "tools"]) fs.cpSync(path.join(root, folder), path.join(temp, folder), { recursive: true });
  fs.copyFileSync(path.join(root, "package.json"), path.join(temp, "package.json"));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(temp, "node_modules"));
  for (const testFile of [property, integration, frontend, backfill]) {
    const baseline = spawnSync(process.execPath, ["--test", "--test-concurrency=1", testFile], { cwd: temp, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    assert.equal(baseline.status, 0, `Unmutated suite failed: ${testFile}\n${baseline.stdout}\n${baseline.stderr}`);
  }
  for (const [name, file, original, replacement, testFile] of cases) {
    const target = path.join(temp, file);
    const before = fs.readFileSync(target, "utf8");
    assert.equal(before.split(original).length, 2, `Mutation anchor: ${name}`);
    fs.writeFileSync(target, before.replace(original, replacement));
    const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", testFile], { cwd: temp, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    fs.writeFileSync(target, before);
    const killed = run.status !== 0 && /not ok /u.test(run.stdout) && !/ERR_MODULE_NOT_FOUND/u.test(run.stderr);
    results.push({ name, killed, layer: testFile === property ? "property alone" : testFile });
    fs.writeFileSync(path.join(root, "test-artifacts/actual-arrival-repair", `mutant-${results.length}.log`), run.stdout + run.stderr);
    console.log(JSON.stringify(results.at(-1)));
  }
  fs.writeFileSync("test-artifacts/actual-arrival-repair/mutations.json", JSON.stringify(results, null, 2));
  assert.ok(results.every(row => row.killed), "A plausible faulty implementation survived the tests.");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
