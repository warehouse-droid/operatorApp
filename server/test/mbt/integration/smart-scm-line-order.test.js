import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { after, before, test } from "node:test";
import { closeDb, query, withTransaction } from "../../../src/db.js";
import { getSmartScmProposal, prepareSmartScmTransferExecution } from "../../../src/smart-scm-planning-repository.js";
import { saveSmartScmProposalLineOrder } from "../../../src/smart-scm-line-order-repository.js";
import { stageSmartScmVendorReplyLoad, prepareSmartScmPurchaseExecution } from "../../../src/smart-scm-vendor-repository.js";
import { ensureSmartScmVendorWorkflow, getSmartScmVendorWorkflowForProposal } from "../../../src/smart-scm-vendor-workflow-repository.js";
import { buildSmartScmPurchaseOrderRestPayload } from "../../../src/smart-scm-purchase-netsuite.js";
import { buildTransferDependencyRestPayload } from "../../../src/transfer-dependency-netsuite.js";

const actor = "line-order-test";
let counter = 0;
after(closeDb);
before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1", "only run against the disposable test database");
  await query(`INSERT INTO operators (id,username,display_name,password_hash,password_salt,role,roles,active)
    VALUES ($1,$1,$1,'fixture','fixture','scm',ARRAY['scm'],true) ON CONFLICT (id) DO NOTHING`, [actor]);
  for (const [itemId, name, rate] of [[910001, "Material A", 5], [910002, "Material B", 6], [910003, "Material C", 7], [1784, "PALLET", 35]]) {
    await query(`INSERT INTO inventory_items (item_id,item_name,stock_unit,purchase_unit,last_purchase_price,to_plt,item_weight,vendor_id,vendor)
      VALUES ($1,$2,'EACH','EACH',$3,10,100,8100,'Order Vendor') ON CONFLICT (item_id) DO NOTHING`, [itemId, name, rate]);
  }
});

async function load(type = "PO", status = "order_requested") {
  const run = await query(`INSERT INTO scm_smart_planning_runs (status,trigger_source,settings_snapshot,totals,created_by,completed_at)
    VALUES ('ready','manual','{"truck_capacity_lbs":78000}','{}',$1,now()) RETURNING id`, [actor]);
  const proposal = await query(`INSERT INTO scm_smart_proposals
    (run_id,proposal_key,proposal_type,phase,source_kind,source_location_id,source_name,destination_location_id,destination_name,vendor,status,total_pallets,total_weight_lbs,utilization)
    VALUES ($1,$2,$3,'direct_vendor',$4,$5,'Order Vendor',1,'3445','Order Vendor',$6,6,6000,0.1) RETURNING id`,
  [run.rows[0].id, `line-order-${++counter}`, type, type === "PO" ? "vendor" : "yard", type === "PO" ? null : 28, status]);
  const id = Number(proposal.rows[0].id);
  const lineIds = [];
  for (const [index, item] of [910001, 910002, 910003].entries()) {
    const inserted = await query(`INSERT INTO scm_smart_proposal_lines
      (proposal_id,item_id,item_name,unit,required_pallets,proposed_pallets,confirmed_pallets,residual_pallets,sales_quantity,pallet_weight_lbs,line_weight_lbs,to_plt,destination_location_id,destination_name,last_purchase_price,purchase_unit)
      VALUES ($1,$2,$3,'EACH',$4,$4,0,$4,$5,1000,$6,10,1,'3445',$7,'EACH') RETURNING id`,
    [id, item, `Material ${index + 1}`, index + 1, (index + 1) * 10, (index + 1) * 1000, 5 + index]);
    lineIds.push(Number(inserted.rows[0].id));
  }
  const current = await getSmartScmProposal(id);
  const order = [`line:${lineIds[0]}`, `line:${lineIds[1]}`, "pallet:1", `line:${lineIds[2]}`];
  return { id, current, lineIds, order };
}

test("saved PO and TO order survives reload without changing any line fields or totals", async () => {
  for (const type of ["PO", "TO"]) {
    const fixture = await load(type, "held");
    const beforeLines = await query("SELECT * FROM scm_smart_proposal_lines WHERE proposal_id=$1 ORDER BY id", [fixture.id]);
    const saved = await saveSmartScmProposalLineOrder(fixture.id, { lineOrder: fixture.order, expectedLineOrder: fixture.current.lineOrder }, actor);
    assert.deepEqual(saved.lineOrder, fixture.order);
    assert.deepEqual((await getSmartScmProposal(fixture.id)).lineOrder, fixture.order);
    assert.deepEqual((await query("SELECT * FROM scm_smart_proposal_lines WHERE proposal_id=$1 ORDER BY id", [fixture.id])).rows, beforeLines.rows);
    for (const key of ["totalPallets", "totalWeightLbs", "palletQuantityOverrides", "destinationLocationId"]) assert.deepEqual(saved[key], fixture.current[key]);
    const audit = await query("SELECT details,actor_operator_id FROM delivery_audit_log WHERE action='scm.smart.proposal.line-order' AND details->>'proposalId'=$1", [String(fixture.id)]);
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].actor_operator_id, actor);
    assert.deepEqual(audit.rows[0].details.lineOrder, fixture.order);
  }
});

