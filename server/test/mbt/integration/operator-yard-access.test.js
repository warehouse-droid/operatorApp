import assert from "node:assert/strict";
import crypto from "node:crypto";
import { TextDecoder } from "node:util";
import test, { before, after } from "node:test";
import fc from "fast-check";
import { app } from "../../../src/server.js";
import { createOperator, loginOperator, getOperatorByToken, updateOperatorRoles, listOperators, writeAudit } from "../../../src/auth-repository.js";
import { closeDb, query, pool } from "../../../src/db.js";
import { seedOperatorPickup } from "../../support/operator-ui-enhancements-fixture.mjs";
import { config } from "../../../src/config.js";

let server, base, assigned, empty, admin, fixture;
const password = crypto.randomUUID();
async function account(role, grants) {
  const username = `yard-access-${crypto.randomUUID()}`;
  await createOperator({ username, displayName: "Yard access test", password, role,
    yardLocationIds: [28], ...(grants === undefined ? {} : { operatorYardLocationIds: grants }) });
  return loginOperator(username, password);
}
async function request(session, path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text() };
}
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  assigned = await account("operator", [1]);
  empty = await account("yard_manager");
  admin = await account("admin");
  fixture = await seedOperatorPickup();
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) {await new Promise((resolve) => server.close(resolve));}
  await closeDb();
});

test("account grants survive create, login, listing and live session lookup independently", async () => {
  assert.deepEqual(empty.operator.operatorYardLocationIds, []);
  assert.deepEqual(assigned.operator.operatorYardLocationIds, [1]);
  assert.deepEqual(assigned.operator.yardLocationIds, [28]);
  assert.deepEqual((await getOperatorByToken(assigned.token)).operatorYardLocationIds, [1]);
  assert.deepEqual((await listOperators()).find((row) => row.id === assigned.operator.id).operatorYardLocationIds, [1]);
});

test("empty Operator assignments deny operations while Control and admin access remain", async () => {
  for (const path of ["/api/delivery/orders?locationId=28", "/api/receiving/orders?destinationLocationId=28", "/api/inventory/items?locationId=28", "/api/operator/history", "/api/returns/operator/drafts?receivingLocationId=28"]) {
    assert.equal((await request(empty, path)).status, 403, path);
  }
  assert.equal((await request(empty, "/api/control/order-locks")).status, 200);
  assert.equal((await request(admin, "/api/delivery/orders?locationId=28")).status, 200);
});

test("yard list filters reject foreign and malformed yards before data or sync operations", async () => {
  assert.equal((await request(assigned, "/api/delivery/orders?locationId=1")).status, 200);
  for (const path of ["/api/delivery/bootstrap?locationId=28", "/api/delivery/saved-orders?locationId=28", "/api/delivery/notifications?locationId=28", "/api/delivery/load-orders?locationId=28", "/api/receiving/vendors?destinationLocationId=28", "/api/receiving/items?destinationLocationId=28", "/api/inventory/items?locationId=28", "/api/operator/requests?locationId=28", "/api/delivery/orders?locationId=1&locationId=28"]) {
    assert.equal((await request(assigned, path)).status, 403, path);
  }
  assert.equal((await request(assigned, "/api/inventory/sync", "POST", { locationIds: [28] })).status, 403);
  assert.equal((await request(assigned, "/api/cycle-count/lines", "POST", { locationId: 28, itemId: 123 })).status, 403);
});

test("stored order yard wins over forged query and body yard on reads and mutations", async () => {
  const id = fixture.orderId;
  assert.equal((await request(assigned, `/api/delivery/orders/${id}`)).status, 200);
  await query("UPDATE sales_orders SET outbound_location_id=28 WHERE netsuite_id=$1", [id]);
  try {
    for (const [path, method, body] of [
      [`/api/delivery/orders/${id}?locationId=1`, "GET"],
      [`/api/customer-pickup/orders/${id}/lines/${fixture.lineId}/confirm`, "POST", { locationId: 1, pieces: 2 }],
      [`/api/delivery/orders/${id}/prepared`, "POST", { locationId: 1 }],
      ["/api/delivery/saved-orders", "POST", { locationId: 1, orderId: id }]
    ]) {assert.equal((await request(assigned, path, method, body)).status, 403, path);}
    const row = (await query("SELECT packed_piece_qty FROM sales_order_lines WHERE id=$1", [fixture.lineId])).rows[0];
    assert.equal(Number(row.packed_piece_qty), 0);
  } finally { await query("UPDATE sales_orders SET outbound_location_id=1 WHERE netsuite_id=$1", [id]); }
});

