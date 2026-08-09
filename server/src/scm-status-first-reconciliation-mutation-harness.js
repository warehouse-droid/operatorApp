import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const scmModuleUrl = new URL("./scm-reconciliation.js", import.meta.url);
const operationalModuleUrl = new URL("./netsuite-operational-work.js", import.meta.url);
const originals = {
  scm: await readFile(scmModuleUrl, "utf8"),
  operational: await readFile(operationalModuleUrl, "utf8")
};

function replaceExact(source, from, to, name) {
  const count = source.split(from).length - 1;
  assert.equal(count, 1, `${name}: mutation target drifted`);
  return source.replace(from, to);
}

function importMutant(source, name) {
  return import(
    `data:text/javascript;base64,${Buffer.from(`${source}\n// mutant: ${name}`).toString("base64")}`
  );
}

const exactPo = (statusText) => ({
  kind: "PO",
  statusText,
  lines: [{
    stage: "receiving",
    sourceLineKey: "101",
    identityStatus: "exact",
    quantity: 10,
    cumulativeProgressQuantity: 0,
    cumulativeProgressObserved: true
  }]
});

const exactTo = (statusText) => ({
  kind: "TO",
  statusText,
  lines: [
    {
      stage: "outbound",
      sourceLineKey: "201",
      logicalLineIdentity: "transfer-anchor:201",
      identityStatus: "exact",
      quantity: 10
    },
    {
      stage: "receiving",
      sourceLineKey: "202",
      logicalLineIdentity: "transfer-anchor:201",
      identityStatus: "exact",
      quantity: 10
    }
  ]
});

const mutations = [
  {
    name: "drop PO Pending Billing and Billed terminal shortcuts",
    source: "scm",
    from: "? lifecycle.received || lifecycle.pendingBilling || lifecycle.billed",
    to: "? lifecycle.received",
    async killed(candidate) {
      return candidate.derivePoToReconciliationState({
        kind: "PO",
        statusText: "Purchase Order : Pending Billing",
        orderedQty: 10
      }).applicationStatus !== "Completed";
    }
  },
  {
    name: "treat Partially Received as exact Received",
    source: "scm",
    from: 'received: !partiallyReceived && exactLeaf("received"),',
    to: 'received: /\\breceived\\b/.test(text),',
    async killed(candidate) {
      return candidate.shouldFetchPoToLinkedTransactions(
        exactPo("Purchase Order : Partially Received")
      ) !== true;
    }
  },
  {
    name: "skip linked evidence for an active split or pinned allocation",
    source: "scm",
    from: "if (linkedEvidenceSensitive || order.headerOnlyFallback === true) return true;",
    to: "if (order.headerOnlyFallback === true) return true;",
    async killed(candidate) {
      return candidate.shouldFetchPoToLinkedTransactions(
        exactPo("Purchase Order : Pending Billing"),
        { linkedEvidenceSensitive: true }
      ) !== true;
    }
  },
  {
    name: "skip a terminal TO that lacks one of its two line stages",
    source: "scm",
    from: `  if (kind === "TO") {
    const stages = new Set(lines.map((line) => String(line.stage || "").trim().toLowerCase()));
    if (!stages.has("outbound") || !stages.has("receiving")) return true;
  }
`,
    to: "",
    async killed(candidate) {
      const oneStage = {
        ...exactTo("Transfer Order : Received"),
        lines: exactTo("Transfer Order : Received").lines.filter((line) =>
          line.stage === "receiving"
        )
      };
      return candidate.shouldFetchPoToLinkedTransactions(oneStage) !== true;
    }
  },
  {
    name: "leak an internal receiving status into the transport schedule",
    source: "scm",
    from: 'return manuallyPreserved.has(value) ? value : "Queued";',
    to: 'return value || "Queued";',
    async killed(candidate) {
      return candidate.derivePoToReconciliationState({
        kind: "TO",
        statusText: "Transfer Order : Pending Fulfillment",
        orderedQty: 10,
        previousStatus: "not_received"
      }).applicationStatus !== "Queued";
    }
  },
  {
    name: "leak the operational NetSuite slot after work finishes",
    source: "operational",
    from: "activeCount -= 1;",
    to: "activeCount += 0;",
    async killed(candidate) {
      const registry = candidate.createNetSuiteOperationalWorkRegistry();
      await registry.run("returns.pending", async () => {});
      return registry.isActive() !== false;
    }
  }
];

let killed = 0;
for (const mutation of mutations) {
  const source = replaceExact(
    originals[mutation.source],
    mutation.from,
    mutation.to,
    mutation.name
  );
  const candidate = await importMutant(source, mutation.name);
  if (await mutation.killed(candidate)) {
    killed += 1;
    console.log(`[mutation] killed: ${mutation.name}`);
  }
}

assert.equal(
  killed,
  mutations.length,
  `Every status-first reconciliation mutant must be killed (${killed}/${mutations.length}).`
);
console.log(`Status-first reconciliation mutation harness passed: ${killed}/${mutations.length} mutants killed.`);
