import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scanTextForSecrets } from "../test/support/scan-diff-secrets.mjs";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const folder = "test-artifacts/operator-direct-orderline";
const baseline = path.resolve(`${folder}/baseline/server`);
const manifest = JSON.parse(readFileSync(`${folder}/changes.json`, "utf8"));
const hash = source => createHash("sha256").update(source).digest("hex");
const sources = Object.fromEntries(manifest.map(row => [row.file, hash(readFileSync(row.file))]));
for (const row of manifest) {assert.equal(sources[row.file], row.afterSha256);}
mkdirSync(folder, { recursive: true });
const findings = manifest.flatMap(row => {
  const lines = readFileSync(row.file, "utf8").split("\n");
  return row.changedLines.flatMap(line => scanTextForSecrets(lines[line - 1] || "", row.file).map(finding => ({...finding, line})));
});
writeFileSync(`${folder}/secrets.json`, JSON.stringify(findings, null, 2));
assert.deepEqual(findings, []);

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

const unit = ["test/mbt/unit/operator-direct-orderline-service.test.js", "test/mbt/unit/operator-direct-orderline-pool.test.js"];
const integration = ["test/mbt/integration/operator-direct-orderline.test.js", "test/mbt/integration/operator-direct-orderline-http.test.js"];
const focus = [...unit, ...integration, ...JSON.parse(readFileSync(`${folder}/focus.json`, "utf8"))];

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
  const lintArgs = ["--config", path.resolve("tools/operator-direct-orderline-eslint.config.mjs"), "--format=json"];
  const lintRows = (name, root, names) => JSON.parse(run(name, path.resolve("node_modules/.bin/eslint"), [...lintArgs, ...names],
    { cwd: root, accept: result => result.status <= 1 })).flatMap(file => file.messages.map(message =>
      `${path.relative(root, file.filePath)}:${message.ruleId}:${message.message.replace(/line \d+ column \d+/gu, "line N column N")
        .replace(/has a complexity of \d+/gu, "has a complexity above the limit")}`)).sort();
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
  const shuffled = [...focus].sort((a, b) => hash(`160920:${a}`).localeCompare(hash(`160920:${b}`)));
  // node:test sorts CLI filenames; separate processes preserve the actual seeded
  // order, while retaining the same isolated database to expose fixture leaks.
  const shuffledOutput = shuffled.map((file, index) => run(`shuffle-${index}`, process.execPath, ["--test", file])).join("\n");
  writeFileSync(`${folder}/shuffled.log`, shuffledOutput);
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
  writeFileSync(`${folder}/changed-coverage.json`, JSON.stringify({changed, changedLineCoverage}, null, 2));
  assert.equal(changedLineCoverage, 1, "Every changed executable backend line must be exercised");
  const domainBranches = coverage.filter(file => /operator-netsuite-(?:posting-stored-lines|request-pool)\.js$/u.test(file.path)).map(file => {
    const branches = Object.values(file.b).flat();
    const ratio = branches.filter(value => value > 0).length / branches.length;
    
    return { file: file.path, ratio };
  });
  const mutants = [
    ["resumed attempt can transform", "src/operator-netsuite-posting-service.js", "!direct || attempt.fresh === true", "true", unit[0]],
    ["fresh command scans history", "src/operator-netsuite-posting-service.js", "direct && mayTransform ? null", "false ? null", unit[0]],
    ["cached totals clamp selected quantity", "src/operator-netsuite-posting-domain.js", "!direct && available.remainingQuantity !== null", "available.remainingQuantity !== null", integration[0]],
    ["missing orderLine guessed from stable key", "src/operator-netsuite-posting-stored-lines.js", "Number(row.netsuite_order_line)", "Number(row.netsuite_order_line || row.source_line_key)", integration[0]],
    ["request pool ignores limit", "src/operator-netsuite-request-pool.js", "active < limit", "active < 999", unit[1]],
    ["mixed legacy and direct snapshot", "src/operator-netsuite-posting-domain.js", "if (direct && !input.targets.every", "if (false && !input.targets.every", integration[0]],
    ["verification rejection loses remote uncertainty", "src/operator-netsuite-posting-service.js", "remoteMayExist || isAmbiguousOperatorNetSuiteFailure(error)", "isAmbiguousOperatorNetSuiteFailure(error)", unit[0]]
  ];
  const probes = [...mutants, ["invalid pool limit accepted", "src/operator-netsuite-request-pool.js",
    "if (!Number.isSafeInteger(limit) || limit < 1)", "if (false)", unit[1]]];
  for (const [index, [name, file, from, to, testFile]] of probes.entries()) {
    const root = mkdtempSync(path.join(tmpdir(), "operator-direct-mutant-"));
    for (const directory of ["src", "test"]) {cpSync(directory, path.join(root, directory), { recursive: true });}
    cpSync("package.json", path.join(root, "package.json"));
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"));
    const source = readFileSync(file, "utf8");
    assert.ok(source.includes(from), name);
    writeFileSync(path.join(root, file), source.replaceAll(from, to));
    try {
      for (const layer of index < mutants.length ? ["unit", "property"] : ["unit"]) {
        run(`mutant-${index}-${layer}`, process.execPath, ["--test", `--test-name-pattern=${layer === "property" ? "^property:" : "^(?!property:)"}`, testFile],
          { cwd: root, accept: (result, output) => result.status !== 0 && /ERR_ASSERTION|Property failed after/u.test(output) });
      }
    } finally {rmSync(root, { recursive: true, force: true });}
  }
  run("restored", process.execPath, ["--test", ...unit]);
  writeFileSync(`${folder}/checks.json`, JSON.stringify({ node: process.version, changed, changedLineCoverage, domainBranches, sources, mutationKills: mutants.length,
    propertyMutationKills: mutants.length, regressionGuardMutationKills: probes.length - mutants.length, shuffleSeed: 160920, shuffled }, null, 2));
}
