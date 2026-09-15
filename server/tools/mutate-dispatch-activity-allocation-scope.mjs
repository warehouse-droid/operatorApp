import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const root = await mkdtemp(join(tmpdir(), "activity-allocation-mutants-"));
try {
  await cp("src", join(root, "src"), { recursive: true });
  await cp("test", join(root, "test"), { recursive: true });
  await cp("package.json", join(root, "package.json"));
  await symlink(join(process.cwd(), "node_modules"), join(root, "node_modules"));
  const path = join(root, "src/dispatch-load-assignment.js");
  const original = await readFile(path, "utf8");
  const mutants = [
    ["restore unrelated catalog matching", "if (assigned.has(text(order.id)))", "if (true)"],
    ["ignore all cargo", "return JSON.stringify(allocations);", "return '[]';"],
    ["omit secondary pickup refs", "...(Array.isArray(stop.orderRefs) ? stop.orderRefs : [])", "...[]"],
    ["omit nested assigned orders", "for (const child of order.childOrderDetails || []) visit(child);", "for (const child of []) visit(child);"]
  ];
  for (const [name, from, to] of mutants) {
    assert.equal(original.split(from).length, 2, `Mutant anchor is not unique: ${name}`);
    for (const propertiesOnly of [false, true]) {
      await writeFile(path, original.replace(from, to));
      const result = spawnSync(process.execPath, ["--test", ...(propertiesOnly ? ["--test-name-pattern=property:"] : []),
        "test/dispatch/unit/dispatch-activity-allocation-scope.test.js"], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 1, `Mutant survived or failed to execute: ${name}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /not ok/, name);
      console.log(JSON.stringify({ mutant: name, propertiesOnly, killed: true }));
    }
    await writeFile(path, original);
    assert.equal(await readFile(path, "utf8"), original);
  }
  const restored = spawnSync(process.execPath, ["--test", "test/dispatch/unit/dispatch-activity-allocation-scope.test.js"],
    { cwd: root, encoding: "utf8" });
  assert.equal(restored.status, 0, restored.stdout + restored.stderr);
  // Regression armor: the pre-existing route/reassignment behavior must also
  // fail its assertions if somebody bypasses all execution checks.
  const policyPath = join(root, "src/dispatch-planner-performance.js");
  const policySource = await readFile(policyPath, "utf8");
  const anchor = "export function evaluateExecutedPrefixPolicy({ previousPlan = {}, nextPlan = {}, activity = [] } = {}) {";
  assert.equal(policySource.split(anchor).length, 2);
  for (const propertiesOnly of [false, true]) {
    await writeFile(policyPath, policySource.replace(anchor, `${anchor}\nreturn { allowed: true, conflicts: [] };`));
    const result = spawnSync(process.execPath, ["--test", ...(propertiesOnly ? ["--test-name-pattern=property:"] : []),
      "test/dispatch/unit/dispatch-activity-allocation-scope.test.js"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    if (!propertiesOnly) { assert.match(result.stdout, /not ok \d+ - route and driver identity changes/); }
    console.log(JSON.stringify({ mutant: "bypass all execution checks", propertiesOnly, killed: true }));
  }
  await writeFile(policyPath, policySource);
  assert.equal(await readFile(policyPath, "utf8"), policySource);
  const final = spawnSync(process.execPath, ["--test", "test/dispatch/unit/dispatch-activity-allocation-scope.test.js"],
    { cwd: root, encoding: "utf8" });
  assert.equal(final.status, 0, final.stdout + final.stderr);
  console.log(JSON.stringify({ restored: true, mutantsKilled: mutants.length + 1, propertiesKilled: mutants.length + 1 }));
} finally {
  await rm(root, { recursive: true, force: true });
}
