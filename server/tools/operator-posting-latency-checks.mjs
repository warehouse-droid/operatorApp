import assert from "node:assert/strict";
import crypto from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const folder = "test-artifacts/operator-posting-latency";
mkdirSync(folder, { recursive: true });
const manifest = JSON.parse(readFileSync("test/operator-posting-latency-changes.json", "utf8"));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
for (const entry of manifest) {assert.equal(hash(readFileSync(entry.file)), entry.afterSha256, `${entry.file} changed since evidence capture`);}
const ownTests = ["test/mbt/unit/operator-posting-latency.test.js", "test/mbt/unit/operator-posting-photo-client.test.js", "test/mbt/unit/operator-receiving-return.test.js",
  "test/mbt/integration/operator-posting-photos.test.js", "test/mbt/integration/operator-posting-http-timing.test.js", "test/mbt/integration/operator-receiving-completed.test.js"];
const tests = [...ownTests, ...["admission", "domain", "service", "targets", "runtime", "runtime-adapters", "ui"].map((part) => `test/mbt/unit/operator-netsuite-posting-${part}.red.test.js`),
  "test/mbt/property/operator-netsuite-posting.property.test.js", "test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js",
  "test/mbt/integration/consolidation-load.test.js", "test/mbt/integration/operator-receiving-allocations.test.js",
  "test/mbt/unit/operator-yard-assets.test.js", "test/mbt/unit/operations-navigation-enhancements.test.js", "test/mbt/unit/operator-customer-pickup-photo-gate-ui.contract.test.js", "test/mbt/unit/operator-page-confirm-ui.contract.test.js",
  "test/mbt/unit/smart-scm-created-po-service.test.js", "test/mbt/integration/migration-upgrade.test.js", "test/mbt/integration/p3-predeploy-readiness.test.js"];
const records = [];
function run(name, command, args, { cwd = process.cwd(), accept = (result) => result.status === 0 } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 100e6 });
  assert.ifError(result.error);
  const output = `${result.stdout}${result.stderr}`;
  writeFileSync(`${folder}/${name}.log`, output);
  const accepted = accept(result, output);
  records.push({ name, exitCode: result.status, accepted });
  console.log(JSON.stringify(records.at(-1)));
  writeFileSync(`${folder}/checks.json`, JSON.stringify(records, null, 2));
  assert.ok(accepted, `${name} failed; see ${folder}/${name}.log`);
  return output;
}
function baselineCopy() {
  const target = mkdtempSync(path.join(tmpdir(), "posting-baseline-"));
  for (const name of ["src", "public", "migrations", "test", "tools"]) {cpSync(name, path.join(target, name), { recursive: true });}
  for (const name of ["package.json", "tsconfig.mbt.json", "eslint.mbt.config.js"]) {cpSync(name, path.join(target, name));}
  symlinkSync(path.resolve("node_modules"), path.join(target, "node_modules"));
  for (const entry of manifest) {
    const file = path.join(target, entry.file);
    if (!entry.beforeSha256) {rmSync(file); continue;}
    const lines = readFileSync(file, "utf8").match(/[^\n]*\n|[^\n]+$/g) || [];
    for (const edit of [...entry.edits].reverse()) {lines.splice(edit.start, edit.end - edit.start, ...edit.before);}
    const text = lines.join("");
    assert.equal(hash(text), entry.beforeSha256);
    writeFileSync(file, text);
  }
  for (const name of ["operator-posting-latency-checks.mjs", "operator-posting-latency-browser.mjs", "operator-posting-latency-mutations.mjs"]) {
    rmSync(path.join(target, "tools", name), { force: true });
  }
  return target;
}
const failNames = (output) => [...new Set([...output.matchAll(/^(?:not ok \d+ - |✖ )(.+?)(?: \([\d.]+ms\))?$/gm)].map((match) => match[1]).filter((name) => name !== "failing tests:"))].sort();
const typeErrors = (output) => output.split("\n").filter((line) => /error TS\d+/.test(line)).map((line) => line.replace(/\(\d+,\d+\)/, "")).sort();
const lintErrors = (output) => JSON.parse(output).flatMap((file) => file.messages.map((message) =>
  `${file.filePath.replace(/^.*\/(src|test|tools)\//, "$1/")}:${message.ruleId}:${message.severity}:${message.message}`)).sort();

if (process.argv.includes("--baseline-full")) {
  const copy = baselineCopy();
  try {run("baseline-full", "npm", ["test"], { cwd: copy, accept: (result) => result.status <= 1 });}
  finally {rmSync(copy, { recursive: true, force: true });}
} else if (process.argv.includes("--full")) {
  assert.ok(existsSync(`${folder}/baseline-full.log`));
  const expected = failNames(readFileSync(`${folder}/baseline-full.log`, "utf8"));
  assert.equal(expected.length, 2, "Expected the two recorded infrastructure failures only");
  run("full-final", "npm", ["test"], { accept: (result, output) => {
    assert.equal(result.status, 1); assert.deepEqual(failNames(output), expected);
    assert.match(output, /Isolated MBT main run failed in 2\/\d+ file\(s\):/); return true;
  } });
} else {
  run("focused-final", process.execPath, ["--test", "--test-concurrency=1", ...tests]);
  const shuffled = [...ownTests].sort((a, b) => hash(`16092026:${a}`).localeCompare(hash(`16092026:${b}`)));
  for (const [index, file] of shuffled.entries()) {run(`shuffled-${index}`, process.execPath, ["--test", file]);}
  const includes = manifest.filter((entry) => entry.file.startsWith("src/") && entry.file !== "src/server.js").map((entry) => `--include=${entry.file}`);
  run("coverage", "node_modules/.bin/c8", ["--all=false", "--check-coverage=false", ...includes,
    `--temp-directory=${folder}/c8`, `--report-dir=${folder}/coverage`, "--reporter=json", "--reporter=text", process.execPath, "--test", "--test-concurrency=1", ...tests]);
  const baseline = baselineCopy();
  try {
    const before = run("types-baseline-final", path.resolve("node_modules/.bin/tsc"), ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"], { cwd: baseline, accept: (result) => result.status <= 2 });
    run("types-final", "node_modules/.bin/tsc", ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"], { accept: (_result, output) => { assert.deepEqual(typeErrors(output), typeErrors(before)); return true; } });
    const lintFiles = manifest.map((entry) => entry.file).filter((file) => file.endsWith(".mjs") || (file.endsWith(".js") && (file.startsWith("src/operator-netsuite-posting-") || file.startsWith("test/mbt/"))));
    const lintArgs = ["--config", "eslint.mbt.config.js", "--format=json", "--max-warnings=0"];
    const previous = run("lint-baseline-final", path.resolve("node_modules/.bin/eslint"), [...lintArgs, ...lintFiles.filter((file) => existsSync(path.join(baseline, file)))], { cwd: baseline, accept: (result) => result.status <= 1 });
    run("lint-final", "node_modules/.bin/eslint", [...lintArgs, ...lintFiles], { accept: (_result, output) => { assert.deepEqual(lintErrors(output), lintErrors(previous)); return true; } });
  } finally {rmSync(baseline, { recursive: true, force: true });}
  for (const entry of manifest.filter((item) => /^(?:src|public)\/.*\.js$/.test(item.file))) {run(`syntax-${path.basename(entry.file)}`, process.execPath, ["--check", entry.file]);}
}
