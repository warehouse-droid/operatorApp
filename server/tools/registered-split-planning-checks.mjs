import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

export const artifact = "test-artifacts/registered-split-planning";
export const integrationFile = "test/dispatch/integration/dispatch-registered-split-planning.test.js";
export const propertyFile = "test/dispatch/property/dispatch-registered-split-planning.test.js";
export const browserFile = "test/dispatch/frontend/dispatch-registered-split-planning.browser.test.mjs";
export const coreFiles = [integrationFile, propertyFile, browserFile];
export const regressionFiles = [
  "test/dispatch/unit/dispatch-fulfilled-so-policy.test.js",
  "test/dispatch/integration/dispatch-first-split-group-status.test.js",
  "test/dispatch/integration/dispatch-fulfilled-so-planning.test.js",
  "test/dispatch/concurrency/dispatch-fulfilled-so-planning.test.js",
  "test/dispatch/integration/dispatch-fulfilled-so-http.test.js",
  "test/dispatch/frontend/dispatch-fulfilled-so-ui.test.js",
  "test/dispatch/frontend/dispatch-fulfilled-so.browser.test.mjs",
  "test/dispatch/frontend/dispatch-first-split-group-status.browser.test.mjs",
  "test/dispatch/integration/dispatch-order-catalog.red.test.js",
  "test/dispatch/integration/dispatch-split-date-conflict.test.js",
  "test/dispatch/integration/direct-linked-po-lifecycle.test.js",
  "test/dispatch/integration/dispatch-source-decision.test.js"
];

export async function isolatedRun(file, { cwd = process.cwd(), coverage = false, prefix = "run" } = {}) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  const database = `registered_split_${process.pid}_${Math.random().toString(16).slice(2, 10)}`;
  const url = new URL(process.env.DATABASE_URL);
  const template = url.pathname.slice(1);
  assert.match(template, /^[a-zA-Z0-9_]+$/u);
  const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
  const client = new pg.Client({ connectionString: adminUrl.href });
  await client.connect();
  await client.query(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
  try {
    url.pathname = `/${database}`;
    const name = file.replaceAll("/", "-");
    const args = coverage ? ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
      "--include=src/dispatch-fulfilled-so-repository.js",
      `--temp-directory=/tmp/registered-split-c8-${prefix}-${name}`, `--report-dir=/app/${artifact}/${prefix}/${name}-coverage`,
      "--reporter=json", "--reporter=json-summary", "node", "--test", "--test-concurrency=1", file]
      : ["--test", "--test-concurrency=1", file];
    const result = spawnSync("node", args, { cwd, env: { ...process.env, DATABASE_URL: url.href }, encoding: "utf8", maxBuffer: 24 * 1024 * 1024, timeout: 120000 });
    mkdirSync(`${artifact}/${prefix}`, { recursive: true });
    writeFileSync(`${artifact}/${prefix}/${name}.log`, result.stdout + result.stderr);
    return { file, exit: result.status, failures: [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gmu)].map(match => match[1]),
      ...Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gmu)].map(match => [match[1], Number(match[2])])) };
  } finally {
    await client.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await client.end();
  }
}

