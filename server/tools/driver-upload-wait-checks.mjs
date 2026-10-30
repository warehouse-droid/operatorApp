import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const out = "test-artifacts";
const layers = [];
const assetVersion = fs.readFileSync("public/driver-upload.js", "utf8").match(/const ASSET_VERSION = "([^"]+)"/u)[1];
const uploadAsset = `/driver-upload.js?v=${assetVersion}`;
const shell = fs.readFileSync("public/driver-service-worker.js", "utf8");
assert.ok(fs.readFileSync("public/driver.html", "utf8").includes(uploadAsset), "Driver HTML must load the verified upload asset");
assert.ok(shell.includes(uploadAsset), "Offline shell must cache the verified upload asset");
const cacheVersion = Number(shell.match(/DRIVER_CACHE_NAME = `\$\{DRIVER_CACHE_PREFIX\}v(\d+)`/u)[1]);
assert.ok(cacheVersion > 49, "Advance the driver shell cache after the upload fix");
assert.ok(shell.includes(`refresh-v${cacheVersion}`), "Refresh and active shell versions must match");
console.log(JSON.stringify({assets: {version: assetVersion, cacheVersion, passed: true}}));
function run(name, args, {env = process.env, expectedFailures = 0} = {}) {
  const child = spawnSync(process.execPath, args, {encoding: "utf8", env, timeout: 120000, maxBuffer: 8 * 1024 * 1024});
  const log = child.stdout + child.stderr;
  fs.writeFileSync(`${out}/${name}.log`, log);
  const counts = Object.fromEntries([...log.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gmu)].map(value => [value[1], Number(value[2])]));
  const passed = expectedFailures ? child.status === 1 && counts.fail === expectedFailures && counts.cancelled === 0
    : child.status === 0;
  layers.push({name, passed, exitCode: child.status, counts});
  console.log(JSON.stringify(layers.at(-1)));
  if (!passed) console.error(log.slice(-8000));
  assert.ok(passed, `${name} failed`);
  return log;
}

const focused = fs.readdirSync("test/mbt/unit").filter(name => /^driver-(upload-|reconnect\.|completion-trace\.)/u.test(name))
  .sort().map(name => `test/mbt/unit/${name}`);
const properties = fs.readdirSync("test/mbt/property").filter(name => /^driver-(upload-|reconnect\.)/u.test(name))
  .sort().map(name => `test/mbt/property/${name}`);
const newTests = ["test/mbt/unit/driver-upload-wait.test.js", "test/mbt/property/driver-upload-wait.test.js"];
run("red-baseline", ["--test", ...newTests], {
  env: {...process.env, DRIVER_UPLOAD_MODULE_FILE: "/app/test-artifacts/baseline-driver-upload.js"}, expectedFailures: 16
});
fs.writeFileSync(`${out}/coverage-config.json`, JSON.stringify({all: false, include: ["public/driver-upload.js"],
  reporter: ["json"], "report-dir": `${out}/coverage`, "temp-directory": `${out}/raw`, "check-coverage": false}));
run("focused", ["--test", "--test-concurrency=1", ...focused, ...properties], {env: {...process.env, NODE_V8_COVERAGE: "/app/test-artifacts/raw"}});
run("coverage", ["node_modules/c8/bin/c8.js", "report", "--config", `${out}/coverage-config.json`]);
run("reverse-order", ["--test", "--test-concurrency=1", ...[...focused, ...properties].reverse()]);
run("syntax", ["--check", "public/driver-upload.js"]);
run("shell-syntax", ["--check", "public/driver-service-worker.js"]);
run("types", ["node_modules/typescript/bin/tsc", "--project", "test/driver-upload-types.json"]);
run("lint", ["node_modules/eslint/bin/eslint.js", "--config", "eslint.driver-upload-wait.config.mjs", "--max-warnings=0",
  "public/driver-upload.js", "test/support/driver-upload-wait-fixture.mjs", ...newTests,
  "tools/driver-upload-wait-checks.mjs", "tools/driver-upload-wait-browser.mjs"]);
