import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const moduleUrl = new URL("./sales-order-reconciliation.js", import.meta.url);
const original = await readFile(moduleUrl, "utf8");
const exactPredicate = 'return label === "billed" || label === "sales order:billed";';
const mutantPredicate = 'return label.includes("bill");';
const mutantSource = original.replace(exactPredicate, mutantPredicate);
assert.notEqual(mutantSource, original, "The exact-Billed mutation target must remain reachable.");

const mutantUrl = `data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}`;
const mutant = await import(mutantUrl);
const exactBilledSpec = [
  [{ status: "G" }, true],
  [{ statusText: "Sales Order : Billed" }, true],
  [{ statusText: "Pending Billing" }, false],
  [{ statusText: "Pending Billing/Partially Fulfilled" }, false],
  [{ statusText: "Billed (closed)" }, false]
];

const killedBy = exactBilledSpec.filter(([input, expected]) => (
  mutant.isNetSuiteSalesOrderBilled(input) !== expected
));
assert.ok(
  killedBy.length > 0,
  "The exact-Billed contract must kill a broader billing-label predicate."
);

const policyCandidates = [
  { kind: "SO", id: 101 },
  { kind: "SO", id: 102 },
  { kind: "SO", id: 201 },
  { kind: "PO", id: 201 },
  { kind: "TO", id: 301 }
];
const policyLocalSources = [
  { kind: "SO", id: 101 },
  { kind: "PO", id: 201 }
];
const expectedPolicyKeys = ["SO:101", "PO:201", "TO:301"];
const policyMutations = [
  {
    name: "retain NetSuite-only SO",
    from: "return Boolean(id && localSalesOrderIds.has(id));",
    to: "return Boolean(id);"
  },
  {
    name: "remove PO/TO candidates",
    from: 'if (text(candidate?.kind).toUpperCase() !== "SO") return true;',
    to: 'if (text(candidate?.kind).toUpperCase() !== "SO") return false;'
  },
  {
    name: "let a local PO identity authorize an SO",
    from: '.filter((source) => text(source?.kind).toUpperCase() === "SO")',
    to: ".filter(() => true)"
  }
];

let killedPolicyMutations = 0;
for (const mutation of policyMutations) {
  const source = original.replace(mutation.from, mutation.to);
  assert.notEqual(source, original, `Mutation target is missing: ${mutation.name}.`);
  const candidate = await import(
    `data:text/javascript;base64,${Buffer.from(`${source}\n// ${mutation.name}`).toString("base64")}`
  );
  const actual = candidate.filterDbBackedSalesOrderReconciliationCandidates(
    policyCandidates,
    policyLocalSources
  ).map((entry) => `${entry.kind}:${entry.id}`);
  try {
    assert.deepEqual(actual, expectedPolicyKeys);
  } catch {
    killedPolicyMutations += 1;
  }
}
assert.equal(killedPolicyMutations, policyMutations.length,
  "Every DB-only Sales Order policy mutant must be killed.");

console.log(
  `Sales-order reconciliation mutation harness passed; ${policyMutations.length + 1}/${policyMutations.length + 1} mutants killed.`
);
