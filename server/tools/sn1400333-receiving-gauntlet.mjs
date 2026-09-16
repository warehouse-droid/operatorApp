import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scanTextForSecrets } from "../test/support/scan-diff-secrets.mjs";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const folder = "test-artifacts/sn1400333-receiving";
const testFile = "test/mbt/unit/sn1400333-receiving.test.js";
const manifest = JSON.parse(readFileSync("test/sn1400333-receiving-changes.json", "utf8"));
const runtime = manifest.map(change => change.file);
const hash = source => createHash("sha256").update(source).digest("hex");
const current = Object.fromEntries(runtime.map(file => [file, readFileSync(file, "utf8")]));
const before = {};
for (const change of manifest) {
  assert.equal(hash(current[change.file]), change.afterSha256);
  let source = current[change.file];
  for (const block of change.groups) {
    assert.equal(source.split(block.after).length, 2);
    source = source.replace(block.after, block.before);
  }
  assert.equal(hash(source), change.beforeSha256);
  before[change.file] = source;
}
mkdirSync(folder, { recursive: true });
const results = [];

function run(name, command, args, { cwd = process.cwd(), accept } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 100e6 });
  assert.ifError(result.error);
  const output = `${result.stdout}${result.stderr}`;
  writeFileSync(`${folder}/${name}.log`, output);
  const accepted = accept ? accept(result, output) : result.status === 0;
  results.push({ name, exitCode: result.status, accepted });
  writeFileSync(`${folder}/gauntlet.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.at(-1)));
  assert.ok(accepted, `${name} failed: ${folder}/${name}.log`);
  return output;
}

function sourceCopy(replacements) {
  const root = mkdtempSync(path.join(tmpdir(), "sn1400333-"));
  for (const directory of ["src", "public", "test", "tools", "migrations"]) {
    cpSync(directory, path.join(root, directory), { recursive: true });
  }
  for (const file of ["package.json", "tsconfig.mbt.json", "eslint.mbt.config.js"]) {
    cpSync(file, path.join(root, file));
  }
  symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  for (const [file, source] of Object.entries(replacements)) { writeFileSync(path.join(root, file), source); }
  return root;
}

function failures(output) {
  return [...new Set([...output.matchAll(/^(?:not ok \d+ - |✖ )(.+?)(?: \([\d.]+ms\))?$/gm)]
    .map(match => match[1]).filter(name => name !== "failing tests:"))].sort();
}

const baseline = sourceCopy(before);
try {
  if (process.argv.includes("--baseline-full")) {
    rmSync(path.join(baseline, testFile));
    run("baseline-full", "npm", ["test"], { cwd: baseline, accept: result => result.status <= 1 });
    process.exit(0);
  }
  if (process.argv.includes("--full")) {
    const expected = failures(readFileSync(`${folder}/baseline-full.log`, "utf8"));
    assert.ok(expected.length < 10, "Full-suite baseline must be a valid migrated environment");
    run("full", "npm", ["test"], { accept: (_result, output) => {
      assert.deepEqual(failures(output), expected);
      return true;
    } });
    process.exit(0);
  }
  for (const artifact of ["coverage", "c8"]) { rmSync(`${folder}/${artifact}`, { recursive: true, force: true }); }
  const tests = [testFile, "test/mbt/unit/operator-netsuite-posting-domain.red.test.js",
    "test/mbt/unit/operator-netsuite-posting-targets.red.test.js",
    "test/mbt/unit/operator-netsuite-posting-service.red.test.js",
    "test/mbt/unit/operator-netsuite-posting-runtime-adapters.red.test.js",
    "test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js",
    "test/mbt/property/operator-netsuite-posting.property.test.js",
    "test/mbt/integration/operator-receiving-allocations.test.js"];
  run("focused", process.execPath, ["--test", "--test-concurrency=1", ...tests]);
  // Node sorts multi-file arguments. Separate processes enforce the seeded order.
  const shuffled = [...tests].sort((left, right) => hash(`1400333:${left}`).localeCompare(hash(`1400333:${right}`)));
  const shuffledOutput = shuffled.map((file, index) => run(`shuffled-${index + 1}`, process.execPath,
    ["--test", file])).join("\n");
  writeFileSync(`${folder}/shuffled.log`, shuffledOutput);
  run("coverage", "node_modules/.bin/c8", ["--all=false", "--check-coverage=false",
    ...runtime.map(file => `--include=${file}`), `--temp-directory=${folder}/c8`,
    `--report-dir=${folder}/coverage`, "--reporter=json", "--reporter=text",
    process.execPath, "--test", "--test-concurrency=1", ...tests]);
  const coverage = Object.values(JSON.parse(readFileSync(`${folder}/coverage/coverage-final.json`, "utf8")));
  const counts = manifest.flatMap(change => change.changedLines.map(line => {
    const report = coverage.find(file => file.path.endsWith(`/${change.file}`));
    assert.ok(report);
    const count = Math.max(0, ...Object.entries(report.statementMap)
      .filter(([, range]) => range.start.line <= line && range.end.line >= line).map(([key]) => report.s[key]));
    return { file: change.file, line, count };
  }));
  assert.ok(counts.every(line => line.count > 0), JSON.stringify(counts));
  writeFileSync(`${folder}/changed-coverage.json`, JSON.stringify({ covered: counts.length, total: counts.length, counts }, null, 2));

  const typeArgs = ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"];
  const errors = output => output.split("\n").filter(line => /error TS\d+/.test(line))
    .map(line => line.replace(/\(\d+,\d+\)/, "")).sort();
  const priorTypes = run("types-baseline", path.resolve("node_modules/.bin/tsc"), typeArgs,
    { cwd: baseline, accept: result => result.status <= 2 });
  const types = run("types", "node_modules/.bin/tsc", typeArgs, { accept: (_result, output) => {
    assert.deepEqual(errors(output), errors(priorTypes)); return true;
  } });
  const files = [...runtime, testFile, "tools/sn1400333-receiving-gauntlet.mjs", "tools/sn1400333-receiving-live.mjs"];
  run("lint", "node_modules/.bin/eslint", ["--config", "eslint.mbt.config.js", "--max-warnings=0", ...files]);
  for (const file of files) { assert.deepEqual(scanTextForSecrets(readFileSync(file, "utf8"), file), []); }
  const domain = "src/operator-netsuite-posting-domain.js";
  const targets = "src/operator-netsuite-posting-targets.js";
  const mutants = [
    [domain, "restore completed receipt lines", '.filter((available) => transactionType !== "IR" || available.remainingQuantity !== 0)', "", true],
    [domain, "omit receipt memo", '...(group.memo ? { memo: group.memo } : {}),', "", true],
    [targets, "use parent reference as memo", '{ memo: String(order.tranid || "").trim() }', '{ memo: "POB03658" }', false],
    [domain, "accept conflicting receipt memo", 'if (group.memo && memo && group.memo !== memo)', 'if (false)', false],
    [domain, "drop open deselected lines", 'available.remainingQuantity !== 0)', 'available.remainingQuantity !== 0 && group.selectedByLine.has(available.orderLine))', true],
    [domain, "drop unknown receipt quantities", 'available.remainingQuantity !== 0)', 'available.remainingQuantity > 0)', false],
    [domain, "change fulfillment completed lines", 'transactionType !== "IR" || available.remainingQuantity !== 0', 'available.remainingQuantity !== 0', false]
  ];
  const mutationResults = [];
  for (const [index, [file, name, original, replacement, property]] of mutants.entries()) {
    assert.equal(current[file].split(original).length, 2, name);
    const root = sourceCopy({ [file]: current[file].replace(original, replacement) });
    try {
      for (const layer of property ? ["focused", "property"] : ["focused"]) {
        run(`mutant-${index + 1}-${layer}`, process.execPath,
          ["--test", ...(layer === "property" ? ["--test-name-pattern=property:"] : []), testFile],
          { cwd: root, accept: (result, output) => result.status !== 0 && /ERR_ASSERTION|Property failed after/.test(output) });
        mutationResults.push({ name, layer, killed: true });
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  run("restored", process.execPath, ["--test", testFile]);
  writeFileSync(`${folder}/summary.json`, JSON.stringify({ node: process.version,
    shuffleSeed: 1400333, shuffledFiles: shuffled,
    typesBaseline: errors(priorTypes).length, typesCurrent: errors(types).length,
    changedLinesCovered: counts.length, changedLinesTotal: counts.length, mutationResults,
    sources: Object.fromEntries(files.map(file => [file, hash(readFileSync(file))])) }, null, 2));
} finally {
  rmSync(baseline, { recursive: true, force: true });
}
