import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { listOperatorHistory } from "../../../src/history-repository.js";
import { listYardMovements, getYardMovementDetail } from "../../../src/yard-movement-repository.js";
import { movementDocuments, movementRecordEvidence } from "../../../src/movement-record-evidence.js";

after(closeDb);
const date = "2097-09-27";
const filters = { from: date, to: date, direction: "outbound", orderType: "sales_order", yard: "all" };
const posting = (type, ref) => ({ operatorNetSuitePosting: { transactions: [{ transactionType: type, transactionRef: ref }] } });

async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  assert.match(process.env.DATABASE_URL, /\/mbt_(test|verify)(?:\?|$)/);
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID();
      const orderId = 9900000000 + crypto.randomInt(100000000);
      const ref = `SOB-HISTORY-${suffix}`;
      const op = (await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role) VALUES($1,$1,'History Test','unusable','unusable','operator') RETURNING id", [suffix])).rows[0].id;
      await query(`INSERT INTO sales_orders(netsuite_id,tranid,outbound_location_id,outbound_location,sales_order_type,
        status,operator_status,local_yard_order_status,netsuite_active) VALUES($1,$2,1,'3445','Delivery','B','loaded','Loaded',true)`, [orderId, ref]);
      const load = async (type = "sales_order_delivery_load", response = {}, time = "10:00:00") => (await query(
        `INSERT INTO operator_load_records(load_type,order_family,order_id,order_ref,operator_id,loaded_qty,loaded_uom,line_snapshot,response,created_at)
         VALUES($1,'sales_order',$2,$3,$4,1,'EA','[]',$5,$6) RETURNING id`, [type, orderId, ref, op, response, `${date}T${time}Z`])).rows[0].id;
      const drop = async (time = "12:00:00", status = "complete", stop = "dropoff") => (await query(
        `INSERT INTO driver_job_records(job_id,plan_date,driver_login,truck_id,truck_plate,load_id,load_name,stop_id,stop_type,order_refs,status,started_at,completed_at,created_at)
         VALUES($1,$2,'history-test','test','test','test','test','test',$3,$4,$5,$6,$7,$6) RETURNING id,job_id`,
        [crypto.randomUUID(), date, stop, JSON.stringify([ref]), status, `${date}T${time}Z`, status === "complete" ? `${date}T${time}Z` : null])).rows[0];
      const history = () => listOperatorHistory({ operatorId: op, date, yardLocationIds: [1] });
      const movements = () => listYardMovements({ ...filters, search: ref, allowedYardLocationIds: [1] });
      await run({ op, orderId, ref, load, drop, history, movements });
    });
  } finally { await rollback.rollback(); }
}

test("saved IFs display for pickups in both lists and details without a driver wait", async () => fixture(async (f) => {
  await f.load("customer_pickup_load", posting("IF", "IF155552"));
  const [history] = await f.history();
  assert.deepEqual(history.documents, [{ type: "IF", ref: "IF155552" }]);
  assert.equal(history.waitingForDriverCompletion, false);
  const [movement] = await f.movements();
  assert.deepEqual(movement.documents, history.documents);
  assert.equal(movement.waitingForDriverCompletion, false);
  const detail = await getYardMovementDetail({ ...filters, orderId: f.orderId, allowedYardLocationIds: [1] });
  assert.deepEqual(detail.order.documents, history.documents);
  assert.equal(await getYardMovementDetail({ ...filters, orderId: f.orderId, allowedYardLocationIds: [28] }), null);
  assert.deepEqual(await listOperatorHistory({ operatorId: f.op, date, yardLocationIds: [28] }), []);
  assert.deepEqual(await listOperatorHistory({ operatorId: crypto.randomUUID(), date, yardLocationIds: [1] }), []);
}));

