import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

export const regressionFiles = [
  "test/dispatch/unit/dispatch-executed-order-review.test.js",
  "test/dispatch/unit/dispatch-executed-order-incidents.test.js",
  "test/dispatch/unit/executed-prefix-historical-reflexivity.test.js",
  "test/dispatch/property/dispatch-executed-order-review.test.js",
  "test/dispatch/property/dispatch-planned-source-review.test.js",
  "test/dispatch/frontend/dispatch-source-replan-notice.test.js",
  "test/dispatch/frontend/dispatch-reviewed-notice.test.js",
  "test/dispatch/frontend/dispatch-executed-order-review.browser.test.mjs",
  "test/dispatch/frontend/dispatch-reviewed-notice-dismiss.browser.test.mjs",
  "test/dispatch/integration/dispatch-executed-order-review.test.js",
  "test/dispatch/integration/dispatch-executed-review-active-lines.test.js",
  "test/dispatch/integration/dispatch-weight-source-review.test.js",
  "test/dispatch/integration/dispatch-packed-group-review.test.js",
  "test/dispatch/concurrency/dispatch-v2-stale-command.red.test.js",
  "test/dispatch/concurrency/dispatch-save-recovery-concurrency.red.test.js"
];
export const coreFiles = ["test/dispatch/unit/dispatch-source-decision.test.js",
  "test/dispatch/frontend/dispatch-source-decision.test.js", "test/dispatch/integration/dispatch-source-decision.test.js",
  "test/dispatch/frontend/dispatch-source-decision.browser.test.mjs"];
const root = "test-artifacts/source-decision";

export async function isolatedRun(file, { cwd = process.cwd(), coverage = false, prefix = "run" } = {}) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  const database = `source_decision_${process.pid}_${Math.random().toString(16).slice(2, 10)}`;
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
      "--include=src/dispatch-executed-order-review*.js", "--include=src/server.js", "--include=public/dispatch.js",
      `--temp-directory=/tmp/source-decision-c8-${prefix}-${name}`, `--report-dir=/app/${root}/${prefix}/${name}-coverage`,
      "--reporter=json", "--reporter=json-summary", "node", "--test", "--test-concurrency=1", file]
      : ["--test", "--test-concurrency=1", file];
    const result = spawnSync("node", args, { cwd, env: { ...process.env, DATABASE_URL: url.href }, encoding: "utf8", maxBuffer: 24 * 1024 * 1024, timeout: 120000 });
    mkdirSync(`${root}/${prefix}`, { recursive: true });
    writeFileSync(`${root}/${prefix}/${name}.log`, result.stdout + result.stderr);
    return { file, exit: result.status, failures: [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gmu)].map(match => match[1]),
      ...Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gmu)].map(match => [match[1], Number(match[2])])) };
  } finally {
    await client.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    await client.end();
  }
}

function staticChecks(mode) {
  const path = `${root}/${mode}`;
  mkdirSync(path, { recursive: true });
  const files = ["src/dispatch-executed-order-review.js", "src/dispatch-executed-order-review-repository.js", "src/server.js", "public/dispatch.js"];
  for (const file of files) {assert.equal(spawnSync("node", ["--check", file]).status, 0);}
  const lint = spawnSync("node", ["node_modules/eslint/bin/eslint.js", "--config", "tools/dispatch-source-decision-eslint.config.mjs", "--format", "json", ...files.filter(file => !file.startsWith("public/"))], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const lintMessages = JSON.parse(lint.stdout).flatMap(file => file.messages.map(message => ({ file: file.filePath.replace(/^.*\/app\//u, ""), rule: message.ruleId, message: message.message })));
  const types = spawnSync("node", ["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json", "--noEmit"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const typeMessages = (types.stdout + types.stderr).split("\n").filter(line => /error TS\d+/u.test(line)).map(line => line.replace(/\(\d+,\d+\)/u, ""));
  const versions = Object.fromEntries(["eslint", "typescript", "c8", "pg", "fast-check", "v8-to-istanbul", "@playwright/test"].map(name =>
    [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version]));
  const added = [...coreFiles, "tools/dispatch-source-decision-checks.mjs", "tools/dispatch-source-decision-mutations.mjs", "tools/dispatch-source-decision-eslint.config.mjs"];
  const addedLint = spawnSync("node", ["node_modules/eslint/bin/eslint.js", "--config", "tools/dispatch-source-decision-eslint.config.mjs", "--max-warnings=0", ...added], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  writeFileSync(`${path}/new-file-lint.log`, addedLint.stdout + addedLint.stderr);
  assert.equal(addedLint.status, 0, `New file lint failed: ${addedLint.stdout}${addedLint.stderr}`);
  const result = { lintMessages, typeMessages, node: process.version, versions };
  writeFileSync(`${path}/static.json`, JSON.stringify(result, null, 2));
  if (mode === "final") {
    const baseline = JSON.parse(readFileSync(`${root}/baseline/static.json`, "utf8"));
    for (const key of ["lintMessages", "typeMessages"]) {
      const old = new Map();
      for (const message of baseline[key]) {const entry = JSON.stringify(message); old.set(entry, (old.get(entry) || 0) + 1);}
      for (const message of result[key]) {const entry = JSON.stringify(message); assert.ok(old.get(entry) > 0, `New diagnostic: ${entry}`); old.set(entry, old.get(entry) - 1);}
    }
  }
  return { syntax: files.length, lintDiagnostics: lintMessages.length, typeDiagnostics: typeMessages.length };
}

async function main() {
  const mode = process.argv[2];
  mkdirSync("test-artifacts/executed-order-review", { recursive: true });
  const files = mode === "baseline" ? regressionFiles : [...coreFiles, ...regressionFiles].sort((a, b) =>
    Buffer.from(a).reduce((sum, value) => (sum * 31 + value) % 997, 27129)
    - Buffer.from(b).reduce((sum, value) => (sum * 31 + value) % 997, 27129));
  const results = [];
  for (const file of files) {
    const result = await isolatedRun(file, { prefix: mode, coverage: mode === "final" && coreFiles.includes(file) });
    results.push(result);
    console.log(JSON.stringify(result));
  }
  writeFileSync(`${root}/${mode}/tests.json`, JSON.stringify(results, null, 2));
  const statics = staticChecks(mode);
  if (mode === "final") {
    for (const result of results.filter(row => coreFiles.includes(row.file))) {assert.equal(result.exit, 0, result.file);}
    const baseline = JSON.parse(readFileSync(`${root}/baseline/tests.json`, "utf8"));
    for (const result of results.filter(row => regressionFiles.includes(row.file))) {
      const previous = baseline.find(row => row.file === result.file);
      assert.deepEqual(result.failures, previous.failures, `New regression in ${result.file}`);
      assert.equal(result.exit === 0, previous.exit === 0, result.file);
    }
  }
  console.log(JSON.stringify({ mode, passed: results.reduce((sum, row) => sum + (row.pass || 0), 0),
    failed: results.reduce((sum, row) => sum + (row.fail || 0), 0), ...statics }));
}
if (process.argv[1]?.endsWith("dispatch-source-decision-checks.mjs")) {await main();}