test("invalid, stale and locked order edits cannot persist", async () => {
  const fixture = await load();
  await assert.rejects(saveSmartScmProposalLineOrder(fixture.id, { lineOrder: ["line:foreign"], expectedLineOrder: fixture.current.lineOrder }, actor), (e) => e.status === 400);
  assert.deepEqual((await getSmartScmProposal(fixture.id)).lineOrder, fixture.current.lineOrder);
  await assert.rejects(saveSmartScmProposalLineOrder(fixture.id, { lineOrder: fixture.order, expectedLineOrder: [] }, actor), (e) => e.status === 409);
  for (const status of ["executing", "completed", "cancelled", "superseded"]) {
    await query("UPDATE scm_smart_proposals SET status=$2 WHERE id=$1", [fixture.id, status]);
    await assert.rejects(saveSmartScmProposalLineOrder(fixture.id, { lineOrder: fixture.order, expectedLineOrder: fixture.current.lineOrder }, actor), (e) => e.status === 409);
  }
  await query("UPDATE scm_smart_proposals SET status='held',netsuite_purchase_order_id=99 WHERE id=$1", [fixture.id]);
  await assert.rejects(saveSmartScmProposalLineOrder(fixture.id, { lineOrder: fixture.order, expectedLineOrder: fixture.current.lineOrder }, actor), (e) => e.status === 409);
  await assert.rejects(saveSmartScmProposalLineOrder(99999999, {}, actor), (e) => e.status === 404);
});

