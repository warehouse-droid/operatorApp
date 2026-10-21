import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const out = "test-artifacts/final";
fs.mkdirSync(`${out}/raw`, {recursive: true});
const source = fs.readFileSync("public/driver.js", "utf8");
fs.writeFileSync("test-artifacts/driver-recovery-helpers.js", source.slice(source.indexOf("function driverUploadOwner()"), source.indexOf("function photoSrc(")));
const layers = [];
function run(name, args, {env = process.env, allowBaseline = false} = {}) {
  const result = spawnSync(process.execPath, args, {encoding: "utf8", env, timeout: 120000, maxBuffer: 16 * 1024 * 1024});
  const log = result.stdout + result.stderr;
  fs.writeFileSync(`${out}/${name}.log`, log);
  const failures = [...log.matchAll(/^not ok \d+ - (.+)$/gmu)].map(value => value[1]);
  const baseline = [...fs.readFileSync("test-artifacts/baseline/checks.log", "utf8").matchAll(/^not ok \d+ - (.+)$/gmu)].map(value => value[1]);
  const counts = Object.fromEntries([...log.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gmu)].map(value => [value[1], Number(value[2])]));
  const passed = result.status === 0 || (allowBaseline && result.status === 1 && counts.fail === failures.length
    && failures.length > 0 && failures.every(value => baseline.includes(value)));
  layers.push({name, command: [process.execPath, ...args], exitCode: result.status, passed, counts,
    ...(allowBaseline ? {baselineFailures: baseline, failures, newFailures: failures.filter(value => !baseline.includes(value))} : {})});
  fs.writeFileSync(`${out}/layers.json`, JSON.stringify(layers, null, 2) + "\n");
  console.log(JSON.stringify(layers.at(-1)));
  assert.ok(passed, `${name} failed: see ${out}/${name}.log`);
}

const units = fs.readdirSync("test/mbt/unit").filter(name => /^driver-.*\.test\.js$/u.test(name)).sort().map(name => `test/mbt/unit/${name}`);
const properties = ["test/mbt/property/driver-upload-progress.test.js", "test/mbt/property/driver-upload-recovery.test.js"];
run("driver-regressions", ["--test", "--test-concurrency=1", ...units, ...properties], {allowBaseline: true});
const focused = units.filter(name => /driver-(upload-|pwa-recovery-assets|gps-radius)/u.test(name));
run("focused", ["--test", "--test-concurrency=1", ...focused, ...properties], {env: {...process.env, NODE_V8_COVERAGE: "/app/test-artifacts/final/raw"}});
run("reverse-order", ["--test", "--test-concurrency=1", ...[...focused, ...properties].reverse()]);
for (const file of ["public/driver.js", "public/driver-upload.js", "public/driver-service-worker.js", "src/server.js"]) run(`syntax-${file.replaceAll("/", "-")}`, ["--check", file]);
run("lint-recovery", ["node_modules/eslint/bin/eslint.js", "--config", "eslint.driver-recovery.config.mjs", "--max-warnings=0",
  "test-artifacts/driver-recovery-helpers.js", "test/mbt/unit/driver-upload-recovery.test.js", "test/mbt/property/driver-upload-recovery.test.js",
  "test/driver-upload-recovery/recovery.spec.js", "test/driver-upload-recovery.playwright.config.mjs", "tools/driver-upload-recovery-mutations.mjs", "tools/driver-upload-recovery-checks.mjs"]);
run("lint-existing", ["node_modules/eslint/bin/eslint.js", "--config", "eslint.driver-upload.config.mjs", "--max-warnings=0",
  "public/driver-upload.js", "test/mbt/unit/driver-upload-lifecycle.test.js", "test/support/driver-upload-fixtures.mjs", "test/driver-upload/faults.spec.js"]);
run("type-contracts", ["node_modules/typescript/bin/tsc", "--project", "test/driver-upload-types.json"]);
run("mutations", ["tools/driver-upload-recovery-mutations.mjs"]);
run("secrets", ["test/support/scan-diff-secrets.mjs", "--unified-diff", "test-artifacts/runtime.patch",
  "test/mbt/unit/driver-upload-recovery.test.js", "test/mbt/property/driver-upload-recovery.test.js", "test/driver-upload-recovery",
  "tools/driver-upload-recovery-checks.mjs", "tools/driver-upload-recovery-mutations.mjs", "tools/driver-upload-recovery-release.py"]);
const files = ["public/driver.js", "public/driver-upload.js", "public/driver.html", "public/driver-service-worker.js", "src/server.js"];
const hashes = Object.fromEntries(files.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
fs.writeFileSync(`${out}/runtime-hashes.json`, JSON.stringify(hashes, null, 2) + "\n");
fs.writeFileSync(`${out}/tool-versions.json`, JSON.stringify({node: process.version, ...Object.fromEntries(["@playwright/test", "fast-check", "eslint", "typescript", "c8"].map(name => [name, JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, "utf8")).version]))}, null, 2) + "\n");
