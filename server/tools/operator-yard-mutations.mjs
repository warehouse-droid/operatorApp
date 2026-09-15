import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const root = process.cwd();
const directory = "test-artifacts/operator-yard-access";
const cases = [
  ["Sales grants substitute for Operator grants", "src/operator-yard-access.js", "operator?.operatorYardLocationIds", "operator?.yardLocationIds"],
  ["Unassigned accounts inherit all yards", "src/operator-yard-access.js", "return normalizeOperatorYardLocationIds(operator?.operatorYardLocationIds);", "return normalizeOperatorYardLocationIds(operator?.operatorYardLocationIds?.length ? operator.operatorYardLocationIds : OPERATOR_YARD_LOCATION_IDS);"],
  ["Any assignment permits every requested yard", "src/operator-yard-access.js", "if (!requireAssignedOperatorYards(operator).includes(id)) throw operatorYardForbidden();", "requireAssignedOperatorYards(operator);"],
  ["Grouped records ignore an unauthorized child yard", "src/operator-yard-authorization.js", "for (const child of order.child_orders || []) assertOperatorYard(operator, child.outbound_location_id ?? child.source_location_id);", "/* mutant: child authorization omitted */"],
  ["Record guard ignores the canonical stored yard", "src/operator-yard-authorization.js", "assertOperatorYard(operator, receiving ? order.destination_location_id : order.outbound_location_id ?? order.source_location_id);", "requireAssignedOperatorYards(operator);"]
];
const reports = [];
for (const [index, [name, file, original, mutation]] of cases.entries()) {
  const sandbox = mkdtempSync(path.join(tmpdir(), "operator-yard-mutant-"));
  try {
    cpSync("src", path.join(sandbox, "src"), { recursive: true });
    cpSync("public", path.join(sandbox, "public"), { recursive: true });
    cpSync("package.json", path.join(sandbox, "package.json"));
    for (const testFile of ["test/mbt/unit/operator-yard-access.test.js", "test/mbt/integration/operator-yard-access.test.js", "test/support/operator-ui-enhancements-fixture.mjs"]) {
      mkdirSync(path.dirname(path.join(sandbox, testFile)), { recursive: true });
      cpSync(testFile, path.join(sandbox, testFile));
    }
    symlinkSync(path.join(root, "node_modules"), path.join(sandbox, "node_modules"), "dir");
    const target = path.join(sandbox, file);
    const source = readFileSync(target, "utf8");
    assert.equal(source.split(original).length, 2, `Mutation anchor changed: ${name}`);
    writeFileSync(target, source.replace(original, mutation));
    const stages = [];
    for (const [stage, pattern] of [["focused", "Operator grants|grant normalization|admin primary|property:"], ["properties-only", "property:"]]) {
      const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", `--test-name-pattern=${pattern}`,
        "test/mbt/unit/operator-yard-access.test.js", "test/mbt/integration/operator-yard-access.test.js"], {
        cwd: sandbox, encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: "" }, timeout: 60000
      });
      const output = `${result.stdout || ""}${result.stderr || ""}`;
      writeFileSync(`${directory}/mutation-${index + 1}-${stage}.log`, output);
      const killed = result.status !== 0 && /ERR_ASSERTION|Property failed after/.test(output) && !/ERR_MODULE_NOT_FOUND|SyntaxError/.test(output);
      stages.push({ stage, killed, exitCode: result.status });
      assert.ok(killed, `Mutation survived or failed for a non-behavioral reason: ${name} (${stage})`);
    }
    reports.push({ name, file, stages });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}
writeFileSync(`${directory}/mutations.json`, `${JSON.stringify(reports, null, 2)}\n`);
console.log(JSON.stringify({ mutants: reports.length, focusedKilled: reports.length, propertiesOnlyKilled: reports.length }));
