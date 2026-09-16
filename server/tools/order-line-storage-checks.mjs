import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const folder = "test-artifacts/order-line-storage";
const baseline = path.resolve(`${folder}/baseline`);
const manifest = JSON.parse(readFileSync(`${folder}/changes.json`, "utf8"));
const hash = source => createHash("sha256").update(source).digest("hex");
const sources = Object.fromEntries(manifest.map(row => [row.file, hash(readFileSync(row.file))]));
for (const row of manifest) {assert.equal(sources[row.file], row.afterSha256);}
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

const unit = ["test/mbt/unit/netsuite-order-line.test.js", "test/mbt/unit/netsuite-order-line-sync.test.js",
  "test/mbt/unit/netsuite-order-line-backfill.test.js"];
const integration = ["test/mbt/integration/netsuite-order-line-storage.test.js", "test/mbt/integration/netsuite-order-line-backfill.test.js"];
const focus = [...unit, ...integration, "test/mbt/unit/netsuite-order-webhook-financials.test.js",
  "test/mbt/unit/smart-scm-created-po-service.test.js", "test/mbt/unit/sn1400333-receiving.test.js",
  "test/mbt/integration/operator-receiving-allocations.test.js", "test/dispatch/integration/dispatch-reconciliation-completed-planning.red.test.js"];

