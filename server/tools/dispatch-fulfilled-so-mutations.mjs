import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const directory = "test-artifacts/dispatch-so-fulfilled-planning";
const policy = "src/dispatch-fulfilled-so-policy.js";
const mutants = [
  ["ignore local delivery", policy, "eligible: fulfilled && !locallyCompleted && !blocked", "eligible: fulfilled && !blocked"],
  ["accept partial fulfillment", policy, "identityValid && delivery && isNetSuiteSalesOrderFulfilled(source)", "identityValid && delivery && (isNetSuiteSalesOrderFulfilled(source) || source.status === 'E')"],
  ["accept cancelled split", policy, '&& (!split || row.split_status === "active")', '&& (!split || true)'],
  ["one member grants group permission", policy, "members.every(state => state?.eligible)", "members.some(state => state?.eligible)"],
  ["scrub pending delivery", "src/sales-order-reconciliation.js", "const preserved = new Set(preservedOrderRefs.map(normalizedRef));", "const preserved = new Set();"]
];
const suites = {
  focused: ["test/dispatch/unit/dispatch-fulfilled-so-policy.test.js", "test/dispatch/frontend/dispatch-fulfilled-so-ui.test.js", "test/dispatch/integration/dispatch-fulfilled-so-planning.test.js"],
  properties: ["test/dispatch/unit/dispatch-fulfilled-so-policy.test.js"]
};
const results = [];
for (const [index, [name, file, before, after]] of mutants.entries()) {
  const root = mkdtempSync(path.join(tmpdir(), "dispatch-fulfilled-so-mutant-"));
  try {
    cpSync("src", path.join(root, "src"), { recursive: true });
    cpSync("test", path.join(root, "test"), { recursive: true });
    cpSync("public", path.join(root, "public"), { recursive: true });
    cpSync("package.json", path.join(root, "package.json"));
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
    const source = readFileSync(path.join(root, file), "utf8");
    assert.equal(source.split(before).length, 2, `Mutant ${name} must have exactly one target`);
    writeFileSync(path.join(root, file), source.replace(before, after));
    for (const [suite, files] of Object.entries(suites)) {
      const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
        cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, env: { ...process.env, NODE_V8_COVERAGE: "" }
      });
      if (run.error) { throw run.error; }
      const output = `${run.stdout}${run.stderr}`;
      writeFileSync(`${directory}/mutant-${index + 1}-${suite}.log`, output);
      const killed = run.status !== 0 && (output.includes("ERR_ASSERTION")
        || (output.includes("Property failed after") && output.includes("Counterexample:")));
      results.push({ name, suite, killed });
      assert.ok(killed, `${name} survived ${suite}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
writeFileSync(`${directory}/mutations-final.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
