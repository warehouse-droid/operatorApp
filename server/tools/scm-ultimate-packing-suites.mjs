import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";

const label = process.argv[2] || "candidate";
const directory = `test-artifacts/scm-ultimate-packing-20261005/${label}-suites`;
mkdirSync(directory, { recursive: true });
assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const legacy = readdirSync("src").filter((name) => /^smart-scm-.*harness\.js$/.test(name)
  && !name.includes("mutation")).map((name) => `src/${name}`);
const files = [];
function visit(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      visit(file);
    } else if (/\.test\.(?:m?js)$/.test(entry.name)
      && /(?:smart-scm|regular-stock|scm-manual-split)/.test(entry.name)
      && !entry.name.startsWith("scm-ultimate-packing")) {
      files.push(file);
    }
  }
}
visit("test/mbt");
visit("test/dispatch");
const selected = [...legacy, ...files].sort();
if (process.env.SCM_PACKING_SHUFFLE === "1") {
  selected.sort((left, right) => {
    const key = (value) => [...value].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) >>> 0, 429);
    return key(left) - key(right);
  });
}
const reports = [];
const connection = new URL(process.env.DATABASE_URL);
assert.equal(connection.hostname, "db");
assert.equal(connection.pathname, "/mbt_test");
connection.pathname = "/postgres";
const maintenance = new pg.Pool({ connectionString: connection.href });
await maintenance.query("DROP DATABASE IF EXISTS scm_ultimate_empty WITH (FORCE)");
await maintenance.query("CREATE DATABASE scm_ultimate_empty TEMPLATE mbt_test");
try {
for (const [index, file] of selected.entries()) {
  await maintenance.query("DROP DATABASE mbt_test WITH (FORCE)");
  await maintenance.query("CREATE DATABASE mbt_test TEMPLATE scm_ultimate_empty");
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", file],
    { encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: "" }, timeout: 120000 });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const log = `${directory}/${index + 1}-${path.basename(file)}.log`;
  writeFileSync(log, output);
  const failures = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((match) => match[1]);
  const passed = Number(output.match(/^# pass (\d+)$/m)?.[1] || 0);
  const diagnostics = errorMessages(output);
  reports.push({ file, exitCode: result.status, passed, failures, diagnostics, log,
    error: result.error?.message || null });
  console.log(JSON.stringify({ file, exitCode: result.status, passed, failures }));
}
} finally {
  await maintenance.query("DROP DATABASE mbt_test WITH (FORCE)");
  await maintenance.query("CREATE DATABASE mbt_test TEMPLATE scm_ultimate_empty");
  await maintenance.query("DROP DATABASE scm_ultimate_empty WITH (FORCE)");
  await maintenance.end();
}
const summary = { files: reports.length, passed: reports.reduce((sum, report) => sum + report.passed, 0),
  failures: reports.filter((report) => report.exitCode !== 0), reports };
writeFileSync(`${directory}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
if (label !== "baseline") {
  const baseline = JSON.parse(readFileSync("test-artifacts/scm-ultimate-packing-20261005/baseline-suites/summary.json", "utf8"));
  const old = new Map(baseline.reports.map((report) => [report.file, report]));
  const regressions = reports.filter((report) => report.error || report.failures.some((failure) => !old.get(report.file)?.failures.includes(failure))
    || report.exitCode !== 0 && old.get(report.file)?.exitCode === 0
    || report.diagnostics.some((diagnostic) => !(old.get(report.file)?.diagnostics
      || errorMessages(readFileSync(old.get(report.file).log, "utf8"))).includes(diagnostic)));
  assert.deepEqual(regressions, [], "Affected suites introduced new failures");
}
console.log(JSON.stringify({ files: summary.files, passed: summary.passed, failingFiles: summary.failures.length }));

function errorMessages(output) {
  return [...output.matchAll(/^(?:#\s+(?:\w*Error(?:\s*\[[^\]]+\])?):[^\n]+|\s+error:\s+[^\n]+)/gm)]
    .map((match) => match[0].trim());
}
