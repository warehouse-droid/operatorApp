import assert from "node:assert/strict";
import crypto from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const folder = "test-artifacts/consolidation-group-planning";
mkdirSync(folder, { recursive: true });
const manifest = JSON.parse(readFileSync("test/consolidation-group-planning-changes.json", "utf8"));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
for (const entry of manifest) {assert.equal(hash(readFileSync(entry.file)), entry.afterSha256, `${entry.file} changed since evidence capture`);}
const ownTests = ["test/mbt/integration/consolidation-group-planning.test.js"];
const tests = [...ownTests, "test/mbt/integration/consolidation-load.test.js", "test/mbt/unit/consolidation-load.test.js", "test/mbt/unit/consolidation-load-posting.test.js"];
const records = [];
function run(name, command, args, { cwd = process.cwd(), accept = (result) => result.status === 0 } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 100e6 });
  assert.ifError(result.error);
  const output = `${result.stdout}${result.stderr}`;
  writeFileSync(`${folder}/${name}.log`, output);
  const accepted = accept(result, output);
  records.push({ name, exitCode: result.status, accepted });
  console.log(JSON.stringify(records.at(-1)));
  const suffix = process.argv.includes("--full") ? "-full" : process.argv.includes("--baseline-full") ? "-baseline" : "";
  writeFileSync(`${folder}/checks${suffix}.json`, JSON.stringify(records, null, 2));
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
  run("tool-versions", process.execPath, ["--input-type=module", "-e", 'import {readFileSync} from "node:fs"; console.log(JSON.stringify({node:process.version,...Object.fromEntries(["typescript","eslint","c8","fast-check","playwright"].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]))}));']);
  run("focused-final", process.execPath, ["--test", "--test-concurrency=1", ...tests]);
  const shuffled = [...tests].sort((a, b) => hash(`16092026:${a}`).localeCompare(hash(`16092026:${b}`)));
  for (const [index, file] of shuffled.entries()) {run(`shuffled-${index}`, process.execPath, ["--test", file]);}
  const includes = manifest.filter((entry) => entry.file.startsWith("src/") && entry.file !== "src/server.js").map((entry) => `--include=${entry.file}`);
  run("coverage", "node_modules/.bin/c8", ["--all=false", "--check-coverage=false", ...includes,
    `--temp-directory=${folder}/c8`, `--report-dir=${folder}/coverage`, "--reporter=json", "--reporter=text", process.execPath, "--test", "--test-concurrency=1", ...tests]);
  const baseline = baselineCopy();
  try {
    const before = run("types-baseline-final", path.resolve("node_modules/.bin/tsc"), ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"], { cwd: baseline, accept: (result) => result.status <= 2 });
    run("types-final", "node_modules/.bin/tsc", ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"], { accept: (_result, output) => { assert.deepEqual(typeErrors(output), typeErrors(before)); return true; } });
    const lintFiles = manifest.map((entry) => entry.file).filter((file) => file.endsWith(".mjs") || (file.endsWith(".js") && (file.startsWith("src/") || file.startsWith("test/mbt/"))));
    const lintArgs = ["--config", "tools/consolidation-load-eslint.config.mjs", "--format=json", "--max-warnings=0"];
    const previous = run("lint-baseline-final", path.resolve("node_modules/.bin/eslint"), [...lintArgs, ...lintFiles.filter((file) => existsSync(path.join(baseline, file)))], { cwd: baseline, accept: (result) => result.status <= 1 });
    run("lint-final", "node_modules/.bin/eslint", [...lintArgs, ...lintFiles], { accept: (_result, output) => { assert.deepEqual(lintErrors(output), lintErrors(previous)); return true; } });
  } finally {rmSync(baseline, { recursive: true, force: true });}
  for (const entry of manifest.filter((item) => /^(?:src|public)\/.*\.js$/.test(item.file))) {run(`syntax-${path.basename(entry.file)}`, process.execPath, ["--check", entry.file]);}
}