test("admin grant changes are audited, omitted updates preserve them, and revocation affects existing sessions", async () => {
  const session = await account("operator", [1]);
  const path = `/api/operators/${session.operator.id}/roles`;
  const updated = await request(admin, path, "PUT", { role: "operator", roles: ["operator"], operatorYardLocationIds: [15, 26] });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.operatorYardLocationIds, [15, 26]);
  await updateOperatorRoles(session.operator.id, { role: "operator", roles: ["operator"], yardLocationIds: [1] });
  assert.deepEqual((await getOperatorByToken(session.token)).operatorYardLocationIds, [15, 26]);
  assert.equal((await request(session, "/api/delivery/orders?locationId=1")).status, 403);
  const audit = await query("SELECT details FROM delivery_audit_log WHERE action='operator.roles_update' AND details->>'operatorId'=$1", [session.operator.id]);
  assert.ok(audit.rows.some((row) => JSON.stringify(row.details).includes('operatorYardLocationIds')));
  await request(admin, path, "PUT", { role: "operator", roles: ["operator"], operatorYardLocationIds: [] });
  assert.equal((await request(session, "/api/delivery/orders?locationId=15")).status, 403);
});

test("receiving uses stored destination for PO, transfer and local CO regardless of claimed yard", async () => {
  const po = 9_910_000_001, transfer = 9_910_000_002;
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,destination_location_id,status,netsuite_active) VALUES($1,'YARD-PO',28,'B',true)", [po]);
  await query("INSERT INTO transfer_orders(netsuite_id,tranid,from_location_id,to_location_id,status,netsuite_active) VALUES($1,'YARD-TO',1,28,'B',true)", [transfer]);
  await query("INSERT INTO local_co_orders(co_ref,source_order_ref,from_location_id,to_location_id,status) VALUES('CO-YARD-ACCESS','YARD-SOURCE',1,28,'loaded')");
  for (const id of [po, transfer, "CO-YARD-ACCESS"]) {
    for (const [tail, method, body] of [["?locationId=1", "GET"], ["/sync", "POST", { locationId: 1 }], ["/lines/1/confirm", "POST", { locationId: 1 }], ["/receive", "POST", { locationId: 1 }]]) {
      assert.equal((await request(assigned, `/api/receiving/orders/${id}${tail}`, method, body)).status, 403, `${id}${tail}`);
    }
  }
  const inbound = await account("operator", [28]);
  assert.equal((await request(inbound, `/api/receiving/orders/${po}`)).status, 200);
  assert.equal((await request(inbound, `/api/delivery/orders/${transfer}`)).status, 403);
});

test("foreign return draft yard cannot be deleted, replaced, submitted or hidden by a forged yard; Control still uses its own grant", async () => {
  const id = crypto.randomUUID();
  await query("INSERT INTO return_drafts(id,operator_id,receiving_location_id,draft_type,payload) VALUES($1,$2,28,'pallet','{}')", [id, assigned.operator.id]);
  assert.equal((await request(assigned, `/api/returns/drafts/${id}`, "DELETE")).status, 403);
  assert.equal((await request(assigned, "/api/returns/drafts", "POST", { id, receivingLocationId: 1 })).status, 403);
  assert.equal((await request(assigned, "/api/returns/submit", "POST", { draftId: id, receivingLocationId: 1 })).status, 403);
  assert.equal((await request(empty, `/api/returns/drafts/${id}`)).status, 200);
  assert.equal((await query("SELECT 1 FROM return_drafts WHERE id=$1", [id])).rowCount, 1);
});

test("return replay checks stored batch yard even when the original draft has gone", async () => {
  const key = crypto.randomUUID();
  await query(`INSERT INTO return_batches(batch_reference,idempotency_key,operator_id,receiving_location_id,receiving_yard_code,vehicle_plate)
    VALUES($1,$2,$3,28,'2967','TEST')`, [`YARD-${key}`, `client:${assigned.operator.id}:${key}`, assigned.operator.id]);
  assert.equal((await request(assigned, "/api/returns/submit", "POST", { idempotencyKey: key, receivingLocationId: 1 })).status, 403);
});

test("consolidation checks stored batch yard before line, item or pack changes", async () => {
  const batch = (await query("INSERT INTO operator_consolidation_batches(operator_id,location_id) VALUES($1,28) RETURNING id", [assigned.operator.id])).rows[0];
  const order = (await query(`INSERT INTO operator_consolidation_orders(batch_id,order_key,order_ref,order_type)
    VALUES($1,$2,$3,'sales_order') RETURNING id`, [batch.id, fixture.orderId, fixture.tranid])).rows[0];
  for (const [path, method] of [[`orders/${order.id}/lines/1`, "PUT"], [`orders/${order.id}/pack`, "POST"], [`batches/${batch.id}/items/confirm`, "PUT"]]) {
    assert.equal((await request(assigned, `/api/delivery/consolidation/${path}`, method, { locationId: 1, pieces: 1 })).status, 403);
  }
  assert.equal((await query("SELECT status FROM operator_consolidation_batches WHERE id=$1", [batch.id])).rows[0].status, "active");
});

