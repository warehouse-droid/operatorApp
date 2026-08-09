import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const moduleUrl = new URL("./sales-order-reconciliation.js", import.meta.url);
const scmModuleUrl = new URL("./scm-reconciliation.js", import.meta.url);
const original = await readFile(moduleUrl, "utf8");
const scmOriginal = await readFile(scmModuleUrl, "utf8");
const relativeScmImport = 'from "./scm-reconciliation.js";';

function importSalesOrderMutant(source, name) {
  const selfContained = source.replace(
    relativeScmImport,
    `from ${JSON.stringify(scmModuleUrl.href)};`
  );
  assert.notEqual(selfContained, source,
    "The Sales Order mutation harness must rewrite its relative SCM import.");
  return import(
    `data:text/javascript;base64,${Buffer.from(`${selfContained}\n// ${name}`).toString("base64")}`
  );
}

function importScmMutant(source, name) {
  return import(
    `data:text/javascript;base64,${Buffer.from(`${source}\n// ${name}`).toString("base64")}`
  );
}

const exactPredicate = 'return label === "billed" || label === "sales order:billed";';
const mutantPredicate = 'return label.includes("bill");';
const mutantSource = original.replace(exactPredicate, mutantPredicate);
assert.notEqual(mutantSource, original, "The exact-Billed mutation target must remain reachable.");

const mutant = await importSalesOrderMutant(mutantSource, "broaden exact billed predicate");
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
  const candidate = await importSalesOrderMutant(source, mutation.name);
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

const groupedRollupCases = [
  {
    members: [
      { status: "Completed", reconciliationStatus: "ok" },
      { status: "Queued", reconciliationStatus: "ok" }
    ],
    expected: "Partially Done"
  },
  {
    members: [
      { status: "Completed", reconciliationStatus: "ok" },
      { status: "Completed", reconciliationStatus: "review" }
    ],
    expected: "Reconcile Review"
  },
  {
    members: [
      { status: "Completed", reconciliationStatus: "ok" },
      { status: "Cancelled", reconciliationStatus: "ok" }
    ],
    expected: "Completed"
  }
];
const groupedScmMutations = [
  {
    name: "complete a group when any child completes",
    from: 'active.every((member) => String(member.status || "") === "Completed")',
    to: 'active.some((member) => String(member.status || "") === "Completed")'
  },
  {
    name: "require every child to be in review",
    from: 'members.some((member) => String(member.reconciliationStatus || "") === "review")',
    to: 'members.every((member) => String(member.reconciliationStatus || "") === "review")'
  },
  {
    name: "treat only cancelled children as active",
    from: 'String(member.status || "") !== "Cancelled"',
    to: 'String(member.status || "") === "Cancelled"'
  }
];
let killedGroupedScmMutations = 0;
for (const mutation of groupedScmMutations) {
  const source = scmOriginal.replace(mutation.from, mutation.to);
  assert.notEqual(source, scmOriginal, `Mutation target is missing: ${mutation.name}.`);
  const candidate = await importScmMutant(source, mutation.name);
  const survived = groupedRollupCases.every(({ members, expected }) => (
    candidate.rollupReconciliationGroup(members).applicationStatus === expected
  ));
  if (!survived) killedGroupedScmMutations += 1;
}
assert.equal(killedGroupedScmMutations, groupedScmMutations.length,
  "Every grouped PO rollup mutant must be killed.");

const groupedPlan = {
  orders: [{
    id: "GOA-MUTATION-1-2",
    type: "SO",
    childOrders: ["SO-MUTATION-1", "SO-MUTATION-2"],
    childOrderDetails: [
      { id: "SO-MUTATION-1", type: "SO", fulfillmentStatus: "fulfilled" },
      { id: "SO-MUTATION-2", type: "SO", fulfillmentStatus: "not_fulfilled" }
    ]
  }],
  trucks: [{
    loads: [{
      orders: ["GOA-MUTATION-1-2"],
      stops: [{ orderId: "GOA-MUTATION-1-2", orderRefs: ["GOA-MUTATION-1-2"] }]
    }]
  }]
};
const groupedSalesOrderMutations = [
  {
    name: "roll up only the first SO child",
    from: "children.map(salesOrderMemberReconciliationState)",
    to: "children.slice(0, 1).map(salesOrderMemberReconciliationState)",
    killed(candidate) {
      return candidate.rollupGroupedSalesOrderReconciliation({},
        groupedPlan.orders[0].childOrderDetails).reconciliationApplicationStatus !== "Partially Done";
    }
  },
  {
    name: "retain a one-child synthetic SO group",
    from: "if (children.length === 1) return dissolvedGroupedSalesOrder(order, children[0]);",
    to: "if (children.length === 0) return dissolvedGroupedSalesOrder(order, children[0]);",
    killed(candidate) {
      const result = candidate.scrubBilledSalesOrderFamilyFromPlan(groupedPlan, {
        familyRefs: ["SO-MUTATION-1"]
      });
      return result.plan.orders[0]?.id !== "SO-MUTATION-2";
    }
  },
  {
    name: "leave the dissolved SO group stop orphaned",
    from: "if (orderReplacements.has(ref)) return text(orderReplacements.get(ref)?.id);",
    to: "if (false && orderReplacements.has(ref)) return text(orderReplacements.get(ref)?.id);",
    killed(candidate) {
      const result = candidate.scrubBilledSalesOrderFamilyFromPlan(groupedPlan, {
        familyRefs: ["SO-MUTATION-1"]
      });
      return result.plan.trucks[0].loads[0].stops[0]?.orderId !== "SO-MUTATION-2";
    }
  }
];
let killedGroupedSalesOrderMutations = 0;
for (const mutation of groupedSalesOrderMutations) {
  const source = original.replace(mutation.from, mutation.to);
  assert.notEqual(source, original, `Mutation target is missing: ${mutation.name}.`);
  const candidate = await importSalesOrderMutant(source, mutation.name);
  if (mutation.killed(candidate)) killedGroupedSalesOrderMutations += 1;
}
assert.equal(killedGroupedSalesOrderMutations, groupedSalesOrderMutations.length,
  "Every grouped SO reconciliation mutant must be killed.");

console.log(
  "Sales-order reconciliation mutation harness passed; "
  + `${policyMutations.length + groupedScmMutations.length + groupedSalesOrderMutations.length + 1}`
  + `/${policyMutations.length + groupedScmMutations.length + groupedSalesOrderMutations.length + 1} mutants killed.`
);