test("waiting ends on the drop, not the pickup, prior delivery, or IF availability", async () => fixture(async (f) => {
  await f.drop("09:00:00");
  await f.load();
  await f.drop("11:00:00", "complete", "pickup");
  await f.drop("11:30:00", "in_progress");
  assert.equal((await f.history())[0].waitingForDriverCompletion, true);
  assert.equal((await f.movements())[0].waitingForDriverCompletion, true);
  await f.drop();
  assert.equal((await f.history())[0].waitingForDriverCompletion, false);
  assert.deepEqual((await f.history())[0].documents, []);
  assert.equal((await f.movements())[0].waitingForDriverCompletion, false);
  await f.load("sales_order_delivery_load", {}, "13:00:00");
  assert.equal((await f.history())[0].waitingForDriverCompletion, true);
  assert.equal((await f.movements())[0].waitingForDriverCompletion, true);
  await query("UPDATE sales_orders SET local_yard_order_status='Closed' WHERE netsuite_id=$1", [f.orderId]);
  assert.equal((await f.history())[0].waitingForDriverCompletion, false);
}));

test("driver-created IF follows its saved load snapshot and completion outside the selected date", async () => fixture(async (f) => {
  const load = await f.load();
  const driver = await f.drop();
  const completion = (await query("SELECT id FROM dispatch_order_completion_events WHERE completion_evidence_id=$1", [driver.job_id])).rows[0].id;
  await query(`UPDATE dispatch_sales_order_if_candidates SET status='completed', completed_at=now(),
    netsuite_transaction_ref='IF-DELIVERED', netsuite_transaction_id=99999999,
    line_snapshot=$2 WHERE completion_event_id=$1`, [completion, JSON.stringify([{ operatorLoadRecordId: String(load) }])]);
  assert.deepEqual((await f.history())[0].documents, [{ type: "IF", ref: "IF-DELIVERED" }]);
  assert.deepEqual((await f.movements())[0].documents, [{ type: "IF", ref: "IF-DELIVERED" }]);
  const later = await f.load("sales_order_delivery_load", {}, "13:00:00");
  const evidence = await movementRecordEvidence({ loadIds: [later], driverIds: [driver.id] });
  assert.deepEqual(evidence.get(`load-${later}`).documents, []);
  assert.deepEqual(evidence.get(`driver-${driver.id}:${f.ref.toLowerCase()}`).documents, [{ type: "IF", ref: "IF-DELIVERED" }]);
  await query("UPDATE driver_job_records SET completed_at='2097-09-28T01:00:00Z' WHERE id=$1", [driver.id]);
  // Use a new immutable event for the next day's drop; date filtering must not
  // hide current completion from yesterday's load history.
  await query(`SELECT dispatch_record_order_completion('SO',$1,'2097-09-28T01:00:00Z','manual_dispatch',$2,
    NULL,NULL,NULL,'operator','test','Delivered verified','{}')`, [f.ref, crypto.randomUUID()]);
  assert.equal((await f.history())[0].waitingForDriverCompletion, false);
}));

test("receipt IR number appears from both legacy and posting evidence and keeps yard scope", async () => fixture(async (f) => {
  const po = f.orderId + 1;
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,destination_location_id,destination_location) VALUES($1,$2,1,'3445')", [po, `PO-${f.ref}`]);
  await query(`INSERT INTO receiving_receipt_records(order_id,operator_id,item_receipt_tranid,receipt_status,response,created_at)
    VALUES($1,$2,'IR14831','received',$3,$4)`, [po, f.op, posting("IR", "IR14831"), `${date}T10:00:00Z`]);
  const [history] = await f.history();
  assert.deepEqual(history.documents, [{ type: "IR", ref: "IR14831" }]);
  const [movement] = await listYardMovements({ ...filters, direction: "inbound", orderType: "purchase_order", search: `PO-${f.ref}`, allowedYardLocationIds: [1] });
  assert.deepEqual(movement.documents, history.documents);
  assert.equal(movement.waitingForDriverCompletion, false);
}));

