import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { before, after } from "node:test";
import fc from "fast-check";
import { app } from "../../../src/server.js";
import { createOperator, loginOperator } from "../../../src/auth-repository.js";
import { query, closeDb } from "../../../src/db.js";
import { assertOperatorOrderYard, assertOperatorUploadYard, createOperatorYardGuard } from "../../../src/operator-yard-authorization.js";

const poId = -49090675180799;
const toId = -99080002112;
const coId = -99080002113;
const positiveId = 99080002114;
const coRef = "CO-RECEIVING-IDENTITY";
let server, base, receiver, other, lineId;

async function account(yard) {
  const username = `receiving-identity-${crypto.randomUUID()}`;
  const password = crypto.randomUUID();
  await createOperator({ username, displayName: "Receiving identity test", password,
    role: "operator", operatorYardLocationIds: [yard] });
  return loginOperator(username, password);
}

async function request(session, suffix, method = "GET", body) {
  const response = await fetch(`${base}/api/receiving/${suffix}`, { method,
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}

async function addCo(id, ref, yard) {
  await query(`INSERT INTO local_co_orders(co_ref,source_order_ref,from_location_id,to_location_id,
    status,delivery_order_id) VALUES($1,'IDENTITY-LOCAL-SOURCE',15,$2,'loaded',$3)`, [ref, yard, id]);
}

before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  receiver = await account(1);
  other = await account(28);
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,destination_location_id,status,status_text,netsuite_active)
    VALUES($1,'SN1400409',1,'E','Pending Billing/Partially Received',true),
          ($2,'IDENTITY-POSITIVE',1,'B','Pending Receipt',true)`, [poId, positiveId]);
  await query(`INSERT INTO transfer_orders(netsuite_id,tranid,from_location_id,to_location_id,status,netsuite_active)
    VALUES($1,'IDENTITY-TO',1,28,'B',true)`, [toId]);
  const lines = await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,
    item_type,quantity,unit,location_id,piece_qty,to_pcs,netsuite_active)
    VALUES($1,1,9908001,'IDENTITY-PAVERS','InvtPart',20,'PC',1,20,1,true),
          ($1,2,9908002,'PALLET','InvtPart',2,'EACH',1,2,1,true) RETURNING id`, [poId]);
  lineId = lines.rows[0].id;
  await addCo(coId, coRef, 1);
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) { await new Promise(resolve => server.close(resolve)); }
  await query("DELETE FROM local_co_orders WHERE co_ref=$1 OR co_ref LIKE 'CO-IDENTITY-%'", [coRef]);
  await query("DELETE FROM purchase_order_lines WHERE purchase_order_id=$1", [poId]);
  await query("DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])", [[poId, positiveId]]);
  await query("DELETE FROM transfer_orders WHERE netsuite_id=$1", [toId]);
  await closeDb();
});

test("SN1400409 opens from the receiving list with both of its actual lines", async () => {
  const listed = await request(receiver, "orders?destinationLocationId=1&orderType=purchase_order&search=SN1400409");
  assert.equal(listed.status, 200);
  assert.ok(listed.data.some(row => String(row.netsuite_id) === String(poId)));
  for (const tail of ["", "?orderType=purchase_order"]) {
    const result = await request(receiver, `orders/${poId}${tail}`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.tranid, "SN1400409");
    assert.equal(result.data.order_type, "purchase_order");
    assert.deepEqual(result.data.lines.map(line => Number(line.quantity)), [20, 2]);
  }
});

test("negative transfer IDs and ordinary purchase IDs use their stored destination", async () => {
  for (const [session, id, type, yard] of [[other, toId, "transfer_order", 28], [receiver, positiveId, "purchase_order", 1]]) {
    const result = await request(session, `orders/${id}?orderType=${type}`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.order_type, type);
    assert.equal(Number(result.data.destination_location_id), yard);
  }
  assert.equal((await request(receiver, `orders/${toId}?locationId=1`)).status, 403);
});

test("the assigned operator can confirm and unconfirm a negative PO line", async () => {
  const path = `orders/${poId}/lines/${lineId}`;
  const confirmed = await request(receiver, `${path}/confirm`, "POST", { orderType: "purchase_order", pieces: 3 });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.equal(Number((await query("SELECT received_piece_qty FROM purchase_order_lines WHERE id=$1", [lineId])).rows[0].received_piece_qty), 3);
  const undone = await request(receiver, `${path}/unconfirm`, "POST", { orderType: "purchase_order" });
  assert.equal(undone.status, 200, JSON.stringify(undone.data));
  assert.equal(Number((await query("SELECT received_piece_qty FROM purchase_order_lines WHERE id=$1", [lineId])).rows[0].received_piece_qty), 0);
});

test("a foreign yard cannot read refresh confirm unconfirm or receive a split PO", async () => {
  const beforeRow = (await query("SELECT received_piece_qty,confirmed_at FROM purchase_order_lines WHERE id=$1", [lineId])).rows[0];
  for (const [tail, method] of [["?locationId=28", "GET"], ["/sync", "POST"],
    [`/lines/${lineId}/confirm`, "POST"], [`/lines/${lineId}/unconfirm`, "POST"],
    ["/lines/confirm-page", "POST"], ["/receive", "POST"]]) {
    const result = await request(other, `orders/${poId}${tail}`, method,
      method === "POST" ? { locationId: 28, orderType: "purchase_order", pieces: 7 } : undefined);
    assert.equal(result.status, 403, `${tail}: ${JSON.stringify(result.data)}`);
  }
  assert.deepEqual((await query("SELECT received_piece_qty,confirmed_at FROM purchase_order_lines WHERE id=$1", [lineId])).rows[0], beforeRow);
});

