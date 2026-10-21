import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const out = "test-artifacts/billed-order-reopen-20261015";
const backend = "src/operator-order-reopen-repository.js", frontend = "public/dispatch.js";
const beTest = "test/dispatch/integration/billed-order-reopen.test.js", feTest = "test/dispatch/frontend/billed-order-po-link.test.js";
const mutants = [
  ["billed-blocks-reset", backend, '/^F$/u.test(text(h.status))', '/^[FG]$/u.test(text(h.status))', beTest, 'real HTTP:'],
  ["missing-fulfillment-id-guard", backend, '|| h.last_item_fulfillment_id || h.fulfilled_at', '|| h.fulfilled_at', beTest, 'fulfillment ID still'],
  ["ignore-fulfillment-record", backend, 'if (fulfillment.rowCount)', 'if (false && fulfillment.rowCount)', beTest, 'fulfillment record ID=123:'],
  ["trust-stale-ui-eligibility", frontend, 'item.dispatchFulfilledSalesPlanningEligible === true', 'true', feTest],
  ["ignore-local-execution", frontend, '!isReviewOnlyOrder({ ...item, netsuiteStatusText: "", raw: { ...item.raw, status_text: "" } })', 'true', feTest]
];
const results = [];
for (const [name, file, before, after, testFile, pattern] of mutants) {
  const root = mkdtempSync("/tmp/billed-reopen-mutant-");
  try {
    for (const folder of ["src", "public"]) { cpSync(folder, root + "/" + folder, { recursive: true }); }
    for (const path of ["package.json", beTest, feTest, "test/support/control-order-reopen-fixture.mjs", "test/support/sales-order-cargo-fixture.mjs"]) {
      mkdirSync(dirname(root + "/" + path), { recursive: true }); cpSync(path, root + "/" + path);
    }
    for (const folder of ["node_modules", "migrations"]) { symlinkSync(resolve(folder), root + "/" + folder); }
    const source = readFileSync(root + "/" + file, "utf8");
    assert.equal(source.split(before).length, 2, name + " must target one production expression");
    writeFileSync(root + "/" + file, source.replace(before, after));
    const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...(pattern ? ["--test-name-pattern=" + pattern] : []), testFile],
      { cwd: root, env: process.env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const log = run.stdout + run.stderr;
    writeFileSync(`${out}/mutant-${name}.log`, log);
    const fail = Number(log.match(/^# fail (\d+)$/mu)?.[1] || 0);
    const killed = run.status === 1 && fail > 0 && /ERR_ASSERTION|ERR_TEST_FAILURE/u.test(log)
      && !/ERR_MODULE_NOT_FOUND|SyntaxError/u.test(log);
    results.push({ name, killed, failures: fail, exit: run.status });
    assert.equal(killed, true, name + " survived: " + log.slice(-2000));
    if (file === frontend) {
      const property = spawnSync(process.execPath, ["--test", "--test-name-pattern=^property:", testFile],
        { cwd: root, env: process.env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      const propertyLog = property.stdout + property.stderr;
      writeFileSync(`${out}/mutant-${name}-property.log`, propertyLog);
      const propertyKilled = property.status === 1 && /Property failed/u.test(propertyLog);
      results.at(-1).propertyKilled = propertyKilled;
      assert.equal(propertyKilled, true, name + " survived the property suite");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
writeFileSync(`${out}/mutations.json`, JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results));
