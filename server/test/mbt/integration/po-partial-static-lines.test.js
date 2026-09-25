import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { config } from "../../../src/config.js";
import { query, withTransaction, closeDb } from "../../../src/db.js";
import { getReceivableReceivingOrder } from "../../../src/receiving-repository.js";
import { createOperatorNetSuitePostingRealSourceResolver, createOperatorNetSuitePostingTargetResolver } from "../../../src/operator-netsuite-posting-targets.js";
import { buildOperatorNetSuitePostingDraft } from "../../../src/operator-netsuite-posting-domain.js";
import { fixture, parent, child, incident } from "../../support/receiving-split-balance-fixture.mjs";

after(closeDb);
const keys = [1, 3, 5, 6, 7, 28, 29, 30, 31, 32, 33, 34, 35, 36, 41, 42];
const mappingError = { code: "OPERATOR_NETSUITE_POSTING_LINE_MAPPING_UNRESOLVED" };
const scenario = run => withTransaction(async () => {
  await fixture();
  for (const [index, [key]] of incident.entries()) {
    await query("UPDATE purchase_order_lines SET netsuite_order_line=$2 WHERE purchase_order_id=$1 AND line_id=$3", [parent, keys[index], key]);
  }
  await query("UPDATE purchase_order_lines SET received_pallet_qty=1,confirmed_at=now() WHERE purchase_order_id=$1 AND line_id IN (4759374,4878977)", [parent]);
  return run(incident.map(([key, , quantity, quantityReceived], index) => ({ line: keys[index], item: { id: String(key) }, itemType: { id: "InvtPart" }, quantity, quantityReceived, isClosed: false })));
}, { rollback: true });

async function draft(live, id = parent) {
  const reads = [];
  const source = createOperatorNetSuitePostingRealSourceResolver({ query, useStoredOrderLines: true,
    fetchLiveSource: async () => { throw new Error("Do not switch the whole direct resolver to the legacy live strategy"); },
    fetchPoReceiptLines: async sourceId => { reads.push(sourceId); return typeof live === "function" ? live() : live; } });
  const resolve = createOperatorNetSuitePostingTargetResolver({ getDeliveryOrder: async () => null,
    getReceivableReceivingOrder, resolveRealSource: source });
  const resolved = await resolve({ functionKey: "receiving", orderId: id, orderType: "purchase_order", clientLocationId: 1 });
  const result = buildOperatorNetSuitePostingDraft({ ...resolved, requestId: "de870108-fe99-4ee0-a19d-bb86b1631863", actorOperatorId: "test-replay", photoRefs: [],
    policy: { gateKey: "operator_netsuite_receiving_ir_3445", revision: 1, effective: true, functionKey: "receiving", transactionType: "IR", locationId: 1, yardCode: "3445" } });
  return { result, reads, resolution: resolved, rows: result.steps[0].payload.item.items };
}

test("POB03684 partial IR contains exactly its two selected rows and the one open deselection", () => scenario(async live => {
  const before = (await query("SELECT * FROM purchase_order_lines WHERE purchase_order_id=$1 ORDER BY id", [parent])).rows;
  const { result, rows, reads } = await draft(live);
  assert.deepEqual(rows, [
    { orderLine: 6, location: 1, itemReceive: true, quantity: 108 },
    { orderLine: 29, location: 1, itemReceive: true, quantity: 304 },
    { orderLine: 33, location: 1, itemReceive: false }
  ]);
  assert.deepEqual(reads, [parent]);
  assert.equal(result.steps[0].payload.memo, "POB03684");
  assert.equal(result.steps[0].payload.custbody9, "POB03684");
  assert.equal(result.steps[0].externalId, "MBBS-OP-de870108-fe99-4ee0-a19d-bb86b1631863-1");
  assert.equal(result.inputSnapshot.postingStrategy, "stored_order_line_v1");
  assert.deepEqual((await query("SELECT * FROM purchase_order_lines WHERE purchase_order_id=$1 ORDER BY id", [parent])).rows, before);
}));

test("missing unselected and closed rows are omitted while open unselected quantities remain explicit", () => scenario(async live => {
  live = live.filter(row => row.line !== 1);
  live.find(row => row.line === 3).quantityReceived = 0;
  live.find(row => row.line === 5).quantityReceived = 0;
  live.find(row => row.line === 5).isClosed = true;
  const { rows } = await draft(live);
  assert.deepEqual(rows.map(row => [row.orderLine, row.itemReceive]), [[3, false], [6, true], [29, true], [33, false]]);
}));