test("Operator history retains authorized records and hides records after an order moves to another yard", async () => {
  await writeAudit({ actorOperatorId: assigned.operator.id, source: "delivery", action: "delivery.line.confirm", orderId: fixture.orderId, lineId: fixture.lineId, details: { pieces: 1 } });
  let result = await request(assigned, "/api/operator/history");
  assert.equal(result.status, 200);
  const record = result.data.find((row) => row.orderId === fixture.orderId || String(row.orderId) === fixture.orderId);
  assert.ok(record);
  await query("UPDATE sales_orders SET outbound_location_id=28 WHERE netsuite_id=$1", [fixture.orderId]);
  try {
    result = await request(assigned, "/api/operator/history");
    assert.equal(result.status, 200);
    assert.equal(result.data.some((row) => row.id === record.id), false);
    const report = await request(assigned, "/api/operator/history/report-error", "POST", { recordId: record.id, reason: "test" });
    assert.notEqual(report.status, 200);
    assert.equal((await query("SELECT 1 FROM operator_record_warnings WHERE record_id=$1", [record.id])).rowCount, 0);
  } finally { await query("UPDATE sales_orders SET outbound_location_id=1 WHERE netsuite_id=$1", [fixture.orderId]); }
});

test("cycle draft hides revoked lines and cannot submit them; stored work is preserved", async () => {
  const item = 9_910_000_010;
  await query("INSERT INTO inventory_items(item_id,item_name) VALUES($1,'YARD-CYCLE')", [item]);
  const draft = (await query("INSERT INTO cycle_count_records(operator_id,status) VALUES($1,'draft') RETURNING id", [assigned.operator.id])).rows[0];
  await query("INSERT INTO cycle_count_lines(record_id,item_id,location_id) VALUES($1,$2,28)", [draft.id, item]);
  const result = await request(assigned, "/api/cycle-count/draft");
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.lines, []);
  assert.equal((await request(assigned, "/api/cycle-count/submit", "POST", { locationId: 1 })).status, 403);
  assert.equal((await query("SELECT status FROM cycle_count_records WHERE id=$1", [draft.id])).rows[0].status, "draft");
  assert.equal((await query("SELECT 1 FROM cycle_count_lines WHERE record_id=$1", [draft.id])).rowCount, 1);
});

test("invalid account yard payloads are rejected before writes and cannot grant location 195", async () => {
  for (const operatorYardLocationIds of [[195], [true], ["1x"], "1", null, {}]) {
    const result = await request(admin, `/api/operators/${assigned.operator.id}/roles`, "PUT", { role: "operator", roles: ["operator"], operatorYardLocationIds });
    assert.equal(result.status, 400);
    assert.deepEqual((await getOperatorByToken(assigned.token)).operatorYardLocationIds, [1]);
  }
});

test("saved order lists and consolidation queues hide orders moved out of their saved yard without deleting saved work", async () => {
  await query(`INSERT INTO operator_saved_delivery_orders(operator_id,location_id,order_key,order_ref,order_type)
    VALUES($1,1,$2,$3,'sales_order') ON CONFLICT DO NOTHING`, [assigned.operator.id, fixture.orderId, fixture.tranid]);
  await query("UPDATE sales_orders SET outbound_location_id=28 WHERE netsuite_id=$1", [fixture.orderId]);
  try {
    for (const path of ["/api/delivery/saved-orders?locationId=1", "/api/delivery/saved-order-keys?locationId=1", "/api/delivery/consolidation/queue?locationId=1"]) {
      const result = await request(assigned, path);
      assert.equal(result.status, 200);
      assert.equal(JSON.stringify(result.data).includes(fixture.orderId), false, path);
      assert.equal(JSON.stringify(result.data).includes(fixture.tranid), false, path);
    }
    assert.equal((await query("SELECT 1 FROM operator_saved_delivery_orders WHERE operator_id=$1 AND order_key=$2", [assigned.operator.id, fixture.orderId])).rowCount, 1);
  } finally { await query("UPDATE sales_orders SET outbound_location_id=1 WHERE netsuite_id=$1", [fixture.orderId]); }
});

test("photo tickets and saved return previews cannot bypass Operator yards", async () => {
  for (const endpoint of ["/api/operator/photo-upload-token", "/api/photo-upload/token"]) {
    assert.equal((await request(empty, endpoint, "POST", { source: "operator", recordType: "operator-return-photo", locationId: 28 })).status, 403);
  }
  await query("UPDATE sales_orders SET outbound_location_id=28 WHERE netsuite_id=$1", [fixture.orderId]);
  try {
    assert.equal((await request(assigned, "/api/operator/photo-upload-token", "POST", { locationId: 1, recordType: "operator-load-photo", orderId: fixture.orderId })).status, 403);
  } finally { await query("UPDATE sales_orders SET outbound_location_id=1 WHERE netsuite_id=$1", [fixture.orderId]); }
  const photo = `r2://operator/operator-return-photo/2026/09/15/${assigned.operator.id}/TEST/return.jpg`;
  await query("INSERT INTO return_drafts(id,operator_id,receiving_location_id,payload) VALUES($1,$2,28,$3)", [crypto.randomUUID(), assigned.operator.id, JSON.stringify({ palletPhotos: [photo] })]);
  assert.equal((await request(assigned, `/api/photo-upload/preview?ref=${encodeURIComponent(photo)}`)).status, 403);
});

