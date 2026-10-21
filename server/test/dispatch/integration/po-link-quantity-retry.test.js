import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after, before } from "node:test";
import vm from "node:vm";
import { parse } from "espree";
import fc from "fast-check";
import { query, withTransaction } from "../../../src/db.js";
import { createDispatchPlan } from "../../../src/dispatch-plan-repository.js";
import {
  createSalesOrderPoAllocations,
  getSalesOrderPoAllocationOptions
} from "../../../src/dispatch-repository.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";

let http;
let sequence = 0;
before(async () => { http = await createDispatchV2Fixture(); });
after(async () => { await http?.close(); });

async function seed({ sales = 28, purchase = 23, physical = false, group = false } = {}) {
  sequence += 1;
  const base = 9876540000 + sequence * 10;
  const ref = `SO-QUANTITY-RETRY-${base}`;
  const poRef = `LOCAL-PO-QUANTITY-${base}`;
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,status,status_text,
    sales_order_type,outbound_location_id,outbound_location,dispatch_address,fulfillment_status,netsuite_active)
    VALUES ($1,$2,'Isolated quantity customer','B','Pending Fulfillment','Delivery',28,'2967',
      '30 Isolated Road','not_fulfilled',true)`, [base, ref]);
  const line = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,
    item_type,quantity,unit,piece_qty,to_pcs,netsuite_backordered_qty,netsuite_committed_qty,netsuite_active)
    VALUES ($1,28,1784,'PALLET','PALLET','InvtPart',$2,'EACH',$3,0,$2,0,true) RETURNING *`,
  [base, sales, physical ? sales : 0])).rows[0];
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,vendor,status,status_text,
    destination_location_id,destination_location,dispatch_vendor_yard,dispatch_address,receipt_status,netsuite_active)
    VALUES ($1,$2,$3,'Isolated vendor','B','Pending Receipt',28,'2967',
      'Isolated vendor','20 Isolated Road','not_received',true)`, [base + 1, `PO-ORIGINAL-${base}`, poRef]);
  const poLine = (await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,sku,
    item_type,quantity,unit,piece_qty,to_pcs,location_id,location,netsuite_active)
    VALUES ($1,23,1784,'PALLET','PALLET','InvtPart',$2,'EACH',$3,0,28,'2967',true) RETURNING *`,
  [base + 1, purchase, physical ? purchase : 0])).rows[0];
  let targetRef = ref;
  if (group) {
    targetRef = `GOB-QUANTITY-${base}`;
    const plan = await createDispatchPlan({ planDate: "2097-10-20" });
    const child = { id: ref, type: "SO", items: [{
      lineRowId: Number(line.id), lineId: 28, itemId: 1784, sku: "PALLET",
      quantity: sales, unit: "EACH", pieces: physical ? sales : 0
    }] };
    const order = { id: targetRef, type: "SO", childOrders: [ref], childOrderDetails: [child], items: child.items };
    await query(`INSERT INTO dispatch_global_order_groups(group_ref,order_type,source_plan_id,
      source_plan_date,full_order,card) VALUES($1,'SO',$2,'2097-10-20',$3::jsonb,$3::jsonb)`,
    [targetRef, plan.id, JSON.stringify(order)]);
    await query(`INSERT INTO dispatch_global_order_group_members(group_ref,member_order_ref,position)
      VALUES($1,$2,0)`, [targetRef, ref]);
  }
  return { base, ref, targetRef, poRef, line, poLine };
}

function linkBody(f, quantities) {
  return {
    dispatchTargetRef: f.targetRef, poRef: f.poRef,
    lines: [{ salesLineId: f.line.id, poLineId: f.poLine.id, quantities }]
  };
}

async function count(f) {
  return Number((await query(
    "SELECT count(*) FROM dispatch_so_po_allocations WHERE sales_order_id=$1 AND status='active'", [f.base]
  )).rows[0].count);
}

