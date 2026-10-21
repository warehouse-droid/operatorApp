import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert.equal(new URL(process.env.DATABASE_URL).hostname, "db");
assert.equal(process.env.NETSUITE_DIRECT_ACCESS_ENABLED, "false");
const mode = process.argv.at(-1);
const out = "test-artifacts/billed-order-reopen-20261015";
const task = "tools/billed-order-reopen-20261015";
const primary = ["test/dispatch/frontend/billed-order-po-link.test.js", "test/dispatch/integration/billed-order-reopen.test.js"];
const regressions = [
  "test/dispatch/integration/control-order-reopen.test.js",
  "test/dispatch/integration/control-order-reopen-local.test.js",
  "test/dispatch/integration/control-order-reopen-http.test.js",
  "test/dispatch/frontend/dispatch-fulfilled-so-ui.test.js",
  "test/dispatch/unit/dispatch-fulfilled-so-policy.test.js",
  "test/dispatch/integration/dispatch-fulfilled-so-planning.test.js",
  "test/dispatch/integration/dispatch-po-split-link-target.test.js",
  "test/dispatch/integration/scm-dependency-preview-blockers.red.test.js"
];
mkdirSync(out, { recursive: true });
function run(label, args, options = {}) {
  const file = `${out}/${label}.log`, fd = openSync(file, "w");
  let result;
  try { result = spawnSync(process.execPath, args, { env: process.env, timeout: 300_000, ...options, stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  const log = readFileSync(file, "utf8");
  const counts = Object.fromEntries(["tests", "pass", "fail", "skipped"].map(key => [key, Number(log.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] || 0)]));
  const record = { label, exit: result.status, ...counts,
    failures: [...log.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]) };
  writeFileSync(`${out}/${label}.json`, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify(record));
  if (result.status) { console.log(log.slice(-2200)); }
  return record;
}
const files = mode === "baseline" ? regressions : mode === "red" || mode === "green" ? primary : [...primary, ...regressions];
const args = ["--test", "--test-concurrency=1", ...files];
const runtime = ["src/operator-order-reopen-repository.js", "public/dispatch.js", "public/dispatch.html"];
const result = run(mode, mode === "final" ? ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
  "--include=src/operator-order-reopen-repository.js", "--include=public/dispatch.js", "--temp-directory=/tmp/billed-reopen-c8",
  `--report-dir=${out}/coverage`, "--reporter=json", "--reporter=text", process.execPath, ...args] : args);
if (mode === "red") {
  assert.ok(result.fail >= 4, "Both reported behaviors must fail before the fix");
} else if (mode === "baseline") {
  assert.ok(result.tests > 0 && result.exit !== null, "Baseline suite must finish");
} else if (mode === "final") {
  const baseline = JSON.parse(readFileSync(`${out}/baseline.json`, "utf8"));
  assert.deepEqual(result.failures, baseline.failures, "No new regression failures are permitted");
  assert.equal(result.fail, baseline.fail);
  assert.equal(result.tests, baseline.tests + 16);
} else {
  assert.equal(result.exit, 0, JSON.stringify(result));
  assert.equal(result.fail, 0);
}
if (mode === "final") {
  for (const file of runtime.filter(file => file.endsWith(".js"))) { assert.equal(run("syntax-" + file.replaceAll("/", "_"), ["--check", file]).exit, 0); }
  assert.equal(run("static-runner", [task + "/static.mjs"]).exit, 0);
  assert.equal(run("mutations-runner", [task + "/mutations.mjs"]).exit, 0);
  assert.equal(run("suite-health", ["--test", "--test-concurrency=1", ...[...primary].reverse()]).exit, 0);
  const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
  writeFileSync(`${out}/summary.json`, JSON.stringify({ ...result,
    baselineFailures: JSON.parse(readFileSync(`${out}/baseline.json`, "utf8")).failures, newFailures: [],
    hashes: Object.fromEntries([...runtime, ...primary, ...regressions].map(file => [file, hash(file)])),
    tools: Object.fromEntries(["typescript", "eslint", "c8", "fast-check", "playwright"].map(name => [name,
      JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version])),
    node: process.version }, null, 2) + "\n");
}