test("live events expose refresh signals to anonymous and Operator clients, and details to authenticated Dispatch authority", async () => {
  const streams = [];
  try {
    for (const token of ["", assigned.token, admin.token]) {
      const abort = new AbortController();
      const response = await fetch(`${base}/api/events?client=dispatch&token=${encodeURIComponent(token)}`, { signal: abort.signal });
      const reader = response.body.getReader();
      streams.push({ abort, reader });
      await reader.read();
    }
    const result = await request(admin, `/api/delivery/orders/${fixture.orderId}/prepared`, "POST", {});
    assert.equal(result.status, 200);
    const events = await Promise.all(streams.map(async ({ reader }) => {
      let buffer = "";
      const timeout = setTimeout(() => streams.forEach((stream) => stream.abort.abort()), 4000);
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {throw new Error("Event stream ended without an update");}
          buffer += new TextDecoder().decode(value);
          const match = buffer.match(/data: (.+)\n/);
          if (match) {return JSON.parse(match[1]);}
        }
      } finally { clearTimeout(timeout); }
    }));
    for (const event of events) {assert.equal(event.type, "delivery.order.updated");}
    assert.deepEqual(events[0].payload, {});
    assert.deepEqual(events[1].payload, {});
    assert.equal(String(events[2].payload.orderId), fixture.orderId);
  } finally { streams.forEach((stream) => stream.abort.abort()); }
});

test("property: stored order yard requires its own grant even with another authorized location in the request", async () => {
  const session = await account("operator", []);
  try {
    await fc.assert(fc.asyncProperty(fc.subarray([1, 28, 15, 26]), fc.constantFrom(1, 28, 15, 26), async (grants, canonical) => {
      await updateOperatorRoles(session.operator.id, { role: "operator", roles: ["operator"], operatorYardLocationIds: grants });
      await query("UPDATE sales_orders SET outbound_location_id=$2 WHERE netsuite_id=$1", [fixture.orderId, canonical]);
      await query("UPDATE sales_order_lines SET location_id=$2 WHERE sales_order_id=$1", [fixture.orderId, canonical]);
      const result = await request(session, `/api/delivery/orders/${fixture.orderId}?locationId=${grants[0] || 1}`);
      assert.equal(result.status, grants.includes(canonical) ? 200 : 403);
    }), { seed: 20260915, numRuns: 40 });
  } finally {
    await query("UPDATE sales_orders SET outbound_location_id=1 WHERE netsuite_id=$1", [fixture.orderId]);
    await query("UPDATE sales_order_lines SET location_id=1 WHERE sales_order_id=$1", [fixture.orderId]);
  }
});

test("posting jobs enforce stored yard and ownership while retaining accepted work", async () => {
  const id = crypto.randomUUID();
  await query(`INSERT INTO operator_netsuite_posting_commands(id,request_id,actor_operator_id,function_key,transaction_type,
    canonical_location_id,yard_code,gate_key,gate_revision,input_hash) VALUES($1,$2,$3,'receiving','IR',1,'3445',
    'operator_netsuite_receiving_ir_3445',1,$4)`, [id, crypto.randomUUID(), assigned.operator.id, "a".repeat(64)]);
  for (const endpoint of [`/api/operator/netsuite-posting-jobs/${id}`, `/api/receiving/receipt-jobs/${id}`]) {
    assert.equal((await request(assigned, endpoint)).status, 200, endpoint);
    assert.equal((await request(fixture, endpoint)).status, 403);
    await query("UPDATE operator_netsuite_posting_commands SET canonical_location_id=28 WHERE id=$1", [id]);
    assert.equal((await request(assigned, endpoint)).status, 403);
    await query("UPDATE operator_netsuite_posting_commands SET canonical_location_id=1 WHERE id=$1", [id]);
  }
  assert.equal((await query("SELECT status FROM operator_netsuite_posting_commands WHERE id=$1", [id])).rows[0].status, "queued");
});

test("account API creation, disabling and password reset preserve independent grants", async () => {
  const username = `yard-created-${crypto.randomUUID()}`;
  const created = await request(admin, "/api/operators", "POST", { username, displayName: "Created", password, role: "operator", yardLocationIds: [28], operatorYardLocationIds: [1] });
  assert.equal(created.status, 200);
  assert.deepEqual(created.data.operatorYardLocationIds, [1]);
  const session = await loginOperator(username, password);
  const disabled = await request(admin, `/api/operators/${created.data.id}/active`, "POST", { active: false });
  assert.deepEqual(disabled.data.operatorYardLocationIds, [1]);
  assert.equal((await request(session, "/api/auth/me")).status, 401);
  await request(admin, `/api/operators/${created.data.id}/active`, "POST", { active: true });
  const reset = await request(admin, `/api/operators/${created.data.id}/password`, "POST", { password: crypto.randomUUID() });
  assert.deepEqual(reset.data.operatorYardLocationIds, [1]);
  assert.equal(await getOperatorByToken(session.token), null);
});