test("document formatting deduplicates evidence and does not invent unavailable numbers", async () => {
  assert.deepEqual(movementDocuments(null, [{ transactionType: "IF", transactionId: 55 }, { transactionType: "SO", transactionRef: "SO55" }]), []);
  assert.deepEqual(movementDocuments(posting("IF", " IF1 "), [
    { transactionType: "IF", transactionRef: "IF1" }, { transactionType: "IR", transactionRef: "IR1" }, { transactionType: "IF", transactionRef: "IF2" }
  ]), [{ type: "IF", ref: "IF1" }, { type: "IR", ref: "IR1" }, { type: "IF", ref: "IF2" }]);
  assert.equal((await movementRecordEvidence()).size, 0);
  assert.deepEqual(movementDocuments({ operatorNetSuitePosting: { transactions: [
    { transactionType: "IF", transactionRef: "IF-THIS-ORDER", sourceNetSuiteId: 1 },
    { transactionType: "IF", transactionRef: "IF-OTHER-ORDER", sourceNetSuiteId: 2 }
  ] } }, [], 1), [{ type: "IF", ref: "IF-THIS-ORDER" }]);
});

test("transfer load history no longer waits for its driver drop", async () => fixture(async (f) => {
  const id = f.orderId + 1, ref = `TO-${f.ref}`;
  await query("INSERT INTO transfer_orders(netsuite_id,tranid,from_location_id,to_location_id,local_yard_order_status) VALUES($1,$2,1,28,'Loaded')", [id, ref]);
  const load = (await query(`INSERT INTO operator_load_records(load_type,order_family,order_id,order_ref,operator_id,response,created_at)
    VALUES('transfer_order_load','transfer_order',$1,$2,$3,$4,$5) RETURNING id`, [id, ref, f.op, posting("IF", "IF-TRANSFER"), `${date}T10:00:00Z`])).rows[0].id;
  let record = (await movementRecordEvidence({ loadIds: [load] })).get(`load-${load}`);
  assert.deepEqual(record.documents, [{ type: "IF", ref: "IF-TRANSFER" }]);
  assert.equal(record.waitingForDriverCompletion, false);
  await query(`SELECT dispatch_record_order_completion('TO',$1,$2,'driver_job',$3,NULL,NULL,NULL,'driver','test')`, [ref, `${date}T12:00:00Z`, crypto.randomUUID()]);
  record = (await movementRecordEvidence({ loadIds: [load] })).get(`load-${load}`);
  assert.equal(record.waitingForDriverCompletion, false);
}));

test("multipart IF numbers show individually even while another part is pending", async () => fixture(async (f) => {
  const load = await f.load();
  const driver = await f.drop();
  const candidate = (await query(`SELECT c.id,c.external_id FROM dispatch_sales_order_if_candidates c JOIN dispatch_order_completion_events e
    ON e.id=c.completion_event_id WHERE e.completion_evidence_id=$1`, [driver.job_id])).rows[0];
  await query("UPDATE dispatch_sales_order_if_candidates SET line_snapshot=$2 WHERE id=$1", [candidate.id, JSON.stringify([{ operatorLoadRecordId: String(load) }])]);
  await query("INSERT INTO netsuite_item_fulfillment_plans(external_id,source_netsuite_id,payload_hash,payload) VALUES($1,$2,$3,'{}')", [candidate.external_id, f.orderId, 'a'.repeat(64)]);
  for (const [location, ref, status] of [[1, 'IF-PART-1', 'posted'], [28, 'IF-PART-2', 'posted'], [15, null, 'pending']]) {
    await query(`INSERT INTO netsuite_item_fulfillment_parts(plan_external_id,location_id,external_id,payload_hash,payload,status,netsuite_transaction_ref,netsuite_transaction_id)
      VALUES($1,$2::bigint,$3,$4,'{}',$5,$6, CASE WHEN $5='posted' THEN $2::bigint ELSE NULL END)`, [candidate.external_id, location, `${candidate.external_id}-${location}`, 'a'.repeat(64), status, ref]);
  }
  assert.deepEqual((await f.history())[0].documents, [{ type: 'IF', ref: 'IF-PART-1' }, { type: 'IF', ref: 'IF-PART-2' }]);
}));