test("receiving photos and local receipt jobs resolve the negative PO and check its yard", async () => {
  const body = { recordType: "operator-receiving-photo", orderId: String(poId), orderType: "purchase_order" };
  assert.equal(await assertOperatorUploadYard(receiver.operator, { ...body }), 1);
  await assert.rejects(assertOperatorUploadYard(other.operator, { ...body }), { status: 403 });
  const jobs = new Map([["identity-job", { orderId: String(poId), operatorId: receiver.operator.id }]]);
  const guard = createOperatorYardGuard({ receivingJobs: jobs });
  const runGuard = operator => new Promise(resolve => guard({ operator, originalUrl: "/api/receiving/receipt-jobs/identity-job", query: {}, body: {} }, {}, resolve));
  assert.equal(await runGuard(receiver.operator), undefined);
  assert.equal((await runGuard({ ...receiver.operator, operatorYardLocationIds: [28] })).status, 403);
});

test("explicit local COs and negative IDs without a canonical order retain local receiving", async () => {
  for (const [id, type] of [[coRef, "co_order"], [String(coId), "co_order"], [String(coId), ""]]) {
    const result = await request(receiver, `orders/${id}${type ? `?orderType=${type}` : ""}`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.order_type, "co_order");
    assert.equal(result.data.tranid, coRef);
  }
  assert.equal((await assertOperatorOrderYard(receiver.operator, coRef, { receiving: true })).tranid, coRef);
});

test("colliding IDs use the canonical order unless the caller explicitly requests a CO", async () => {
  const ref = "CO-IDENTITY-COLLISION";
  await addCo(poId, ref, 28);
  try {
    const ordinary = await request(receiver, `orders/${poId}?orderType=purchase_order`);
    assert.equal(ordinary.status, 200);
    assert.equal(ordinary.data.tranid, "SN1400409");
    assert.equal((await request(receiver, `orders/${poId}?orderType=co_order`)).status, 403);
    const local = await request(other, `orders/${poId}?orderType=co_order`);
    assert.equal(local.status, 200);
    assert.equal(local.data.tranid, ref);
  } finally { await query("DELETE FROM local_co_orders WHERE co_ref=$1", [ref]); }
});

test("unknown IDs remain not found and closed orders retain the existing guard behavior", async () => {
  assert.equal((await request(receiver, "orders/-99080009999?orderType=purchase_order")).status, 404);
  await query("UPDATE purchase_orders SET status='H',status_text='Closed' WHERE netsuite_id=$1", [positiveId]);
  try {
    const order = await assertOperatorOrderYard(receiver.operator, positiveId, { receiving: true });
    assert.equal(order.status_text, "Closed");
  } finally { await query("UPDATE purchase_orders SET status='B',status_text='Pending Receipt' WHERE netsuite_id=$1", [positiveId]); }
});

async function propertyFixture(offset, negative, transfer, mode, destination) {
  const yards = [1, 28, 15, 26];
  const id = (mode === "fallback" || negative ? -1 : 1) * (80000000000000 + offset);
  const ref = `CO-IDENTITY-PROP-${Math.abs(id)}`;
  const localYard = yards[(yards.indexOf(destination) + 1) % yards.length];
  const table = transfer ? "transfer_orders" : "purchase_orders";
  const type = transfer ? "transfer_order" : "purchase_order";
  const canonical = !["fallback", "co-ref"].includes(mode);
  if (canonical) {
    const column = transfer ? "to_location_id" : "destination_location_id";
    await query(`INSERT INTO ${table}(netsuite_id,tranid,${column},status,netsuite_active) VALUES($1,'IDENTITY-PROP',$2,'B',true)`, [id, destination]);
  }
  await addCo(id, ref, localYard);
  return { id, ref, localYard, table, type, canonical };
}

test("property: stored identity and yard grants decide access for signed receiving IDs", async () => {
  const yards = [1, 28, 15, 26];
  const modes = ["canonical", "typed", "co-type", "co-ref", "fallback"];
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 1000000 }), fc.boolean(),
    fc.boolean(), fc.constantFrom(...modes), fc.constantFrom(...yards), fc.subarray(yards),
    async (offset, negative, transfer, mode, destination, grants) => {
      const { id, ref, localYard, table, type, canonical } = await propertyFixture(offset, negative, transfer, mode, destination);
      try {
        const local = ["co-type", "co-ref", "fallback"].includes(mode);
        const operator = { operatorYardLocationIds: grants };
        const result = assertOperatorOrderYard(operator, mode === "co-ref" ? ref : String(id),
          { receiving: true, orderType: mode === "co-type" ? "co_order" : mode === "typed" ? type : "" });
        const expectedYard = local ? localYard : destination;
        if (grants.includes(expectedYard)) {
          const order = await result;
          assert.equal(order.order_type, local ? "co_order" : type);
          assert.equal(Number(order.destination_location_id), expectedYard);
          assert.equal(order.tranid, local ? ref : "IDENTITY-PROP");
        } else { await assert.rejects(result, { status: 403 }); }
      } finally {
        await query("DELETE FROM local_co_orders WHERE co_ref=$1", [ref]);
        if (canonical) { await query(`DELETE FROM ${table} WHERE netsuite_id=$1`, [id]); }
      }
    }), { seed: 20260915, numRuns: 80 });
});