test("customer pickup lookup and return metadata remain usable at an assigned yard", async () => {
  const pickup = await request(assigned, "/api/customer-pickup/lookup", "POST", { code: fixture.tranid, locationId: 1 });
  assert.equal(pickup.status, 200);
  assert.equal(String(pickup.data.netsuite_id), fixture.orderId);
  const reasons = await request(assigned, "/api/returns/reasons");
  assert.equal(reasons.status, 200);
  assert.deepEqual(reasons.data.yardSettings.map((yard) => yard.locationId), [1]);
  assert.equal((await request(assigned, "/api/returns/operator/history")).status, 200);
  assert.equal((await request(assigned, "/api/returns/drafts", "POST", { draftId: "invalid", receivingLocationId: 1 })).status, 400);
});

test("counting authorized inventory returns only authorized draft lines", async () => {
  const item = 9_910_000_010;
  await query("UPDATE inventory_items SET to_pcs=1 WHERE item_id=$1", [item]);
  await query("INSERT INTO inventory_balances(item_id,location_id,quantity_on_hand,quantity_available) VALUES($1,1,10,10)", [item]);
  const result = await request(assigned, "/api/cycle-count/lines", "POST", { locationId: 1, itemId: item, pieces: 7 });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.lines.map((line) => Number(line.location_id)), [1]);
  assert.equal(Number(result.data.lines[0].counted_piece_qty), 7);
});

test("authorized photo tickets bind unsaved returns to a yard and order previews follow the current stored yard", async () => {
  const oldConfig = { ...config.photoUpload }, nativeFetch = globalThis.fetch;
  Object.assign(config.photoUpload, { workerUrl: "https://yard-photos.invalid", tokenSecret: crypto.randomUUID() });
  globalThis.fetch = (url, options) => String(url).startsWith("https://yard-photos.invalid")
    ? Promise.resolve(new Response("yard-photo-bytes", { headers: { "content-type": "image/jpeg" } })) : nativeFetch(url, options);
  try {
    for (const endpoint of ["/api/operator/photo-upload-token", "/api/photo-upload/token"]) {
      const ticket = await request(assigned, endpoint, "POST", { recordType: "operator-return-photo", locationId: 1 });
      assert.equal(ticket.status, 200);
      assert.ok(ticket.data.metadata.keyPrefix.includes("/yard-1/"));
      const ref = `r2://${ticket.data.metadata.keyPrefix}/return.jpg`;
      assert.equal((await request(assigned, `/api/photo-upload/preview?ref=${encodeURIComponent(ref)}`)).status, 200);
    }
    const orderTicket = await request(assigned, "/api/operator/photo-upload-token", "POST", { recordType: "operator-customer-pickup-photo", orderId: fixture.orderId, orderRef: fixture.tranid, locationId: 1 });
    assert.equal(orderTicket.status, 200);
    const ref = `r2://${orderTicket.data.metadata.keyPrefix}/load.jpg`;
    assert.equal((await request(assigned, `/api/photo-upload/preview?ref=${encodeURIComponent(ref)}`)).data, "yard-photo-bytes");
    await query("UPDATE sales_orders SET outbound_location_id=28 WHERE netsuite_id=$1", [fixture.orderId]);
    assert.equal((await request(assigned, `/api/photo-upload/preview?ref=${encodeURIComponent(ref)}`)).status, 403);
  } finally {
    globalThis.fetch = nativeFetch;
    Object.assign(config.photoUpload, oldConfig);
    await query("UPDATE sales_orders SET outbound_location_id=1 WHERE netsuite_id=$1", [fixture.orderId]);
  }
});

test("instruction media uses the stored outbound yard and rejects foreign yards before reading photo storage", async () => {
  const id = crypto.randomUUID();
  await query(`INSERT INTO sales_order_delivery_instruction_media(id,sales_order_id,object_reference,media_kind,mime_type,
    original_file_name,byte_size,position,instruction_revision,uploaded_source) VALUES($1,$2,$3,'image','image/jpeg','test.jpg',5,1,1,'sales')`,
  [id, fixture.orderId, `r2://sales/instructions/${id}.jpg`]);
  await query("UPDATE sales_orders SET outbound_location_id=28 WHERE netsuite_id=$1", [fixture.orderId]);
  try {
    assert.equal((await request(assigned, `/api/delivery-instruction-media/${id}/content`)).status, 403);
  } finally { await query("UPDATE sales_orders SET outbound_location_id=1 WHERE netsuite_id=$1", [fixture.orderId]); }
});