test("concurrent reorders serialize and reject the obsolete writer", async () => {
  const fixture = await load();
  const outcomes = await Promise.allSettled([
    saveSmartScmProposalLineOrder(fixture.id, { lineOrder: fixture.order, expectedLineOrder: fixture.current.lineOrder }, actor),
    saveSmartScmProposalLineOrder(fixture.id, { lineOrder: fixture.order.slice().reverse(), expectedLineOrder: fixture.current.lineOrder }, actor)
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = outcomes.find((r) => r.status === "rejected");
  assert.equal(rejected.reason.status, 409);
  assert.deepEqual((await getSmartScmProposal(fixture.id)).lineOrder, outcomes.find((r) => r.status === "fulfilled").value.lineOrder);
});

test("an audit failure rolls back the order update", async () => {
  const fixture = await load();
  await assert.rejects(saveSmartScmProposalLineOrder(fixture.id, { lineOrder: fixture.order, expectedLineOrder: fixture.current.lineOrder }, "absent-operator"), (e) => e.code === "23503");
  assert.deepEqual((await getSmartScmProposal(fixture.id)).lineOrder, fixture.current.lineOrder);
});

test("vendor staging and purchase preparation preserve PALLET in the third position", async () => {
  const fixture = await load();
  await ensureSmartScmVendorWorkflow(fixture.id, actor);
  await saveSmartScmProposalLineOrder(fixture.id, { lineOrder: fixture.order, expectedLineOrder: fixture.current.lineOrder }, actor);
  const staged = await stageSmartScmVendorReplyLoad(fixture.id, {
    readyDate: "2026-10-01", lines: fixture.lineIds.map((id, index) => ({ proposalLineId: id, decision: "confirm", decisionPallets: index + 1 }))
  }, actor);
  assert.deepEqual((await getSmartScmProposal(staged.reviewProposalId)).lineOrder, fixture.order);
  const workflow = await getSmartScmVendorWorkflowForProposal(fixture.id);
  assert.deepEqual(workflow.lineOrder, fixture.order);
  const prepared = await prepareSmartScmPurchaseExecution(staged.reviewProposalId, actor, { executionMode: "mock" });
  const payload = buildSmartScmPurchaseOrderRestPayload({ proposal: prepared, locations: [{ localLocationId: 1, netsuiteLocationId: 1, subsidiaryId: 2 }] });
  assert.deepEqual(payload.item.items.map((line) => line.item.id), ["910001", "910002", "1784", "910003"]);
  assert.deepEqual(payload.item.items.map((line) => line.quantity), [10, 20, 6, 30]);
});

test("line-order migration is idempotent and can be rolled back in a transaction", async () => {
  const sql = await fs.readFile(new URL("../../../migrations/244_smart_scm_line_order.sql", import.meta.url), "utf8");
  await query(sql);
  await query(sql);
  await withTransaction(async () => {
    await query("ALTER TABLE scm_smart_proposals DROP COLUMN line_order");
    await query(sql);
    await query("UPDATE scm_smart_proposals SET line_order='[]'");
    await assert.rejects(withTransaction(() => query("UPDATE scm_smart_proposals SET line_order='{}'")), (e) => e.code === "23514");
  }, { rollback: true });
  const fixture = await load();
  assert.equal(fixture.current.lineOrder.length, 4);
});

test("partial vendor confirmation preserves surviving rows and the correct PALLET quantity", async () => {
  const fixture = await load();
  await saveSmartScmProposalLineOrder(fixture.id, { lineOrder: fixture.order, expectedLineOrder: fixture.current.lineOrder }, actor);
  const staged = await stageSmartScmVendorReplyLoad(fixture.id, { readyDate: "2026-10-01", lines: [
    { proposalLineId: fixture.lineIds[0], decision: "confirm", decisionPallets: 1 },
    { proposalLineId: fixture.lineIds[1], decision: "cancel", decisionPallets: 0 },
    { proposalLineId: fixture.lineIds[2], decision: "confirm", decisionPallets: 2 }
  ] }, actor);
  const review = await getSmartScmProposal(staged.reviewProposalId);
  assert.deepEqual(review.lineOrder, [fixture.order[0], "pallet:1", fixture.order[3]]);
  const prepared = await prepareSmartScmPurchaseExecution(staged.reviewProposalId, actor, { executionMode: "mock" });
  const items = buildSmartScmPurchaseOrderRestPayload({ proposal: prepared, locations: [{ localLocationId: 1, netsuiteLocationId: 1 }] }).item.items;
  assert.deepEqual(items.map((line) => [line.item.id, line.quantity]), [["910001", 10], ["1784", 3], ["910003", 20]]);
});

test("a held vendor child preserves PALLET before its remaining material line", async () => {
  const fixture = await load();
  const order = ["pallet:1", ...fixture.lineIds.map((id) => `line:${id}`)];
  await saveSmartScmProposalLineOrder(fixture.id, { lineOrder: order, expectedLineOrder: fixture.current.lineOrder }, actor);
  const staged = await stageSmartScmVendorReplyLoad(fixture.id, { lines: fixture.lineIds.map((id, index) => ({
    proposalLineId: id, decision: index === 0 ? "hold" : "confirm", decisionPallets: index + 1
  })) }, actor);
  const held = await getSmartScmProposal(staged.heldProposalIds[0]);
  assert.deepEqual(held.lineOrder, ["pallet:1", `line:${fixture.lineIds[0]}`]);
});

test("TO preparation retains the saved order in the submitted transfer payload", async () => {
  for (const itemId of [910001, 910002, 910003]) {
    await query(`INSERT INTO scm_smart_item_policies (item_id,item_name,vendor,stock_unit,to_plt,pallet_weight_lbs,planning_enabled)
      VALUES ($1,'Transfer material','Order Vendor','EACH',10,1000,true) ON CONFLICT (item_id) DO UPDATE SET planning_enabled=true`, [itemId]);
    await query(`INSERT INTO scm_smart_item_yard_policies (item_id,location_id,yard_code,eligible,capacity_pallets,service_quantile,minimum_safety_pallets)
      VALUES ($1,28,'2967',true,100,0.9,1) ON CONFLICT (item_id,location_id) DO UPDATE SET eligible=true`, [itemId]);
    await query(`INSERT INTO inventory_balances (item_id,location_id,location,quantity_on_hand,quantity_available)
      VALUES ($1,28,'2967',1000,1000) ON CONFLICT (item_id,location_id) DO UPDATE SET quantity_available=1000`, [itemId]);
  }
  const fixture = await load("TO", "reviewed");
  await saveSmartScmProposalLineOrder(fixture.id, { lineOrder: fixture.order, expectedLineOrder: fixture.current.lineOrder }, actor);
  const prepared = await prepareSmartScmTransferExecution(fixture.id, actor);
  const result = buildTransferDependencyRestPayload({ proposal: { ...prepared, palletItemId: 1784 }, batch: { id: "smart-test" },
    locations: { source: { netsuiteLocationId: 28, subsidiaryId: 2 }, destination: { netsuiteLocationId: 1 } } });
  assert.deepEqual(result.item.items.map((line) => [line.item.id, line.quantity]), [["910001", 10], ["910002", 20], ["1784", 6], ["910003", 30]]);
});

test("the real reorder endpoint enforces SCM access and returns the saved order", async () => {
  const { app } = await import("../../../src/server.js");
  const { createOperator, loginOperator } = await import("../../../src/auth-repository.js");
  const tokens = {};
  for (const role of ["scm", "operator"]) {
    const username = `line_order_http_${role}_${Date.now()}`;
    await createOperator({ username, displayName: username, password: "LocalTestFixture123!", role });
    tokens[role] = (await loginOperator(username, "LocalTestFixture123!")).token;
  }
  const fixture = await load();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/scm/smart/proposals/${fixture.id}/line-order`;
  const body = { lineOrder: fixture.order, expectedLineOrder: fixture.current.lineOrder };
  const send = (token, values = body) => fetch(url, { method: "PUT", headers: { "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(values) });
  try {
    assert.equal((await send("")).status, 401);
    assert.equal((await send(tokens.operator, { ...body, actor: { role: "admin" } })).status, 403);
    const saved = await send(tokens.scm);
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).lineOrder, fixture.order);
    assert.equal((await send(tokens.scm)).status, 409);
    assert.equal((await send(tokens.scm, { lineOrder: ["line:foreign"], expectedLineOrder: fixture.order })).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