async function client(f, fetchOverride) {
  const planDate = `2097-11-${String(sequence).padStart(2, "0")}`;
  const created = await createDispatchPlan({ planDate });
  const sessionId = randomUUID();
  const lease = await http.acquireLease({ planDate, sessionId });
  const { payload: plan } = await http.request(`/api/dispatch/plans/${created.id}`);
  const sent = [];
  const source = readFileSync(new URL("../../../public/dispatch.js", import.meta.url), "utf8");
  const declarations = parse(source, { ecmaVersion: "latest", sourceType: "script", range: true }).body;
  const state = vm.createContext({
    currentPlan: plan, currentPlanDate: planDate, dispatchSessionId: sessionId, planEditLeaseToken: lease,
    pendingDispatchPlanAction: null, localPlanGeneration: 0, localPlanDirty: false, saveQueued: false,
    confirmInFlight: false, minimumPlanRevisionToApply: null,
    saveCurrentPlanNow: async () => {}, persistDispatchPendingRequest: async () => {},
    queueDispatchDraftJournal: () => {}, queueServerSave: () => {},
    newDependencyRequestId: randomUUID,
    applyAtomicDependencyMutationPayload: result => {
      if (result.plan) { state.currentPlan = result.plan; }
      return true;
    },
    dispatchErrorMessage: async response => (await response.json()).error,
    fetch: async (url, init = {}) => {
      if (init.method === "POST") {
        sent.push(JSON.parse(init.body));
        if (fetchOverride) { return fetchOverride(url, init); }
      }
      return fetch(http.baseUrl + url, {
        ...init, headers: { ...init.headers, authorization: `Bearer ${http.session.token}` }
      });
    }
  });
  for (const name of ["performDispatchDependencyMutation", "dispatchPlanActionRequest",
    "dispatchLeaseRequestPayload", "refreshDispatchDependencyPlanFence"]) {
    const node = declarations.find(entry => entry.type === "FunctionDeclaration" && entry.id.name === name);
    assert.ok(node, name);
    vm.runInContext(source.slice(...node.range), state);
  }
  return {
    state, sent,
    submit: quantities => state.performDispatchDependencyMutation({
      url: `/api/dispatch/orders/${encodeURIComponent(f.targetRef)}/po-allocations?response=targeted`,
      payload: linkBody(f, quantities)
    })
  };
}

test("grouped PALLET 28 rejected, corrected 23 submits fresh and leaves 5 open", async () => {
  const f = await seed({ group: true });
  const c = await client(f);
  await assert.rejects(c.submit({ salesQty: 28 }), /only has 23 sales quantity available/u);
  assert.equal(await count(f), 0);
  assert.ok(c.state.pendingDispatchPlanAction === null, "A quantity rejection must not freeze the rejected 28.");
  await c.submit({ salesQty: 23 });
  assert.equal(c.sent.length, 2);
  assert.deepEqual(c.sent.map(body => body.lines[0].quantities.salesQty), [28, 23]);
  assert.notEqual(c.sent[0].requestId, c.sent[1].requestId);
  assert.equal(await count(f), 1);
  const options = await getSalesOrderPoAllocationOptions(f.targetRef);
  assert.equal(options.salesLines[0].available.salesQty, 5);
  assert.equal(options.poLines.find(line => Number(line.id) === Number(f.poLine.id)).available.salesQty, 0);
  const replay = await http.request(`/api/dispatch/orders/${f.targetRef}/po-allocations?response=targeted`, {
    method: "POST", body: c.sent[1]
  });
  assert.equal(replay.response.status, 200, JSON.stringify(replay.payload));
  assert.equal(await count(f), 1, "Acknowledgement replay must not allocate twice.");
});