function diagnostics() {
  assert.equal(spawnSync("node", ["--check", "src/dispatch-fulfilled-so-repository.js"]).status, 0);
  const lint = spawnSync("node", ["node_modules/eslint/bin/eslint.js", "--config", "tools/registered-split-planning-eslint.config.mjs",
    "--format", "json", "src/dispatch-fulfilled-so-repository.js"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.ok(lint.stdout, lint.stderr);
  const lintMessages = JSON.parse(lint.stdout).flatMap(file => file.messages.map(message => ({ rule: message.ruleId, message: message.message })));
  const types = spawnSync("node", ["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json", "--noEmit"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const typeMessages = (types.stdout + types.stderr).split("\n").filter(line => /error TS\d+/u.test(line)).map(line => line.replace(/\(\d+,\d+\)/u, ""));
  const versions = Object.fromEntries(["eslint", "typescript", "c8", "pg", "fast-check", "@playwright/test"].map(name =>
    [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version]));
  return { lintMessages, typeMessages, node: process.version, versions };
}

function compareDiagnostics(current, baseline) {
  for (const key of ["lintMessages", "typeMessages"]) {
    const old = new Map();
    for (const message of baseline[key]) {const entry = JSON.stringify(message); old.set(entry, (old.get(entry) || 0) + 1);}
    for (const message of current[key]) {const entry = JSON.stringify(message); assert.ok(old.get(entry) > 0, `New diagnostic: ${entry}`); old.set(entry, old.get(entry) - 1);}
  }
}

function staticChecks(mode) {
  const result = diagnostics();
  writeFileSync(`${artifact}/${mode}/static.json`, JSON.stringify(result, null, 2));
  if (mode === "final") {
    compareDiagnostics(result, JSON.parse(readFileSync(`${artifact}/baseline/static.json`, "utf8")));
    const added = [...coreFiles, "test/dispatch/support/registered-split-fixture.js",
      "tools/registered-split-planning-checks.mjs", "tools/registered-split-planning-mutations.mjs",
      "tools/registered-split-planning-eslint.config.mjs", "tools/registered-split-planning-live.mjs"];
    const lint = spawnSync("node", ["node_modules/eslint/bin/eslint.js", "--config", "tools/registered-split-planning-eslint.config.mjs",
      "--max-warnings=0", ...added], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    writeFileSync(`${artifact}/${mode}/new-file-lint.log`, lint.stdout + lint.stderr);
    assert.equal(lint.status, 0, `New file lint failed: ${lint.stdout}${lint.stderr}`);
  }
  return { syntax: 1, lintDiagnostics: result.lintMessages.length, typeDiagnostics: result.typeMessages.length };
}

function shuffled(files) {
  return [...files].sort((a, b) => Buffer.from(a).reduce((sum, value) => (sum * 31 + value) % 997, 92229223)
    - Buffer.from(b).reduce((sum, value) => (sum * 31 + value) % 997, 92229223));
}

function compareResults(results, mode) {
  if (mode === "red") {
    for (const result of results) {assert.ok(result.failures.length > 0, `Expected a behavioral RED in ${result.file}`);}
    return;
  }
  if (mode === "baseline") {return;}
  for (const result of results.filter(row => coreFiles.includes(row.file))) {assert.equal(result.exit, 0, result.file);}
  const baseline = JSON.parse(readFileSync(`${artifact}/baseline/tests.json`, "utf8"));
  for (const result of results.filter(row => regressionFiles.includes(row.file))) {
    const previous = baseline.find(row => row.file === result.file);
    assert.deepEqual(result.failures, previous.failures, `New regression in ${result.file}`);
    assert.equal(result.exit === 0, previous.exit === 0, result.file);
  }
}

async function main() {
  const mode = process.argv[2];
  assert.ok(["baseline", "red", "final"].includes(mode));
  const files = mode === "baseline" ? regressionFiles : mode === "red" ? [integrationFile, propertyFile] : shuffled([...coreFiles, ...regressionFiles]);
  const results = [];
  for (const file of files) {
    const result = await isolatedRun(file, { prefix: mode, coverage: mode === "final" && coreFiles.includes(file) });
    results.push(result);
    console.log(JSON.stringify(result));
  }
  writeFileSync(`${artifact}/${mode}/tests.json`, JSON.stringify(results, null, 2));
  compareResults(results, mode);
  const statics = mode === "red" ? {} : staticChecks(mode);
  console.log(JSON.stringify({ mode, passed: results.reduce((sum, row) => sum + (row.pass || 0), 0),
    failed: results.reduce((sum, row) => sum + (row.fail || 0), 0), ...statics }));
}
if (process.argv[1]?.endsWith("registered-split-planning-checks.mjs")) {await main();}
