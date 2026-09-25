import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scanTextForSecrets } from "../test/support/scan-diff-secrets.mjs";

const folder = path.resolve("test-artifacts/return-ra-workflow");
mkdirSync(folder, { recursive: true });
const root = process.cwd();
const sources = ["src/return-ra-workflow.js", "src/return-repository.js", "src/return-netsuite.js", "src/netsuite.js",
  "src/server.js", "src/operator-netsuite-posting-policy.js", "src/mbt/feature-gate-catalog.js",
  "public/operator.js", "public/control.js", "public/sales.js", "public/mbt-gates.js", "public/service-worker.js"];
const tests = ["test/mbt/unit/return-ra-workflow.test.js", "test/mbt/unit/return-ra-client.test.js",
  "test/mbt/integration/return-ra-workflow.test.js"];
const regressions = ["test/mbt/unit/operator-netsuite-posting-policy.red.test.js", "test/mbt/unit/operator-netsuite-posting-ui.red.test.js",
  "test/mbt/unit/operator-yard-assets.test.js", "test/mbt/integration/operator-netsuite-posting-policy-repository.red.test.js",
  "test/mbt/integration/operator-netsuite-posting-migration.test.js"];
function run(name, command, args, { cwd = root, accepted = [0] } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 100e6, timeout: 180000 });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  writeFileSync(`${folder}/${name}.log`, output);
  assert.ok(accepted.includes(result.status), `${name}: exit ${result.status}; see ${folder}/${name}.log`);
  console.log(`${name}: ${result.status}`);
  return output;
}
function clone() {
  const directory = mkdtempSync(path.join(tmpdir(), "return-ra-check-"));
  for (const name of ["src", "public", "test", "tools", "contracts", "migrations", "package.json", "tsconfig.mbt.json", "eslint.mbt.config.js"]) {
    cpSync(name, `${directory}/${name}`, { recursive: true });
  }
  symlinkSync(path.join(root, "node_modules"), `${directory}/node_modules`, "dir");
  return directory;
}
function difference(before, after) {
  const remaining = [...before];
  return after.filter(value => {
    const index = remaining.indexOf(value);
    if (index < 0) {return true;}
    remaining.splice(index, 1);
    return false;
  });
}
function restoreBaseline(directory) {
  const patch = readFileSync("test/support/return-ra-baseline.patch", "utf8");
  for (const section of patch.split(/(?=^--- a\/)/m).filter(Boolean)) {
    const rows = section.trimEnd().split("\n");
    const filename = `${directory}/${rows[0].slice(6)}`;
    const original = readFileSync(filename, "utf8").split("\n"), restored = [];
    let cursor = 0;
    for (const row of rows.slice(2)) {
      if (row.startsWith("@@")) {
        const start = Number(row.match(/^@@ -(\d+)/)[1]) - 1;
        restored.push(...original.slice(cursor, start)); cursor = start;
      } else if (row.startsWith("+")) {restored.push(row.slice(1));}
      else {
        assert.equal(original[cursor], row.slice(1), `baseline context: ${filename}:${cursor + 1}`);
        if (row.startsWith(" ")) {restored.push(original[cursor]);}
        cursor += 1;
      }
    }
    restored.push(...original.slice(cursor));
    writeFileSync(filename, restored.join("\n"));
  }
}
if (process.argv.includes("--static")) {
  const baseline = clone();
  try {
    restoreBaseline(baseline);
    const lintArgs = ["--config", path.resolve("tools/return-ra-eslint.config.mjs"), "--format=json"];
    const lint = (name, cwd, files) => JSON.parse(run(name, path.resolve("node_modules/.bin/eslint"), [...lintArgs, ...files],
      { cwd, accepted: [0, 1] })).flatMap(file => file.messages.map(m => `${path.relative(cwd, file.filePath)}:${m.ruleId}:${m.message
        .replace(/line \d+ column \d+/g, "line N column N").replace(/complexity of \d+/g, "complexity above limit")}`));
    const lintBefore = lint("lint-baseline", baseline, sources.filter(f => !f.includes("return-ra-workflow")));
    const lintAfter = lint("lint-final", root, [...sources, ...tests, "tools/return-ra-browser.mjs", "tools/return-ra-checks.mjs"]);
    const newLint = difference(lintBefore, lintAfter);
    writeFileSync(`${folder}/lint-new.json`, JSON.stringify(newLint, null, 2));
    assert.deepEqual(newLint, []);
    const typeArgs = ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"];
    const types = (name, cwd) => run(name, path.resolve("node_modules/.bin/tsc"), typeArgs, { cwd, accepted: [0, 1, 2] })
      .split("\n").filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/g, ""));
    const before = types("types-baseline", baseline), after = types("types-final", root);
    const newTypes = difference(before, after);
    writeFileSync(`${folder}/types-new.json`, JSON.stringify(newTypes, null, 2));
    assert.deepEqual(newTypes, []);
    run("types-domain", "node_modules/.bin/tsc", ["--allowJs", "--checkJs", "--strict", "--noEmit", "--skipLibCheck", "--target", "es2023", "--module", "nodenext", "src/return-ra-workflow.js"]);
    writeFileSync(`${folder}/static.json`, JSON.stringify({ lintBefore: lintBefore.length, lintAfter: lintAfter.length,
      typeErrorsBefore: before.length, typeErrorsAfter: after.length, newLint, newTypes }, null, 2));
  } finally { rmSync(baseline, { recursive: true, force: true }); }
} else if (process.argv.includes("--mutate")) {
  const mutations = [
    ["reason", "src/return-ra-workflow.js", "referenceId(line.custcol_atlas_rc_so ?? line.custcolAtlasRcSo)", '"ignored"', true],
    ["quota", "src/return-ra-workflow.js", "Number(record.palletQuantity) - credited", "Number(record.palletQuantity)", true],
    ["readback", "src/return-netsuite.js", "verifyReturnAuthorizationSnapshot({ ...record, netsuiteTransactionId: id }, snapshot);", "/* verification omitted */", false],
    ["uncertain", "src/return-repository.js", "SET netsuite_ra_attempted_at = now()", "SET netsuite_ra_attempted_at = NULL", false],
    ["approval", "src/return-repository.js", 'approvalStatus: "not_required"', 'approvalStatus: "pending"', false],
    ["gate", "src/return-repository.js", "if (actual.effective || expected)", "if (false)", false]
  ];
  const results = [];
  for (const [name, file, from, to, property] of mutations) {
    const directory = clone();
    try {
      const filename = `${directory}/${file}`, original = readFileSync(filename, "utf8");
      assert.ok(original.includes(from), name);
      writeFileSync(filename, original.replace(from, to));
      run(`mutation-${name}`, process.execPath, ["--test", "--test-concurrency=1", ...tests], { cwd: directory, accepted: [1] });
      if (property) {run(`mutation-property-${name}`, process.execPath, ["--test", "--test-name-pattern=property:", tests[0]], { cwd: directory, accepted: [1] });}
      results.push({ name, killed: true, propertyKilled: Boolean(property) });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  writeFileSync(`${folder}/mutations.json`, JSON.stringify(results, null, 2));
} else {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  run("focused", process.execPath, ["--test", "--test-concurrency=1", ...tests, ...regressions]);
  run("legacy-repository", process.execPath, ["src/return-module-harness.js"]);
  run("coverage", "node_modules/.bin/c8", ["--all=false", "--include=src/return-*.js", "--include=src/netsuite.js", "--include=src/server.js",
    "--include=src/operator-netsuite-posting-policy.js", "--include=src/mbt/feature-gate-catalog.js", "--reporter=text", "--reporter=json",
    "--reporter=json-summary", `--report-dir=${folder}/coverage`, "--temp-directory=/tmp/return-ra-c8",
    "--check-coverage=false", process.execPath, "--test", "--test-concurrency=1", ...tests]);
  const shuffled = [...tests].sort((a, b) => createHash("sha256").update(`91726:${a}`).digest("hex")
    .localeCompare(createHash("sha256").update(`91726:${b}`).digest("hex")));
  for (let i = 0; i < shuffled.length; i++) {run(`shuffled-${i}`, process.execPath, ["--test", shuffled[i]]);}
}
const hashes = Object.fromEntries(sources.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
writeFileSync(`${folder}/source-state.json`, JSON.stringify({ node: process.version, hashes }, null, 2));
const findings = sources.flatMap(file => scanTextForSecrets(readFileSync(file, "utf8"), file));
writeFileSync(`${folder}/secrets.json`, JSON.stringify(findings, null, 2));
assert.deepEqual(findings, []);