for (const [name, sales, purchase, quantities, message] of [
  ["SO base", 23, 28, { salesQty: 28 }, /SO open sales quantity is only 23/u],
  ["PO base", 28, 23, { salesQty: 28 }, /PO .* only has 23 sales quantity available/u],
  ["SO physical", 23, 28, { pieces: 28 }, /SO open quantity is only 23 PCS/u],
  ["PO physical", 28, 23, { pieces: 28 }, /PO .* only has 23 PCS available/u]
]) {
  test(`${name} capacity rejection is HTTP 400 with a stable code and no allocation`, async () => {
    const f = await seed({ sales, purchase, physical: true });
    const c = await client(f);
    const payload = c.state.dispatchLeaseRequestPayload({ ...linkBody(f, quantities), requestId: randomUUID() });
    const result = await http.request(`/api/dispatch/orders/${f.targetRef}/po-allocations`, {
      method: "POST", body: payload
    });
    assert.equal(result.response.status, 400, JSON.stringify(result.payload));
    assert.equal(result.payload.code, "DISPATCH_PO_LINK_QUANTITY_EXCEEDED");
    assert.match(result.payload.error, message);
    assert.equal(await count(f), 0);
  });
}

test("a rejected batch rolls back earlier lines and the corrected batch allocates exactly 23", async () => {
  const f = await seed();
  const body = linkBody(f, { salesQty: 10 });
  body.lines.push({ ...body.lines[0], quantities: { salesQty: 14 } });
  await assert.rejects(createSalesOrderPoAllocations(body), error =>
    error.status === 400 && error.code === "DISPATCH_PO_LINK_QUANTITY_EXCEEDED");
  assert.equal(await count(f), 0);
  body.lines[1].quantities.salesQty = 13;
  const result = await createSalesOrderPoAllocations(body);
  assert.equal(result.reduce((total, row) => total + row.salesQty, 0), 23);
  assert.equal(await count(f), 2);
});

for (const mode of ["HTTP 500", "lost response"]) {
  test(`${mode} retains the original quantity and request identity on retry`, async () => {
    const f = await seed();
    const c = await client(f, () => {
      if (mode === "lost response") { throw new Error("connection lost"); }
      return new Response(JSON.stringify({ error: "unknown failure" }), { status: 500 });
    });
    await assert.rejects(c.submit({ salesQty: 23 }));
    assert.ok(c.state.pendingDispatchPlanAction);
    await assert.rejects(c.submit({ salesQty: 5 }));
    assert.deepEqual(c.sent[1], c.sent[0]);
    assert.equal(c.sent[1].lines[0].quantities.salesQty, 23);
  });
}

test("capacity properties preserve exact partial quantities, both limits, and existing reservations", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 2, max: 50 }), fc.integer({ min: 2, max: 50 }),
    async (sales, purchase) => {
      for (const physical of [false, true]) {
        await withTransaction(async () => {
          const f = await seed({ sales, purchase, physical });
          const quantities = value => ({ salesQty: value, ...(physical ? { pieces: value } : {}) });
          const limit = Math.min(sales, purchase);
          await assert.rejects(createSalesOrderPoAllocations(linkBody(f, quantities(limit + 1))), error =>
            error.status === 400 && error.code === "DISPATCH_PO_LINK_QUANTITY_EXCEEDED");
          assert.equal(await count(f), 0);
          const first = await createSalesOrderPoAllocations(linkBody(f, quantities(limit / 2)));
          assert.equal(first[0].salesQty, limit / 2);
          await assert.rejects(createSalesOrderPoAllocations(linkBody(f, quantities(limit / 2 + 1))), error =>
            error.status === 400 && error.code === "DISPATCH_PO_LINK_QUANTITY_EXCEEDED");
          const second = await createSalesOrderPoAllocations(linkBody(f, quantities(limit / 2)));
          assert.equal(second[0].salesQty, limit / 2);
          const options = await getSalesOrderPoAllocationOptions(f.targetRef);
          assert.equal(options.salesLines[0].available.salesQty, sales - limit);
          assert.equal(options.poLines.find(line => Number(line.id) === Number(f.poLine.id)).available.salesQty, purchase - limit);
        }, { rollback: true });
      }
    }
  ), { seed: 122477, numRuns: 12 });
});