async function withNetSuiteReadStub(responder, run) {
  const oldConfig = { ...config.netsuite }, nativeFetch = globalThis.fetch;
  assert.equal((await query("SELECT 1 FROM netsuite_tokens")).rowCount, 0);
  await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,$1,now()+interval '1 hour')", [crypto.randomUUID()]);
  Object.assign(config.netsuite, { restBaseUrl: "https://yard-netsuite.invalid/services/rest", directAccessEnabled: true });
  globalThis.fetch = (url, options) => String(url).startsWith("https://yard-netsuite.invalid")
    ? Promise.resolve(new Response(JSON.stringify(JSON.parse(options.body).q.includes('FROM location l')
      ? { items: [{ id: 1 }, { id: 28 }, { id: 15 }, { id: 26 }, { id: 14, parent: 1 }] }
      : responder(JSON.parse(options.body))), { headers: { "content-type": "application/json" } })) : nativeFetch(url, options);
  try { await run(); }
  finally {
    globalThis.fetch = nativeFetch;
    Object.assign(config.netsuite, oldConfig);
    await query("DELETE FROM netsuite_tokens WHERE id=1");
  }
}

test("NetSuite pickup lookup confines its query to the assigned yard and checks returned yard before importing", async () => {
  const id = 9_910_000_090;
  let returnedYard = 28;
  await withNetSuiteReadStub(({ q }) => {
    if (q.includes("SELECT DISTINCT")) {
      assert.match(q, /AND tl\.location IN \(1,14\)/);
      return { items: [{ id, tranid: "SOB999900", status: "B", status_text: "Pending Fulfillment", outbound_location_id: returnedYard, sales_order_type: "Pick-Up", delivery_method: "Pick-Up", order_type: "sales_order" }] };
    }
    return { items: [] };
  }, async () => {
    const lookup = () => request(assigned, "/api/customer-pickup/lookup", "POST", { code: "SOB999900", locationId: 1 });
    assert.equal((await lookup()).status, 403);
    assert.equal((await query("SELECT 1 FROM sales_orders WHERE netsuite_id=$1", [id])).rowCount, 0);
    returnedYard = 1;
    assert.equal((await lookup()).status, 200);
    assert.equal(Number((await query("SELECT outbound_location_id FROM sales_orders WHERE netsuite_id=$1", [id])).rows[0].outbound_location_id), 1);
  });
});

test("shared inventory sync accepts existing Control grants or independent Operator grants and rejects empty scopes", async () => {
  await withNetSuiteReadStub(() => ({ items: [] }), async () => {
    assert.equal((await request(empty, "/api/inventory/sync", "POST", { locationIds: [28] })).status, 200);
    assert.equal((await request(assigned, "/api/inventory/sync", "POST", { locationIds: [1] })).status, 200);
    assert.equal((await request(assigned, "/api/inventory/sync", "POST", { locationIds: [] })).status, 403);
    assert.equal((await request(empty, "/api/inventory/sync", "POST", { locationIds: [15] })).status, 403);
  });
});