if (process.argv.includes("--static")) {
  const types = output => output.split("\n").filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/u, "")).sort();
  const args = ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"];
  const before = types(run("types-baseline", path.resolve("node_modules/.bin/tsc"), args, { cwd: baseline, accept: result => result.status <= 2 }));
  const after = types(run("types-final", "node_modules/.bin/tsc", args, { accept: result => result.status <= 2 }));
  const remaining = [...before];
  const newErrors = after.filter(error => {const index = remaining.indexOf(error); if (index < 0) {return true;} remaining.splice(index, 1); return false;});
  writeFileSync(`${folder}/types-new.json`, JSON.stringify(newErrors, null, 2));
  assert.deepEqual(newErrors, []);
  const files = manifest.filter(row => /\.(js|mjs)$/u.test(row.file));
  const lintArgs = ["--config", path.resolve("tools/order-line-storage-eslint.config.mjs"), "--format=json"];
  const lintRows = (name, root, names) => JSON.parse(run(name, path.resolve("node_modules/.bin/eslint"), [...lintArgs, ...names],
    { cwd: root, accept: result => result.status <= 1 })).flatMap(file => file.messages.map(message =>
      `${path.relative(root, file.filePath)}:${message.ruleId}:${message.message.replace(/line \d+ column \d+/gu, "line N column N")}`)).sort();
  const lintBefore = lintRows("lint-baseline", baseline, files.filter(row => row.beforeSha256).map(row => row.file));
  const lintAfter = lintRows("lint-final", process.cwd(), files.map(row => row.file));
  const oldLint = [...lintBefore];
  const newLint = lintAfter.filter(error => {const index = oldLint.indexOf(error); if (index < 0) {return true;} oldLint.splice(index, 1); return false;});
  writeFileSync(`${folder}/lint-new.json`, JSON.stringify(newLint, null, 2));
  assert.deepEqual(newLint, []);
  writeFileSync(`${folder}/static.json`, JSON.stringify({ baselineTypeErrors: before.length, finalTypeErrors: after.length,
    newTypeErrors: 0, baselineLint: lintBefore.length, finalLint: lintAfter.length, newLint: 0, sources }, null, 2));
} else {
  run("focused-final", process.execPath, ["--test", "--test-concurrency=1", ...focus]);
  const shuffled = [...focus].sort((a, b) => hash(`1400333:${a}`).localeCompare(hash(`1400333:${b}`)));
  run("shuffled", process.execPath, ["--test", "--test-concurrency=1", ...shuffled]);
  const included = manifest.filter(row => row.file.startsWith("src/")).map(row => `--include=${row.file}`);
  run("coverage", "node_modules/.bin/c8", ["--all=false", "--check-coverage=false", ...included,
    `--temp-directory=${folder}/c8`, `--report-dir=${folder}/coverage`, "--reporter=json", "--reporter=text",
    process.execPath, "--test", "--test-concurrency=1", ...focus]);
  const coverage = Object.values(JSON.parse(readFileSync(`${folder}/coverage/coverage-final.json`, "utf8")));
  const changed = manifest.filter(row => row.file.startsWith("src/")).map(row => {
    const file = coverage.find(entry => entry.path === path.resolve(row.file));
    const lines = row.changedLines.filter(line => readFileSync(row.file, "utf8").split("\n")[line - 1].trim()
      && !/^\s*(?:\/\/|\*|[{};]+\s*$)/u.test(readFileSync(row.file, "utf8").split("\n")[line - 1]));
    const covered = lines.filter(line => file && Object.entries(file.statementMap).some(([id, range]) =>
      range.start.line <= line && range.end.line >= line && file.s[id] > 0));
    return { file: row.file, lines: lines.length, covered: covered.length, missing: lines.filter(line => !covered.includes(line)) };
  });
  const changedLineCoverage = changed.reduce((sum, row) => sum + row.covered, 0) / changed.reduce((sum, row) => sum + row.lines, 0);
  assert.ok(changedLineCoverage >= 0.90, `Changed executable lines: ${changedLineCoverage}`);
  const domainBranches = coverage.filter(file => /netsuite-order-line(?:-backfill)?\.js$/u.test(file.path)).map(file => {
    const branches = Object.values(file.b).flat();
    const ratio = branches.filter(value => value > 0).length / branches.length;
    assert.ok(ratio >= 0.90, `${file.path} branch coverage ${ratio}`);
    return { file: file.path, ratio };
  });
  const mutants = [
    ["unique key fallback", "src/netsuite-order-line.js", "return parsed[0] ?? null;", "return parsed[0] ?? line?.line_id ?? null;", unit[0]],
    ["receiving accounting line", "src/netsuite-order-line.js", "orderLine: anchor.orderLine", "orderLine: line.orderLine", unit[0]],
    ["ignore conflicting aliases", "src/netsuite-order-line.js", "new Set(parsed).size > 1", "new Set(parsed).size > 999", unit[0]],
    ["wrong source accepted", "src/netsuite-order-line-backfill.js", "`${row.order_id}:${row.line_id}`", "`${row.line_id}`", unit[2]],
    ["wrong item accepted", "src/netsuite-order-line-backfill.js", "String(remote.item_id) === String(row.item_id)", "true", unit[2]]
  ];
  for (const [index, [name, file, from, to, testFile]] of mutants.entries()) {
    const root = mkdtempSync(path.join(tmpdir(), "orderline-mutant-"));
    for (const directory of ["src", "test"]) {cpSync(directory, path.join(root, directory), { recursive: true });}
    cpSync("package.json", path.join(root, "package.json"));
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"));
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes(from), name);
    writeFileSync(path.join(root, file), source.replaceAll(from, to));
    try {
      for (const layer of ["unit", "property"]) {
        run(`mutant-${index}-${layer}`, process.execPath, ["--test", `--test-name-pattern=${layer === "property" ? "^property:" : "^(?!property:)"}`, testFile],
          { cwd: root, accept: (result, output) => result.status !== 0 && /ERR_ASSERTION|Property failed after/u.test(output) });
      }
    } finally {rmSync(root, { recursive: true, force: true });}
  }
  run("restored", process.execPath, ["--test", ...unit]);
  writeFileSync(`${folder}/checks.json`, JSON.stringify({ node: process.version, changed, changedLineCoverage, domainBranches, sources, mutationKills: mutants.length,
    propertyMutationKills: mutants.length, shuffleSeed: 1400333, shuffled }, null, 2));
}
