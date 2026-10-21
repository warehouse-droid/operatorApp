import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { artifact, isolatedRun, integrationFile, propertyFile } from "./registered-split-planning-checks.mjs";

const root = "/tmp/registered-split-planning-mutants";
const file = "src/dispatch-fulfilled-so-repository.js";
const mutations = [
  { name: "only-first-split-recognized", before: "/-s[1-9][0-9]*$/u.test(ref)", after: 'ref.endsWith("-s1")' },
  { name: "inactive-registration-accepted", before: "split.active = true AND ", after: "" },
  { name: "derived-definition-accepted", before: " AND split.definition_kind = 'split'", after: "" },
  { name: "wrong-parent-association-accepted", before: "       AND lower(btrim(split.split_ref)) = lower(btrim(split.parent_order_ref))\n           || substring(lower(btrim(split.split_ref)) FROM '-s[1-9][0-9]*$')", after: "" },
  { name: "materialized-lifecycle-overridden", before: "       AND NOT EXISTS (SELECT 1 FROM sales_orders materialized\n                        WHERE lower(btrim(materialized.tranid)) = lower(btrim(split.split_ref)))", after: "" },
  { name: "alias-completion-ignored", before: "parent.operationally_completed || alias.operationally_completed", after: "parent.operationally_completed" }
];

function makeCandidate(mutation) {
  const candidate = `${root}/${mutation.name}`;
  mkdirSync(candidate);
  for (const dir of ["src", "public", "test", "migrations", "contracts"]) {cpSync(dir, `${candidate}/${dir}`, { recursive: true });}
  cpSync("package.json", `${candidate}/package.json`);
  symlinkSync("/app/node_modules", `${candidate}/node_modules`);
  const path = `${candidate}/${file}`;
  const original = readFileSync(path, "utf8");
  assert.equal(original.split(mutation.before).length, 2, mutation.name);
  writeFileSync(path, original.replace(mutation.before, mutation.after));
  return candidate;
}

rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const results = [];
try {
  for (const mutation of mutations) {
    const candidate = makeCandidate(mutation);
    const core = await isolatedRun(integrationFile, { cwd: candidate, prefix: `mutation-${mutation.name}-integration` });
    const property = await isolatedRun(propertyFile, { cwd: candidate, prefix: `mutation-${mutation.name}-property` });
    for (const result of [core, property]) {
      assert.notEqual(result.exit, 0, `Surviving mutant ${mutation.name}: ${result.file}`);
      assert.ok(result.failures.length, `No behavioral assertion failed: ${mutation.name}: ${result.file}`);
    }
    results.push({ name: mutation.name, killedByIntegration: true, killedByProperty: true,
      integrationFailures: core.failures, propertyFailures: property.failures });
    console.log(JSON.stringify(results.at(-1)));
    rmSync(candidate, { recursive: true, force: true });
  }
} finally {rmSync(root, { recursive: true, force: true });}
writeFileSync(`${artifact}/mutations.json`, JSON.stringify(results, null, 2));
