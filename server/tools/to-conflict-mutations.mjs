import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const directory = "test-artifacts/to-conflict-cleanup-20260915";
const mutants = [
  ["retain stale quantities", 'line[field] = numericText(remote[source]);', 'line[field] = field === "quantity" ? line[field] : numericText(remote[source]);'],
  ["leave current lines inactive", 'line_id: String(remote.sourceLineKey), netsuite_active: true', 'line_id: String(remote.sourceLineKey), netsuite_active: false'],
  ["double count accounting rows", '...original, netsuite_active: false', '...original, netsuite_active: true'],
  ["erase received quantity", 'Math.max(remote.quantity, remote.cumulativeProgressQuantity || 0)', '0'],
  ["accept partial NetSuite status", 'assert((remote.status === "G" && label === "received") || (remote.status === "F" && label === "pending receipt"), "NetSuite does not confirm full shipment");', 'assert(label, "NetSuite does not confirm full shipment");']
];
const results = [];
for (const [index, [name, before, after]] of mutants.entries()) {
  const root = mkdtempSync(path.join(tmpdir(), "to-conflict-mutant-"));
  try {
    for (const folder of ["src", "test", "tools"]) {cpSync(folder, path.join(root, folder), { recursive: true });}
    cpSync("package.json", path.join(root, "package.json"));
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    const file = path.join(root, "tools/to-conflict-domain.mjs"), source = readFileSync(file, "utf8");
    assert.equal(source.split(before).length, 2, name); writeFileSync(file, source.replace(before, after));
    for (const propertyOnly of [false, true]) {
      const run = spawnSync(process.execPath, ["--test", ...(propertyOnly ? ["--test-name-pattern=property:"] : []), "test/dispatch/unit/to-conflict-cleanup.test.js"],
        { cwd: root, encoding: "utf8", maxBuffer: 6 * 1024 * 1024, env: { ...process.env, NODE_V8_COVERAGE: "" } });
      if (run.error) {throw run.error;}
      const output = run.stdout + run.stderr, killed = run.status !== 0 && (output.includes("ERR_ASSERTION") || output.includes("Counterexample:"));
      writeFileSync(`${directory}/mutant-${index}-${propertyOnly ? "property" : "unit"}.log`, output);
      results.push({ name, propertyOnly, killed }); assert(killed, `${name} survived`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
writeFileSync(`${directory}/mutations.json`, JSON.stringify(results, null, 2) + "\n"); console.log(JSON.stringify(results));