run("secrets", ["test/support/scan-diff-secrets.mjs", "--unified-diff", `${out}/driver-upload.patch`,
  ...newTests, "test/support/driver-upload-wait-fixture.mjs", "tools/driver-upload-wait-checks.mjs", "tools/driver-upload-wait-browser.mjs"]);

const source = fs.readFileSync("public/driver-upload.js", "utf8");
const mutants = [
  ["idle-too-long", "const UPLOAD_IDLE_TIMEOUT_MS = 30000;", "const UPLOAD_IDLE_TIMEOUT_MS = 300000;"],
  ["confirmation-too-long", "const UPLOAD_CONFIRM_TIMEOUT_MS = 15000;", "const UPLOAD_CONFIRM_TIMEOUT_MS = 180000;"],
  ["duplicate-progress", "if (bytes > loaded)", "if (bytes >= loaded)"],
  ["ignore-resume", "const resume = () => {if (Date.now() >= expiresAt) expire();};", "const resume = () => {};"],
  ["late-wake-lock-leak", 'if (active && global.document?.visibilityState !== "hidden") lock = sentinel;', "if (true) lock = sentinel;"]
];
const kills = [];
for (const [name, from, to] of mutants) {
  assert.equal(source.split(from).length, 2, `Mutant target ${name}`);
  const file = `${out}/mutant-${name}.js`;
  fs.writeFileSync(file, source.replace(from, to));
  const outcomes = {};
  for (const [kind, files] of [["unit", [newTests[0]]], ["property", [newTests[1]]]]) {
    const child = spawnSync(process.execPath, ["--test", ...files], {encoding: "utf8", timeout: 30000,
      env: {...process.env, DRIVER_UPLOAD_MODULE_FILE: `/app/${file}`}});
    const log = child.stdout + child.stderr;
    fs.writeFileSync(`${out}/mutant-${name}-${kind}.log`, log);
    assert.equal(child.status, 1, `Surviving ${kind} mutant: ${name}`);
    assert.match(log, /not ok/u);
    assert.doesNotMatch(log, /SyntaxError|ERR_MODULE_NOT_FOUND/u);
    outcomes[kind] = "killed";
  }
  kills.push({name, ...outcomes});
}
console.log(JSON.stringify({mutations: kills}));

const covered = Object.values(JSON.parse(fs.readFileSync(`${out}/coverage/coverage-final.json`, "utf8")));
assert.equal(covered.length, 1);
const fileCoverage = covered[0];
const lineHits = new Map();
for (const [id, location] of Object.entries(fileCoverage.statementMap)) {
  for (let line = location.start.line; line <= location.end.line; line++) {
    lineHits.set(line, Math.max(lineHits.get(line) || 0, fileCoverage.s[id]));
  }
}
const changed = new Set();
for (const match of fs.readFileSync(`${out}/driver-upload.patch`, "utf8").matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
  const start = Number(match[1]);
  const count = Number(match[2] ?? 1);
  for (let line = start; line < start + count; line++) if (lineHits.has(line)) changed.add(line);
}
const uncovered = [...changed].filter(line => !lineHits.get(line));
const coverage = {changedExecutableLines: changed.size, covered: changed.size - uncovered.length, uncovered};
console.log(JSON.stringify({coverage}));
assert.ok(changed.size > 0);
assert.deepEqual(uncovered, []);

run("browser", ["tools/driver-upload-wait-browser.mjs"]);
const versions = {node: process.version, ...Object.fromEntries(["playwright", "fast-check", "eslint", "typescript", "c8"]
  .map(name => [name, JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, "utf8")).version]))};
const files = ["public/driver-upload.js", "public/driver.html", "public/driver-service-worker.js",
  "test/support/driver-upload-wait-fixture.mjs", ...newTests, "tools/driver-upload-wait-checks.mjs", "tools/driver-upload-wait-browser.mjs"];
const hashes = Object.fromEntries(files.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
const evidence = {passed: true, layers, mutations: kills, coverage, versions, hashes,
  browser: JSON.parse(fs.readFileSync(`${out}/upload-wait-browser.json`, "utf8"))};
fs.writeFileSync(`${out}/evidence.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({evidence}));
