import assert from "node:assert/strict";
import test, { after } from "node:test";
import { query, closeDb } from "../../../src/db.js";
import { submitReturnBatch } from "../../../src/return-repository.js";
import { attachReturnSalesOrderRestLineMapping } from "../../../src/return-netsuite.js";
import { fixture, submitInput, actor } from "../../support/return-batch-ra-fixture.js";

after(closeDb);

async function storedSource(t, remote, { orderLine = 17, itemId = 99091701 } = {}) {
  await query("DELETE FROM sales_order_lines WHERE sales_order_id=99091700");
  await query("DELETE FROM sales_orders WHERE netsuite_id=99091700");
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,status,status_text,netsuite_active)
    VALUES(99091700,'SOB99091700','B','Pending Fulfillment',true)`);
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,quantity,unit,
    location_id,netsuite_active,netsuite_order_line,netsuite_order_line_synced_at)
    VALUES(99091700,99091703,$1,'RA ITEM',999,'STALE',1,true,$2,now())`, [itemId, orderLine]);
  t.after(async () => {
    await query("DELETE FROM sales_order_lines WHERE sales_order_id=99091700");
    await query("DELETE FROM sales_orders WHERE netsuite_id=99091700");
  });
  const transport = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url).includes("/record/v1/salesOrder/") && options.method === "GET") {
      remote.requests.push({ address: String(url), method: options.method, body: {} });
      return Response.json({ "o:errorDetails": [{ "o:errorCode": "USER_ERROR",
        detail: "Error while accessing a resource. This record has been locked by a user defined workflow." }] }, { status: 400 });
    }
    return transport(url, options);
  });
}

function creates(remote) {
  return remote.requests.filter(request => request.method === "POST"
    && /\/record\/.*returnAuthorization/i.test(request.address));
}

test("S1 stored REST IDs permit a workflow-locked stock return without loading the Sales Order", async t => {
  const remote = await fixture(t);
  await storedSource(t, remote);
  const input = await submitInput({ quantity: 2 });
  const result = await submitReturnBatch({ operatorId: actor, input });
  assert.equal(result.stockReturn.netSuiteSyncStatus, "succeeded");
  const posted = creates(remote);
  assert.equal(posted.length, 1);
  assert.match(posted[0].address, /salesOrder\/99091700\/!transform\/returnAuthorization/i);
  assert.deepEqual(posted[0].body.item.items.map(line => ({ orderLine: line.orderLine, quantity: line.quantity,
    units: line.units, rate: line.rate })), [{ orderLine: 17, quantity: 2, units: "3", rate: 12.5 }]);
  assert.equal(remote.requests.filter(request => request.method === "GET" && request.address.includes("/salesOrder/")).length, 0);
});

test("S2 a stored mapping for a different item fails before return admission or RA creation", async t => {
  const remote = await fixture(t);
  await storedSource(t, remote, { itemId: 99091799 });
  await assert.rejects(submitReturnBatch({ operatorId: actor, input: await submitInput() }),
    error => error.status === 409 && error.code === "NETSUITE_ORDER_LINE_AMBIGUOUS");
  assert.equal(creates(remote).length, 0);
  assert.equal((await query("SELECT 1 FROM return_records WHERE operator_id=$1", [actor])).rowCount, 0);
});

test("S3 duplicate stored REST IDs fail without merging repeated item rows", async t => {
  const remote = await fixture(t);
  await storedSource(t, remote);
  remote.remoteLines.push({ ...remote.remoteLines[0], line_id: "99091705", suiteql_line_number: "3" });
  await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,quantity,netsuite_active,netsuite_order_line)
    VALUES(99091700,99091705,99091701,10,true,17)`);
  await assert.rejects(submitReturnBatch({ operatorId: actor, input: await submitInput() }),
    error => error.status === 409 && error.code === "NETSUITE_ORDER_LINE_AMBIGUOUS");
  assert.equal(creates(remote).length, 0);
});

test("S4 absent saved mappings preserve the existing REST mapping for historical returns", async t => {
  const remote = await fixture(t);
  const result = await submitReturnBatch({ operatorId: actor, input: await submitInput() });
  assert.equal(result.stockReturn.netSuiteSyncStatus, "succeeded");
  assert.equal(creates(remote).length, 1);
  assert.equal(creates(remote)[0].body.item.items[0].orderLine, 2);
  assert.equal(remote.requests.filter(request => request.method === "GET" && request.address.includes("/salesOrder/")).length, 1);
});

test("S5 concurrent retries using a saved mapping create one RA", async t => {
  const remote = await fixture(t);
  await storedSource(t, remote);
  const input = await submitInput();
  const results = await Promise.all(Array.from({ length: 8 }, () => submitReturnBatch({ operatorId: actor, input })));
  assert.equal(creates(remote).length, 1);
  assert.ok(results.every(result => result.batchReference === results[0].batchReference));
  assert.ok(results.every(result => ["pending", "succeeded"].includes(result.stockReturn.netSuiteSyncStatus)));
  const final = await submitReturnBatch({ operatorId: actor, input });
  assert.equal(final.idempotentReplay, true);
  assert.equal(final.stockReturn.netSuiteSyncStatus, "succeeded");
  assert.equal(final.stockReturn.netSuiteTransactionId, Number([...remote.created.values()][0].id));
  assert.equal(creates(remote).length, 1);
});

test("S6 the historical REST fallback still rejects an invalid native orderLine before admission", async t => {
  const remote = await fixture(t);
  const transport = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url).includes("/record/v1/salesOrder/") && options.method === "GET") {
      return Response.json({ item: { items: [{ orderLine: 0, item: { id: "99091701" },
        quantity: 10, location: { id: "1" } }] } });
    }
    return transport(url, options);
  });
  await assert.rejects(submitReturnBatch({ operatorId: actor, input: await submitInput() }),
    error => error.status === 409 && error.code === "NETSUITE_ORDER_LINE_MISSING");
  assert.equal(creates(remote).length, 0);
  assert.equal((await query("SELECT 1 FROM return_records WHERE operator_id=$1", [actor])).rowCount, 0);
});

test("S7 malformed mapping requests retain their existing 400 response before network reads", async () => {
  for (const invalid of [null, {}, { id: 42 }, { id: 0, lines: [] }]) {
    await assert.rejects(attachReturnSalesOrderRestLineMapping(invalid), error => error.status === 400);
  }
});