test("local receiving jobs remain readable by their owner at the assigned yard and cannot be polled from another account", async () => {
  const id = 9_910_000_091;
  const receiver = await account("operator", [28]);
  const other = await account("operator", [28]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,destination_location_id,status,status_text,netsuite_active) VALUES($1,'YARD-RECEIPT',28,'B','Pending Receipt',true)", [id]);
  await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_type,quantity,unit,location_id,
    piece_qty,to_pcs,received_piece_qty,netsuite_active,confirmed_at,confirmed_by)
    VALUES($1,1,9910091,'YARD-RECEIVE','InvtPart',5,'PC',28,5,1,5,true,now(),$2)`, [id, receiver.operator.id]);
  const submission = await request(receiver, `/api/receiving/orders/${id}/receive`, "POST", { locationId: 28, orderType: "purchase_order", photoDataUrls: ["data:image/jpeg;base64,dGVzdDE=", "data:image/jpeg;base64,dGVzdDI="] });
  assert.equal(submission.status, 200, JSON.stringify(submission.data));
  assert.ok(submission.data.jobId);
  const endpoint = `/api/receiving/receipt-jobs/${submission.data.jobId}`;
  assert.equal((await request(receiver, endpoint)).status, 200);
  assert.equal((await request(other, endpoint)).status, 403);
  assert.equal((await request(assigned, endpoint)).status, 403);
  await updateOperatorRoles(receiver.operator.id, { role: "operator", roles: ["operator"], operatorYardLocationIds: [] });
  assert.equal((await request(receiver, endpoint)).status, 403);
  assert.equal((await request(admin, endpoint)).status, 200);
  assert.equal((await request(assigned, `/api/delivery/fulfillment-jobs/${crypto.randomUUID()}`)).status, 404);
});

for (const change of ["roles", "active", "password", "logout"]) {
  test(`an existing detailed live stream closes after account ${change}`, async () => {
    const session = await account("dispatcher", [1]);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 1500);
    try {
      const response = await fetch(`${base}/api/events?client=dispatch&token=${session.token}`, { signal: abort.signal });
      const reader = response.body.getReader();
      await reader.read();
      const changeResult = change === "logout"
        ? await request(session, "/api/auth/logout", "POST", {})
        : await request(admin, `/api/operators/${session.operator.id}/${change}`, change === "roles" ? "PUT" : "POST",
          change === "roles" ? { role: "operator", roles: ["operator"], operatorYardLocationIds: [] }
            : change === "active" ? { active: false } : { password: crypto.randomUUID() });
      assert.equal(changeResult.status, 200);
      let done = false;
      try { while (!done) { ({ done } = await reader.read()); } } catch { /* deadline: stream was not closed by the server */ }
      assert.equal(done, true, "revoked sessions must lose their existing detailed event stream");
    } finally { clearTimeout(timeout); abort.abort(); }
  });
}


test("a saved consolidation checks its current child order yard before active reads and release", async () => {
  const session = await account("operator", [1]);
  const batch = (await query("INSERT INTO operator_consolidation_batches(operator_id,location_id) VALUES($1,1) RETURNING id", [session.operator.id])).rows[0];
  await query("INSERT INTO operator_consolidation_orders(batch_id,order_key,order_ref,order_type) VALUES($1,$2,$3,'sales_order')", [batch.id, fixture.orderId, fixture.tranid]);
  const allowed = await request(session, "/api/delivery/consolidation/active?locationId=1");
  assert.equal(allowed.status, 200);
  assert.equal(String(allowed.data.batch.id), String(batch.id));
  await query("UPDATE sales_orders SET outbound_location_id=28 WHERE netsuite_id=$1", [fixture.orderId]);
  try {
    assert.equal((await request(session, "/api/delivery/consolidation/active?locationId=1")).status, 403);
    assert.equal((await request(session, "/api/delivery/consolidation/release", "POST", { locationId: 1 })).status, 403);
    assert.equal((await query("SELECT status FROM operator_consolidation_batches WHERE id=$1", [batch.id])).rows[0].status, "active");
  } finally { await query("UPDATE sales_orders SET outbound_location_id=1 WHERE netsuite_id=$1", [fixture.orderId]); }
});

test("return history details use stored ownership and yard while retaining accepted records", async () => {
  const ref = crypto.randomUUID();
  const batch = (await query("INSERT INTO return_batches(batch_reference,idempotency_key,operator_id,receiving_location_id,receiving_yard_code,vehicle_plate) VALUES($1,$1,$2,1,'3445','TEST') RETURNING id", [ref, assigned.operator.id])).rows[0];
  const record = (await query(`INSERT INTO return_records(record_reference,batch_id,record_type,operator_id,customer_id,customer_name,receiving_location_id,vehicle_plate,pallet_quantity,external_id)
    VALUES($1,$2,'pallet',$3,9910,'Yard History Customer',1,'TEST',2,$1) RETURNING id`, [ref, batch.id, assigned.operator.id])).rows[0];
  const endpoint = `/api/returns/operator/history/${record.id}`;
  assert.equal((await request(assigned, endpoint)).status, 200);
  assert.equal((await request(fixture, endpoint)).status, 404);
  await query("UPDATE return_records SET receiving_location_id=28 WHERE id=$1", [record.id]);
  assert.equal((await request(assigned, `${endpoint}?receivingLocationId=1`)).status, 403);
  assert.equal((await query("SELECT status FROM return_records WHERE id=$1", [record.id])).rows[0].status, "accepted");
});

test("new submissions retain quantity validation and create no empty return batch", async () => {
  const key = crypto.randomUUID();
  const result = await request(assigned, "/api/returns/submit", "POST", { receivingLocationId: 1, vehiclePlate: "TEST", idempotencyKey: key, palletQuantity: 0 });
  assert.equal(result.status, 400);
  assert.match(result.data.error, /Add stock or PALLET quantities/);
  assert.equal((await query("SELECT 1 FROM return_batches WHERE idempotency_key=$1", [`client:${assigned.operator.id}:${key}`])).rowCount, 0);
});


test("a failed authentication database read cannot open a detailed live stream", async () => {
  const nativeQuery = pool.query;
  const abort = new AbortController();
  try {
    // Replace only the database transport boundary; the real HTTP/auth path runs.
    pool.query = () => Promise.reject(new Error("Authentication database unavailable"));
    const response = await fetch(`${base}/api/events?client=dispatch&token=${admin.token}`, { signal: abort.signal });
    assert.equal(response.status, 500);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.doesNotMatch(await response.text(), /event: app-event|text\/event-stream/);
  } finally { pool.query = nativeQuery; abort.abort(); }
});


async function crossYardGroup() {
  const first = await seedOperatorPickup(), second = await seedOperatorPickup();
  await query("UPDATE sales_orders SET sales_order_type='Delivery' WHERE netsuite_id=ANY($1::bigint[])", [[first.orderId, second.orderId]]);
  await query("UPDATE sales_orders SET outbound_location_id=28 WHERE netsuite_id=$1", [second.orderId]);
  await query("UPDATE sales_order_lines SET location_id=28 WHERE sales_order_id=$1", [second.orderId]);
  const plan = (await query("INSERT INTO dispatch_plans(plan_date,status) VALUES(current_date,'confirmed') ON CONFLICT(plan_date) DO UPDATE SET plan_date=EXCLUDED.plan_date RETURNING id,plan_date::text", [])).rows[0];
  const id = `GRP-YARD-${crypto.randomUUID()}`;
  await query("INSERT INTO dispatch_delivery_groups(group_ref,plan_id,plan_date,order_type,truck_plate) VALUES($1,$2,current_date,'sales_order','YARD')", [id, plan.id]);
  await query("INSERT INTO dispatch_delivery_group_members(group_ref,member_order_ref,position) VALUES($1,$2,0),($1,$3,1)", [id, first.tranid, second.tranid]);
  return { id, first, second, date: plan.plan_date };
}

test("a grouped order requires every stored child yard before reads or packing", async () => {
  const group = await crossYardGroup();
  const session = await account("operator", [1]);
  assert.equal((await request(session, `/api/delivery/orders/${group.id}?locationId=1`)).status, 403);
  assert.equal((await request(session, `/api/delivery/orders/${group.id}/prepared`, "POST", { locationId: 1 })).status, 403);
  assert.equal((await query("SELECT operator_status FROM sales_orders WHERE netsuite_id=$1", [group.second.orderId])).rows[0].operator_status, "open");
  await updateOperatorRoles(session.operator.id, { role: "operator", roles: ["operator"], operatorYardLocationIds: [1, 28] });
  const allowed = await request(session, `/api/delivery/orders/${group.id}`);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.child_orders.length, 2);
});

test("yard lists and saved queues withhold unauthorized groups while preserving authorized standalone orders and saved rows", async () => {
  const group = await crossYardGroup();
  const session = await account("operator", [1]);
  await query("INSERT INTO operator_saved_delivery_orders(operator_id,location_id,order_key,order_ref,order_type) VALUES($1,1,$2,$2,'group_order')", [session.operator.id, group.id]);
  const paths = ["orders?locationId=1", "bootstrap?locationId=1", `load-orders?locationId=1&planDate=${group.date}`, "saved-orders?locationId=1", "saved-order-keys?locationId=1", "consolidation/queue?locationId=1", "notifications?locationId=1"];
  for (const path of paths) {
    const result = await request(session, `/api/delivery/${path}`);
    assert.equal(result.status, 200, path);
    assert.equal(JSON.stringify(result.data).includes(group.id), false, path);
    assert.equal(JSON.stringify(result.data).includes(group.second.tranid), false, path);
  }
  const refresh = await request(session, "/api/delivery/sync", "POST", { locationId: 1 });
  assert.equal(refresh.status, 200);
  assert.equal(JSON.stringify(refresh.data).includes(group.second.tranid), false);
  const standalone = await request(session, "/api/delivery/orders?locationId=1");
  assert.ok(standalone.data.some((row) => String(row.netsuite_id) === group.first.orderId));
  assert.equal((await request(session, "/api/delivery/consolidation/start", "POST", { locationId: 1 })).status, 409);
  assert.equal((await query("SELECT 1 FROM operator_saved_delivery_orders WHERE operator_id=$1 AND order_key=$2", [session.operator.id, group.id])).rowCount, 1);
  await updateOperatorRoles(session.operator.id, { role: "operator", roles: ["operator"], operatorYardLocationIds: [1, 28] });
  for (const path of ["orders?locationId=1", "saved-orders?locationId=1", "saved-order-keys?locationId=1", "consolidation/queue?locationId=1"]) {
    const result = await request(session, `/api/delivery/${path}`);
    assert.equal(result.status, 200);
    assert.ok(JSON.stringify(result.data).includes(group.id), path);
  }
});

test("property: grouped access requires both the first yard and each child yard", async () => {
  const group = await crossYardGroup();
  const session = await account("operator", []);
  await fc.assert(fc.asyncProperty(fc.subarray([1, 28, 15, 26]), fc.constantFrom(1, 28, 15, 26), async (grants, childYard) => {
    await updateOperatorRoles(session.operator.id, { role: "operator", roles: ["operator"], operatorYardLocationIds: grants });
    await query("UPDATE sales_orders SET outbound_location_id=$2 WHERE netsuite_id=$1", [group.second.orderId, childYard]);
    await query("UPDATE sales_order_lines SET location_id=$2 WHERE sales_order_id=$1", [group.second.orderId, childYard]);
    const result = await request(session, `/api/delivery/orders/${group.id}`);
    assert.equal(result.status, grants.includes(1) && grants.includes(childYard) ? 200 : 403);
  }), { seed: 20260915, numRuns: 30 });
});
