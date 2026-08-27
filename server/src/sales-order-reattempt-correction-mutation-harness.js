import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const moduleUrl = new URL("./sales-order-reattempt-correction.js", import.meta.url);
const original = await readFile(moduleUrl, "utf8");

function replaceExact(source, from, to) {
  assert.equal(source.split(from).length - 1, 1, `Mutation target count changed: ${from}`);
  return source.replace(from, to);
}

function importMutant(source, name) {
  const encoded = Buffer.from(`${source}\n// mutant: ${name}`).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

const line = Object.freeze({
  itemId: 3631,
  sku: "HISTORICAL-CG",
  historicalItemId: 3631,
  historicalSku: "HISTORICAL-CG",
  salesQty: 1470.08,
  pallets: 16
});
const correction = Object.freeze({
  correctionId: 44,
  afterItemId: 3632,
  afterSku: "CURRENT-GN",
  targetSalesQty: 1470.08,
  targetPalletQty: 16
});
const fingerprintState = Object.freeze({
  childOrderId: 128,
  cycleId: 2,
  parentSalesOrderId: 945867,
  netsuiteLineId: 4760329,
  beforeItemId: 3631,
  beforeSku: "HISTORICAL-CG",
  afterItemId: 3632,
  afterSku: "CURRENT-GN",
  currentSalesQty: 1470.08,
  currentPalletQty: 16,
  targetSalesQty: 1470.08,
  targetPalletQty: 16,
  childStatus: "completed",
  cycleStatus: "authorized"
});

const mutations = [
  {
    name: "effective projection erases historical item identity",
    from: "const historicalItemId = line.historicalItemId ?? line.itemId ?? null;",
    to: "const historicalItemId = correction?.afterItemId ?? line.itemId ?? null;",
    killed(candidate) {
      assert.equal(candidate.applyEffectiveReattemptIdentity(line, correction).historicalItemId, 3631);
    }
  },
  {
    name: "effective projection keeps the obsolete operational item",
    from: "const effectiveItemId = correction.afterItemId ?? line.currentItemId ?? line.itemId ?? null;",
    to: "const effectiveItemId = line.itemId ?? null;",
    killed(candidate) {
      assert.equal(candidate.applyEffectiveReattemptIdentity(line, correction).itemId, 3632);
    }
  },
  {
    name: "sales quantity drift is accepted",
    from: "Math.abs(lineSalesQty - correctionSalesQty) > QUANTITY_TOLERANCE",
    to: "false",
    killed(candidate) {
      assert.throws(() => candidate.applyEffectiveReattemptIdentity({ ...line, salesQty: 1400 }, correction));
    }
  },
  {
    name: "physical confirmation accepts an arbitrary truthy value",
    from: "if (input.physicallyDeliveredCurrentItem !== true) {",
    to: "if (!input.physicallyDeliveredCurrentItem) {",
    killed(candidate) {
      assert.throws(() => candidate.normalizeReattemptCorrectionCommand({
        orderRef: "SOM05681-R1",
        idempotencyKey: "4a7e8919-cdd8-48ae-bdf3-a9175f3da600",
        expectedStateFingerprint: "a".repeat(64),
        reason: "Verified current item",
        physicallyDeliveredCurrentItem: "true"
      }));
    }
  },
  {
    name: "fingerprint stops binding the current parent quantity",
    from: "    currentSalesQty: comparableQuantity(input.currentSalesQty),\n",
    to: "",
    killed(candidate) {
      assert.notEqual(
        candidate.buildReattemptIdentityFingerprint(fingerprintState),
        candidate.buildReattemptIdentityFingerprint({ ...fingerprintState, currentSalesQty: 1400 })
      );
    }
  },
  {
    name: "Driver accepts a reconciliation completion without Operator evidence",
    from: "    && String(input.completionSource || \"\") === \"operator_load\"\n",
    to: "",
    killed(candidate) {
      assert.equal(candidate.evaluateReattemptDriverReadiness({
        workflowKind: "sales_order_reattempt",
        cycleStatus: "completed",
        completionSource: "driver_completion_reconciliation",
        hasOperatorLoad: true
      }).allowed, false);
    }
  }
];

let killed = 0;
const survived = [];
for (const mutation of mutations) {
  const candidate = await importMutant(replaceExact(original, mutation.from, mutation.to), mutation.name);
  try {
    mutation.killed(candidate);
  } catch {
    killed += 1;
    continue;
  }
  survived.push(mutation.name);
}

assert.equal(killed, mutations.length, `Every correction mutant must be killed. Survived: ${survived.join(", ")}`);
console.log(`Sales Order re-attempt correction mutation harness passed; ${killed}/${mutations.length} mutants killed.`);
