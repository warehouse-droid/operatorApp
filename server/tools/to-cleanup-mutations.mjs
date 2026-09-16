import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const directory = "test-artifacts/to-cleanup-20260915";
const mutants = [
  ["ignore Driver completion", "src/dispatch-fulfilled-to-policy.js", "eligible: fulfilled && !locallyCompleted && !blocked", "eligible: fulfilled && !blocked"],
  ["accept partial transfer", "src/dispatch-fulfilled-to-policy.js", '(order.status === "F" && label === "pending receipt")', '(order.status === "E" || (order.status === "F" && label === "pending receipt"))'],
  ["receive shipments before receipt", "tools/to-cleanup-domain.mjs", 'Boolean(evidence?.status === "G" || options.locallyReceived)', 'Boolean(evidence || options.locallyReceived)'],
  ["overwrite the other transfer stage", "tools/to-cleanup-domain.mjs", 'line.line_stage === "outbound" && outbound', 'line.line_stage && outbound'],
  ["one group member permits planning", "src/dispatch-fulfilled-to-policy.js", 'eligible: members.every(state => state?.eligible)', 'eligible: members.some(state => state?.eligible)']
];
const results = [];
for (const [i, [name, file, before, after]] of mutants.entries()) {
  const root = mkdtempSync(path.join(tmpdir(), "to-cleanup-mutant-"));
  try {
    for (const dir of ["src", "test", "tools"]) {cpSync(dir, path.join(root, dir), { recursive: true });}
    cpSync("package.json", path.join(root, "package.json"));
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    const source = readFileSync(path.join(root, file), "utf8"); assert.equal(source.split(before).length, 2, name);
    writeFileSync(path.join(root, file), source.replace(before, after));
    for (const propertyOnly of [false, true]) {
      const run = spawnSync(process.execPath, ["--test", ...(propertyOnly ? ["--test-name-pattern=property:"] : []), "test/dispatch/unit/to-cleanup.test.js"],
        { cwd: root, encoding: "utf8", maxBuffer: 5 * 1024 * 1024, env: { ...process.env, NODE_V8_COVERAGE: "" } });
      if (run.error) {throw run.error;}
      const output = run.stdout + run.stderr, killed = run.status !== 0 && (output.includes("ERR_ASSERTION") || output.includes("Counterexample:"));
      writeFileSync(`${directory}/mutant-${i}-${propertyOnly ? "property" : "unit"}.log`, output);
      results.push({ name, propertyOnly, killed }); assert(killed, `${name} survived`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
writeFileSync(`${directory}/mutations.json`, `${JSON.stringify(results, null, 2)}\n`); console.log(JSON.stringify(results));
