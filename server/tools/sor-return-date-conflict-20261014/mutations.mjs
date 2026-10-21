import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

export async function runMutations({ snapshot, tests, reset, out, primary }) {
  const mutants = [
    { name: "linked custom parents again conflict with deliveries", file: "src/server.js",
      from: 'const explicitParent = customOrder ? "" : String(order?.originalOrderId || order?.parentOrderRef || "").trim();',
      to: 'const explicitParent = String(order?.originalOrderId || order?.parentOrderRef || "").trim();' },
    { name: "custom projections again create parent aliases", file: "src/dispatch-planner-v2-repository.js",
      from: 'function splitParentRef(order = {}, orderReference = "") {',
      to: 'function splitParentRef(order = {}, orderReference = "") {\n  if (text(order?.originalOrderId || order?.parentOrderRef)) {return text(order?.originalOrderId || order?.parentOrderRef);}' },
    { name: "legacy custom markers ignored by date guard", file: "src/server.js",
      from: '|| order?.customOrder === true\n      || String(order?.sourceTable || "").trim().toLowerCase() === "dispatch_custom_orders";',
      to: '|| false;' },
    { name: "genuine split parent projection lost", file: "src/dispatch-planner-v2-repository.js",
      from: 'if (explicitParent) {return explicitParent;}', to: 'if (explicitParent) {return "";}' },
    { name: "exact duplicate custom returns allowed", file: "src/server.js",
      from: 'if (!key || (!otherPlan.refs.has(key) && (!parent || !otherPlan.wholeOrderRefs.has(parent)))) continue;',
      to: 'if (!key || !parent || (!otherPlan.refs.has(key) && !otherPlan.wholeOrderRefs.has(parent))) continue;' }
  ];
  const results = [];
  for (const [index, mutant] of mutants.entries()) {
    const root = snapshot();
    try {
      const file = root + "/" + mutant.file, original = readFileSync(file, "utf8");
      assert.equal(original.split(mutant.from).length - 1, 1, "Mutation anchor must be unique");
      writeFileSync(file, original.replace(mutant.from, mutant.to));
      assert.equal(spawnSync(process.execPath, ["--check", file]).status, 0);
      reset();
      const result = tests("mutant-" + index, primary, { cwd: root });
      assert.ok(result.fail > 0 && result.exit !== 0 && !/SyntaxError:|ERR_MODULE_NOT_FOUND/u.test(result.log), mutant.name + " survived or failed on infrastructure");
      reset();
      const property = tests("mutant-property-" + index, primary.slice(0, 1), { cwd: root, pattern: "property:" });
      assert.ok(property.fail > 0 && property.exit !== 0, mutant.name + " survived the property suite");
      results.push({ name: mutant.name, killed: true, failures: result.failures, propertyKilled: true });
      writeFileSync(out + "/mutations.json", JSON.stringify(results, null, 2) + "\n");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}
