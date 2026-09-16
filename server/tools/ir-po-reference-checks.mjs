import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scanTextForSecrets } from "../test/support/scan-diff-secrets.mjs";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const folder = "test-artifacts/ir-po-reference";
const unit = "test/mbt/unit/ir-po-reference.test.js";
const integration = "test/mbt/integration/ir-po-reference-http.test.js";
const manifest = JSON.parse(readFileSync("test/ir-po-reference-changes.json", "utf8"));
const hash = source => createHash("sha256").update(source).digest("hex");
const domain = manifest[0].file;
const source = readFileSync(domain, "utf8");
const recordingBaseline = process.argv.includes("--record-baseline");
assert.equal(hash(source), recordingBaseline ? manifest[0].beforeSha256 : manifest[0].afterSha256);
const before = recordingBaseline ? source : manifest[0].groups.reduce((value, group) => value.replace(group.after, group.before), source);
assert.equal(hash(before), manifest[0].beforeSha256);
mkdirSync(folder, { recursive: true });

function run(name, command, args, { cwd = process.cwd(), accept = result => result.status === 0 } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 100e6 });
  assert.ifError(result.error);
  const output = `${result.stdout}${result.stderr}`;
  writeFileSync(`${folder}/${name}.log`, output);
  const accepted = accept(result, output);
  console.log(JSON.stringify({ name, exitCode: result.status, accepted }));
  assert.ok(accepted, `${name} failed: ${folder}/${name}.log`);
  return output;
}

function copySource(replacement, omitNewTests = false) {
  const root = mkdtempSync(path.join(tmpdir(), "ir-reference-"));
  for (const directory of ["src", "public", "test", "tools", "migrations"]) {cpSync(directory, path.join(root, directory), { recursive: true });}
  for (const file of ["package.json", "tsconfig.mbt.json", "eslint.mbt.config.js"]) {cpSync(file, path.join(root, file));}
  symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"));
  writeFileSync(path.join(root, domain), replacement);
  if (omitNewTests) {for (const file of [unit, integration]) {rmSync(path.join(root, file));}}
  return root;
}

const errors = output => output.split("\n").filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/, "")).sort();

if (recordingBaseline || process.argv.includes("--record-full")) {
  // Independent isolated runs are compared strictly by ir-po-reference-evidence.py.
  run(recordingBaseline ? "baseline-full" : "full-final", "npm", ["test"], { accept: result => result.status <= 1 });
} else {
  for (const name of ["coverage", "c8"]) {rmSync(`${folder}/${name}`, { recursive: true, force: true });}
  const red = copySource(before);
  try {
    run("red-reproduced", process.execPath, ["--test", "--test-concurrency=1", unit, integration],
      { cwd: red, accept: (result, output) => result.status === 1 && /# fail 5\n/.test(output) && /ERR_ASSERTION/.test(output) });
  } finally {rmSync(red, { recursive: true, force: true });}
  const tests = [unit, integration, "test/mbt/unit/sn1400333-receiving.test.js",
    "test/mbt/unit/operator-netsuite-posting-domain.red.test.js", "test/mbt/unit/operator-netsuite-posting-targets.red.test.js",
    "test/mbt/unit/operator-netsuite-posting-service.red.test.js", "test/mbt/unit/operator-netsuite-posting-runtime-adapters.red.test.js",
    "test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js", "test/mbt/property/operator-netsuite-posting.property.test.js",
    "test/mbt/integration/operator-receiving-allocations.test.js", "test/mbt/integration/operator-posting-http-timing.test.js"];
  run("focused-final", process.execPath, ["--test", "--test-concurrency=1", ...tests]);
  const shuffled = [...tests].sort((a, b) => hash(`14634:${a}`).localeCompare(hash(`14634:${b}`)));
  for (const [index, file] of shuffled.entries()) {run(`shuffled-${index}`, process.execPath, ["--test", file]);}
  run("coverage", "node_modules/.bin/c8", ["--all=false", "--check-coverage=false", `--include=${domain}`,
    `--temp-directory=${folder}/c8`, `--report-dir=${folder}/coverage`, "--reporter=json", "--reporter=text",
    process.execPath, "--test", "--test-concurrency=1", unit, integration]);
  const coverage = Object.values(JSON.parse(readFileSync(`${folder}/coverage/coverage-final.json`, "utf8")))[0];
  const changed = manifest[0].changedLines.map(line => ({ line, count: Math.max(0, ...Object.entries(coverage.statementMap)
    .filter(([, range]) => range.start.line <= line && range.end.line >= line).map(([id]) => coverage.s[id])) }));
  assert.ok(changed.every(row => row.count > 0));
  const baseline = copySource(before, true);
  let baselineTypes;
  try {
    const args = ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"];
    baselineTypes = errors(run("types-baseline", path.resolve("node_modules/.bin/tsc"), args, { cwd: baseline, accept: result => result.status <= 2 }));
    run("types-final", "node_modules/.bin/tsc", args, { accept: (_result, output) => {
      assert.deepEqual(errors(output), baselineTypes); return true;
    } });
  } finally {rmSync(baseline, { recursive: true, force: true });}
  const files = [domain, unit, integration, "tools/ir-po-reference-checks.mjs", "tools/ir-po-reference-live.mjs"];
  run("lint", "node_modules/.bin/eslint", ["--config", "eslint.mbt.config.js", "--max-warnings=0", ...files]);
  for (const file of files) {assert.deepEqual(scanTextForSecrets(readFileSync(file, "utf8"), file), []);}
  const mutants = [
    ["omit Ref No", "custbody9: group.memo", "custbody8: group.memo"],
    ["use parent PO as Ref No", "custbody9: group.memo", "custbody9: group.sourceOrderRef"],
    ["omit Memo", "memo: group.memo, custbody9:", "custbody9:"],
    ["send empty Ref No", "custbody9: group.memo", 'custbody9: ""']
  ];
  for (const [index, [name, from, to]] of mutants.entries()) {
    assert.equal(source.split(from).length, 2, name);
    const root = copySource(source.replace(from, to));
    try {
      for (const layer of ["unit", "property"]) {
        run(`mutant-${index}-${layer}`, process.execPath, ["--test", ...(layer === "property" ? ["--test-name-pattern=property:"] : []), unit],
          { cwd: root, accept: (result, output) => result.status !== 0 && /ERR_ASSERTION|Property failed after/.test(output) });
      }
    } finally {rmSync(root, { recursive: true, force: true });}
  }
  run("restored", process.execPath, ["--test", unit]);
  const versions = Object.fromEntries(["typescript", "eslint", "c8", "fast-check"].map(name => [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]));
  writeFileSync(`${folder}/summary.json`, JSON.stringify({ node: process.version, versions, changed,
    baselineTypeErrors: baselineTypes.length, newTypeErrors: 0, mutationKills: mutants.length, propertyMutationKills: mutants.length,
    shuffleSeed: 14634, shuffled, sources: Object.fromEntries(files.map(file => [file, hash(readFileSync(file))])) }, null, 2));
}