test("unknown open rows, missing selected lines and ambiguous or changed identities fail closed", () => scenario(async live => {
  for (const rows of [
    [...live, { line: 99, item: { id: "123" }, itemType: { id: "InvtPart" }, quantity: 5, quantityReceived: 0 }],
    live.filter(row => row.line !== 6), [...live, { ...live[0] }],
    live.map(row => row.line === 6 ? { ...row, item: { id: "999" } } : row),
    live.map(row => row.line === 1 ? { ...row, quantityReceived: undefined } : row),
    []
  ]) await assert.rejects(draft(rows), mappingError);
}));

test("a failed PO availability read cannot fall back to the stale cached payload", () => scenario(async () => {
  await assert.rejects(draft(() => { throw new Error("Current PO availability read failed"); }), /Current PO availability read failed/);
}));

test("malformed counters and identities stop drafting; non-receipt and completed unknown rows are harmless", () => scenario(async live => {
  for (const quantityReceived of [null, "", " ", false, {}, -1, "invalid", Infinity]) {
    await assert.rejects(draft(live.map(row => row.line === 1 ? { ...row, quantityReceived } : row)), mappingError);
  }
  for (const line of [0, -1, 1.5, "invalid"]) {
    await assert.rejects(draft(live.map((row, index) => index === 0 ? { ...row, line } : row)), mappingError);
  }
  await assert.rejects(draft(null), mappingError);
  const { rows } = await draft([...live,
    { itemType: { id: "Description" }, description: "PO notes" },
    { line: 99, item: { id: "123" }, itemType: "NonInvtPart", quantity: "5", quantityReceived: "5" }
  ]);
  assert.deepEqual(rows.map(row => row.orderLine), [6, 29, 33]);
}));

test("the production target resolver reads the current PO once and creates no NetSuite transaction", () => scenario(async live => {
  const previous = { ...config.netsuite }, fetch = globalThis.fetch;
  const calls = [];
  try {
    Object.assign(config.netsuite, { directAccessEnabled: true, operatorStoredOrderLinePosting: true,
      restBaseUrl: "https://netsuite.invalid/services/rest" });
    await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'isolated-test',now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
    globalThis.fetch = async (url, options) => {
      const address = new URL(url);
      assert.equal(address.hostname, "netsuite.invalid");
      assert.equal(options.method, "GET");
      assert.equal(address.pathname, `/services/rest/record/v1/purchaseOrder/${parent}`);
      assert.equal(address.searchParams.get("expandSubResources"), "true");
      calls.push(address.pathname);
      return new Response(JSON.stringify({ item: { items: live } }), { status: 200 });
    };
    const { resolveOperatorNetSuitePostingTargets: resolve } = await import("../../../src/operator-netsuite-posting-targets.js?po-partial-production-test");
    const resolution = await resolve({ functionKey: "receiving", orderId: parent, orderType: "purchase_order", clientLocationId: 1 });
    const expected = await draft(live);
    assert.deepEqual(resolution.targets[0].availableLines, expected.resolution.targets[0].availableLines);
    assert.equal(calls.length, 1);
  } finally {
    Object.assign(config.netsuite, previous);
    globalThis.fetch = fetch;
  }
}));

test("split receipts refresh their real positive parent and keep their selected quantity unchanged", () => scenario(async live => {
  await query("UPDATE purchase_order_lines SET received_pallet_qty=1,confirmed_at=now() WHERE purchase_order_id=$1 AND line_id=4759369", [child]);
  const { rows, reads, result } = await draft(live, child);
  assert.deepEqual(reads, [parent]);
  assert.equal(result.steps[0].sourceNetSuiteId, parent);
  assert.equal(result.steps[0].payload.memo, "#11619-1");
  assert.deepEqual(rows.filter(row => row.itemReceive), [{ orderLine: 1, location: 1, itemReceive: true, quantity: 152 }]);
  assert.deepEqual(rows.filter(row => !row.itemReceive).map(row => row.orderLine), [6, 29, 33]);
}));

test("property: shuffled live counters affect only exact deselections and never the selected quantities", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ completed: fc.boolean(), closed: fc.boolean() }), { minLength: 16, maxLength: 16 }), fc.boolean(),
    async (states, reverse) => scenario(async live => {
      const expected = [];
      for (const [index, row] of live.entries()) {
        row.quantityReceived = states[index].completed ? row.quantity : 0;
        row.isClosed = states[index].closed;
        if (![6, 29].includes(row.line) && !states[index].completed && !states[index].closed) expected.push(row.line);
      }
      if (reverse) live.reverse();
      const { rows } = await draft(live);
      assert.deepEqual(rows.filter(row => row.itemReceive).map(row => [row.orderLine, row.quantity]), [[6, 108], [29, 304]]);
      assert.deepEqual(rows.filter(row => !row.itemReceive).map(row => row.orderLine), expected.sort((a, b) => a - b));
    })), { seed: 36840922, numRuns: 40 });
});
