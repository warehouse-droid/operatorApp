import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const root = "test-artifacts/maps-daily-capacity";
const text = (file) => readFile(`${root}/${file}`, "utf8");
const tests = await text("tests.log");
const existing = JSON.parse(await text("baseline-failures.json"));
const failures = [...tests.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
assert.deepEqual(failures, existing, "No new focused-suite failures are permitted.");
assert.match(tests, /# tests \d+\n/u);
const mutations = JSON.parse(await text("mutations.json"));
assert.equal(mutations.length, 7);
assert.ok(mutations.every((row) => row.killed));
assert.match(await text("browser.log"), /"desktop":"passed","mobile":"passed"/u);
assert.match(await text("static.log"), /focused ESLint passed/u);
assert.match(await text("secrets.log"), /Secret scan passed/u);
assert.match(await text("migration-rollback.log"), /restores the existing table/u);
const changedCoverage = JSON.parse(await text("changed-line-coverage.json"));
assert.ok(Object.values(changedCoverage).every((row) => row.changedLines === row.covered));
assert.ok(JSON.parse(await text("suite-health.json")).every((row) => row.passed));
const coverage = JSON.parse(await text("coverage/coverage-summary.json"));
const runtime = ["public/admin.html", "public/control.js", "public/control.css", "src/google-maps-usage-policy.js",
  "src/google-maps-usage-repository.js", "src/server.js", "migrations/219_google_maps_daily_capacity.sql"];
const runtimeHashes = Object.fromEntries(await Promise.all(runtime.map(async (file) => [
  file, crypto.createHash("sha256").update(await readFile(file)).digest("hex")
])));
const proof = {
  passed: true, runtimeHashes,
  tests: Number(tests.match(/# tests (\d+)/u)[1]), passedTests: Number(tests.match(/# pass (\d+)/u)[1]),
  preExistingFailures: existing, newFailures: [], mutationKills: mutations.length,
  coverage: coverage.total, changedCoverage, browser: { desktop: "passed", mobile: "passed" },
  sourceHash: crypto.createHash("sha256").update(JSON.stringify(runtimeHashes)).digest("hex")
};
await writeFile(`${root}/checks.json`, JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof));
