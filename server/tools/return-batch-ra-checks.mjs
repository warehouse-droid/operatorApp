import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scanTextForSecrets } from "../test/support/scan-diff-secrets.mjs";
const root = process.cwd();
const folder = path.resolve("test-artifacts/return-batch-ra");
const files = ["src/return-batch-ra-domain.js", "src/return-batch-ra-service.js", "src/return-repository.js",
  "src/history-repository.js", "src/server.js", "public/operator.js", "public/control.js", "public/sales.js"];
const tests = ["test/mbt/unit/return-batch-ra-domain.test.js", "test/mbt/unit/return-ra-workflow.test.js",
  "test/mbt/unit/return-ra-client.test.js", "test/mbt/integration/return-batch-ra.test.js",
  "test/mbt/integration/return-ra-workflow.test.js", "test/mbt/integration/stock-return-draft-insert.test.js"];
function run(name, args, { cwd = root, accepted = [0] } = {}) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", maxBuffer: 100e6, timeout: 180000 });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  writeFileSync(`${folder}/${name}.log`, output);
  assert.ok(accepted.includes(result.status), `${name}: exit ${result.status}; see log`);
  console.log(`${name}: ${result.status}`);
  return output;
}
function clone(baseline = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "return-batch-ra-"));
  for (const name of ["src", "public", "test", "tools", "contracts", "migrations", "package.json", "tsconfig.mbt.json", "eslint.mbt.config.js"]) {
    cpSync(name, `${dir}/${name}`, { recursive: true });
  }
  symlinkSync(path.join(root, "node_modules"), `${dir}/node_modules`, "dir");
  if (baseline) {
    const patch = readFileSync("test/support/return-batch-ra-baseline.patch", "utf8");
    for (const section of patch.split(/(?=^--- a\/)/m).filter(Boolean)) {
      const rows = section.trimEnd().split("\n");
      const filename = `${dir}/${rows[0].slice(6)}`;
      const original = readFileSync(filename, "utf8").split("\n"), restored = [];
      let cursor = 0;
      for (const row of rows.slice(2)) {
        if (row.startsWith("@@")) {
          const first = Number(row.match(/^@@ -(\d+)/)[1]) - 1;
          restored.push(...original.slice(cursor, first)); cursor = first;
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
    for (const name of files.filter(f => f.includes("return-batch-ra-"))) rmSync(`${dir}/${name}`);
  }
  return dir;
}
function difference(before, after) {
  const remaining = [...before];
  return after.filter(value => { const index = remaining.indexOf(value); if (index < 0) return true; remaining.splice(index, 1); return false; });
}
if (process.argv.includes("--static")) {
  const baseline = clone(true);
  try {
    const lint = (name, cwd, selected) => JSON.parse(run(name, [path.resolve("node_modules/eslint/bin/eslint.js"),
      "--config", path.resolve("tools/return-ra-eslint.config.mjs"), "--format=json", ...selected], { cwd, accepted: [0, 1] }))
      .flatMap(file => file.messages.map(m => `${path.relative(cwd,file.filePath)}:${m.ruleId}:${m.message.replace(/line \d+ column \d+/g, "line N column N").replace(/complexity of \d+/g, "complexity above limit")}`));
    const before = lint("lint-baseline", baseline, files.filter(f => !f.includes("return-batch-ra-")));
    const after = lint("lint-final", root, [...files, ...tests]);
    const added = difference(before, after);
    writeFileSync(`${folder}/lint-new.json`, JSON.stringify(added, null, 2));
    assert.deepEqual(added, []);
    const typeArgs = [path.resolve("node_modules/typescript/bin/tsc"), "--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"];
    const diagnostics = text => text.split("\n").filter(line => /error TS\d+/.test(line)).map(line => line.replace(/\(\d+,\d+\)/g, ""));
    const typeBefore = diagnostics(run("types-baseline", typeArgs, { cwd: baseline, accepted: [0,1,2] }));
    const typeAfter = diagnostics(run("types-final", typeArgs, { accepted: [0,1,2] }));
    const addedTypes = difference(typeBefore, typeAfter);
    writeFileSync(`${folder}/types-new.json`, JSON.stringify(addedTypes, null, 2));
    assert.deepEqual(addedTypes, []);
    run("types-domain", ["node_modules/typescript/bin/tsc", "--allowJs", "--checkJs", "--strict", "--noEmit", "--skipLibCheck", "--target", "es2023", "--module", "nodenext", "src/return-batch-ra-domain.js"]);
    assert.deepEqual(scanTextForSecrets(readFileSync("test/support/return-batch-ra-baseline.patch", "utf8")
      + files.filter(file => file.includes("return-batch-ra-")).map(file => readFileSync(file, "utf8")).join("\n"), "return-batch-ra-change"), []);
    writeFileSync(`${folder}/static.json`, JSON.stringify({ lintBefore: before.length, lintAfter: after.length,
      typeBefore: typeBefore.length, typeAfter: typeAfter.length, newLint: added, newTypes: addedTypes }));
  } finally { rmSync(baseline, { recursive: true, force: true }); }
} else if (process.argv.includes("--mutate")) {
  const faults = [
    ["batch-rows", "src/return-batch-ra-domain.js", 'kind: "pallet", itemId, returnedSalesQuantity: quantity', 'kind: "pallet", itemId, returnedSalesQuantity: quantity + 1', true],
    ["wrong-yard", "src/return-batch-ra-domain.js", 'location: { id: String(intent.receivingLocationId) }', 'location: { id: "999" }', true],
    ["lost-marker", "src/return-batch-ra-service.js", 'SET attempted_at=now(),sync_attempts', 'SET attempted_at=NULL,sync_attempts', false],
    ["no-readback", "src/return-batch-ra-service.js", 'verifyReturnBatchSnapshot({ ...batch.intent_snapshot, netSuiteTransactionId: transactionId }, snapshot, { allowInactive: reconcile || Boolean(batch.netsuite_transaction_id) });', '/* readback omitted */', false],
    ["wrong-history", "src/history-repository.js", "THEN r.netsuite_transaction_ref END", "THEN NULL END", false],
    ["duplicate-source-key", "src/return-batch-ra-domain.js", 'line.kind === "stock" && !seen.has(line.netSuiteOrderLine)', 'line.kind === "stock"', false],
    ["release-unobserved-stock", "src/return-repository.js", "Number(row.quantity) - counted", "0", false],
    ["wrong-native-units", "src/return-batch-ra-domain.js", "expectedUnits && reference(row.units) !== expectedUnits", "false", false]
  ];
  const results = [];
  for (const [name,file,original,replacement,property] of faults) {
    const dir = clone();
    try {
      const text = readFileSync(`${dir}/${file}`, "utf8");
      assert.ok(text.includes(original), name);
      writeFileSync(`${dir}/${file}`, text.replace(original,replacement));
      const selected = property ? ["test/mbt/unit/return-batch-ra-domain.test.js"] : ["test/mbt/integration/return-batch-ra.test.js"];
      const output = run(`mutant-${name}`, ["--test", ...selected], { cwd: dir, accepted: [1] });
      assert.match(output, /not ok/);
      if (property) run(`mutant-property-${name}`, ["--test", "--test-name-pattern=generated", ...selected], { cwd: dir, accepted: [1] });
      results.push({ name, killed: true, propertyOnly: property });
    } finally { rmSync(dir,{recursive:true,force:true}); }
  }
  writeFileSync(`${folder}/mutations.json`,JSON.stringify(results,null,2));
} else {
  run("coverage-tests", ["node_modules/c8/bin/c8.js", "--all=false", "--include=src/return-*.js", "--include=src/history-repository.js",
    "--check-coverage=false", "--reporter=json", "--reporter=text", `--report-dir=${folder}/coverage`,
    "--temp-directory=/tmp/return-batch-ra-c8", process.execPath, "--test", "--test-concurrency=1", ...tests]);
  run("return-harness", ["src/return-module-harness.js"]);
  run("final-focused", ["--test", "--test-concurrency=1", ...tests.slice().reverse()]);
}
