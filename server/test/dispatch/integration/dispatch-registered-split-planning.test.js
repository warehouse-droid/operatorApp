import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query } from "../../../src/db.js";
import { getDispatchOrderCatalogOrder } from "../../../src/dispatch-order-catalog-repository.js";
import { assertSalesDeliveryPlanningAllowed, listFulfilledSalesDeliveryStates } from "../../../src/dispatch-fulfilled-so-repository.js";
import { scenario, seedSalesOrder, completeDriver, splitSalesOrder } from "../support/fulfilled-so-fixture.js";
import { registerSalesSplit, registerSplitGroup, readSplitGroup, splitGroup } from "../support/registered-split-fixture.js";

after(closeDb);

test("all twenty registered suffixes S1 through S20 resolve and can coexist in a planning group", () => scenario(async () => {
  const parent = "SO-REGISTERED-TWENTY";
  await seedSalesOrder(817162000, parent, { status: "B" });
  const refs = [];
  for (let number = 1; number <= 20; number += 1) {
    refs.push(await registerSalesSplit(parent, { suffix: `S${number}` }));
  }
  const states = await listFulfilledSalesDeliveryStates(refs);
  for (const ref of refs) {
    assert.equal(states.get(ref.toLowerCase())?.blocked, false, ref);
    assert.equal(states.get(ref.toLowerCase())?.locallyCompleted, false, ref);
  }
  assert.equal((await readSplitGroup(refs)).dispatchPlanningRestricted, false);
  await assertSalesDeliveryPlanningAllowed(refs);
}));

test("mixed materialized S1 and registered S2 group hydrates unrestricted without changing operational rows", () => scenario(async () => {
  const parents = ["SO-9222-REGRESSION", "SO-9223-REGRESSION"];
  await seedSalesOrder(817162001, parents[0], { status: "B" });
  await seedSalesOrder(817162002, parents[1], { status: "B" });
  const first = await registerSalesSplit(parents[0], { suffix: "S1" });
  await seedSalesOrder(-817162001, first, { status: "B" });
  await splitSalesOrder(817162001, parents[0], -817162001, first);
  const second = await registerSalesSplit(parents[1]);
  const refs = [first, second];
  const group = splitGroup(refs, "GOA-9222S1-9223S2-REGRESSION");
  await registerSplitGroup(group);
  const rows = async () => {
    const sources = (await query("SELECT row_to_json(s) AS value FROM sales_orders s WHERE tranid=ANY($1) ORDER BY netsuite_id", [[...parents, ...refs]])).rows;
    const lines = (await query("SELECT row_to_json(l) AS value FROM sales_order_lines l WHERE sales_order_id=ANY($1::bigint[]) ORDER BY id", [[817162001, 817162002, -817162001]])).rows;
    const definitions = (await query("SELECT row_to_json(g) AS value FROM dispatch_global_order_groups g WHERE group_ref=$1", [group.id])).rows;
    const drivers = (await query("SELECT row_to_json(j) AS value FROM driver_job_records j ORDER BY job_id")).rows;
    return { sources, lines, definitions, drivers };
  };
  const before = await rows();
  const hydrated = await getDispatchOrderCatalogOrder(group.id);
  assert.equal(hydrated.dispatchPlanningRestricted, false);
  assert.equal(hydrated.dispatchCompletionStatus === "completed", false);
  assert.equal(hydrated.scm.status, "Queued");
  assert.ok(hydrated.childOrderDetails.every(child => !child.dispatchPlanningRestricted));
  await assertSalesDeliveryPlanningAllowed(refs);
  const states = await listFulfilledSalesDeliveryStates(refs);
  assert.equal(states.get(second.toLowerCase())?.blocked, false);
  assert.deepEqual(await rows(), before);
  assert.equal((await query("SELECT count(*)::int AS count FROM sales_orders WHERE tranid=$1", [second])).rows[0].count, 0);
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_plan_order_assignments WHERE order_ref=ANY($1)", [[group.id, ...refs]])).rows[0].count, 0);
}));

test("registered later splits normalize identity and inherit current parent fulfillment", () => scenario(async () => {
  const refs = [];
  for (const [index, status] of ["F", "G", "B"].entries()) {
    const parent = `SO-LATER-FULFILLMENT-${status}`;
    await seedSalesOrder(817162010 + index, parent, { status });
    const ref = await registerSalesSplit(parent, { suffix: `S${index + 2}` });
    refs.push(ref);
    const state = (await listFulfilledSalesDeliveryStates([` ${ref.toLowerCase()} `])).get(ref.toLowerCase());
    assert.equal(state?.blocked, false);
    assert.equal(state?.fulfilled, status !== "B");
    assert.equal(state?.locallyCompleted, false);
  }
  assert.equal((await readSplitGroup(refs.slice(0, 2))).dispatchFulfilledSalesPlanningEligible, true);
  assert.equal((await readSplitGroup(refs)).dispatchPlanningRestricted, false);
}));

test("later split driver dropoff and parent dropoff stay restricted while pickup stays available", () => scenario(async () => {
  for (const [index, [target, stopType]] of [["split", "pickup"], ["split", "dropoff"], ["parent", "dropoff"]].entries()) {
    const parent = `SO-LATER-DRIVER-${index}`;
    await seedSalesOrder(817162020 + index, parent, { status: "B" });
    const ref = await registerSalesSplit(parent, { suffix: "S3" });
    await completeDriver(target === "split" ? ref : parent, { stopType });
    const group = await readSplitGroup([ref]);
    assert.equal(group.dispatchPlanningRestricted, stopType === "dropoff");
    assert.equal(group.dispatchCompletionStatus === "completed", stopType === "dropoff");
    if (stopType === "dropoff") {
      await assert.rejects(assertSalesDeliveryPlanningAllowed([ref]), /completed/i);
    } else {
      await assertSalesDeliveryPlanningAllowed([ref]);
    }
  }
}));

test("manual and direct dependency completion on a registered S2 or its parent remains authoritative", () => scenario(async () => {
  for (const [index, [kind, target]] of [["manual_dispatch", "split"], ["direct_dependency", "split"], ["manual_dispatch", "parent"]].entries()) {
    const parent = `SO-LATER-EVIDENCE-${index}`;
    await seedSalesOrder(817162030 + index, parent, { status: "B" });
    const ref = await registerSalesSplit(parent);
    await query(`INSERT INTO dispatch_order_completion_events
      (order_kind,order_ref,dispatch_completed_at,completion_evidence_type,completion_evidence_id,actor_type,actor_id,reason)
      VALUES ('SO',$1,now(),$2,$1,'operator','test','Delivered registered split')`, [target === "split" ? ref : parent, kind]);
    const group = await readSplitGroup([ref]);
    assert.equal(group.dispatchPlanningRestricted, true);
    assert.equal(group.dispatchCompletionStatus, "completed");
    await assert.rejects(assertSalesDeliveryPlanningAllowed([ref]), { code: "DISPATCH_SALES_DELIVERY_RESTRICTED" });
  }
}));

test("completed sibling S1 leaves the registered S2 delivery and group available", () => scenario(async () => {
  const parent = "SO-LATER-SIBLING";
  await seedSalesOrder(817162040, parent, { status: "B" });
  const first = await registerSalesSplit(parent, { suffix: "S1" });
  const second = await registerSalesSplit(parent);
  await completeDriver(first);
  const group = await readSplitGroup([second]);
  assert.equal(group.dispatchPlanningRestricted, false);
  assert.equal(group.dispatchCompletionStatus === "completed", false);
  await assertSalesDeliveryPlanningAllowed([second]);
}));

test("a materialized S2 uses its own cancelled membership rather than an eligible parent alias", () => scenario(async () => {
  const parent = "SO-LATER-MATERIALIZED";
  await seedSalesOrder(817162050, parent, { status: "F" });
  const ref = await registerSalesSplit(parent);
  await seedSalesOrder(-817162050, ref, { status: "B", active: false });
  await splitSalesOrder(817162050, parent, -817162050, ref, "cancelled");
  const state = (await listFulfilledSalesDeliveryStates([ref])).get(ref.toLowerCase());
  assert.equal(state?.blocked, true);
  assert.equal(state?.eligible, false);
  assert.equal((await readSplitGroup([ref])).dispatchPlanningRestricted, true);
  await assert.rejects(assertSalesDeliveryPlanningAllowed([ref]), { code: "DISPATCH_SALES_DELIVERY_RESTRICTED" });
}));

test("source lifecycle and reconciliation restrictions still apply to registered later aliases", () => scenario(async () => {
  for (const [index, kind] of ["Hold", "Closed", "missing", "review", "reload"].entries()) {
    const parent = `SO-LATER-RESTRICT-${kind}`;
    const id = 817162060 + index;
    await seedSalesOrder(id, parent, { status: kind === "Closed" ? "H" : "B", yard: kind === "Hold" ? "Hold" : "Open" });
    const ref = await registerSalesSplit(parent);
    if (kind === "missing") {await query("UPDATE sales_orders SET netsuite_missing_at=now() WHERE netsuite_id=$1", [id]);}
    if (kind === "review") {
      await query(`INSERT INTO scm_reconciliation_order_state
        (order_kind,source_order_netsuite_id,source_order_ref,reconciliation_status,application_status)
        VALUES ('SO',$1,$2,'review','Reconcile Review')`, [id, parent]);
    }
    if (kind === "reload") {
      await query(`INSERT INTO operator_reload_cycles (sales_order_id,order_ref,cycle_number,request_id,reason)
        VALUES ($1,$2,1,'20261007-0000-4000-8000-000000000001','Test reload')`, [id, parent]);
    }
    const state = (await listFulfilledSalesDeliveryStates([ref])).get(ref.toLowerCase());
    assert.equal(state?.blocked, true, kind);
    assert.equal((await readSplitGroup([ref])).dispatchPlanningRestricted, true, kind);
    await assert.rejects(assertSalesDeliveryPlanningAllowed([ref]), { code: "DISPATCH_SALES_DELIVERY_RESTRICTED" });
  }
}));

test("unregistered inactive derived wrong-type and mismatched identities remain unresolved", () => scenario(async () => {
  for (const [index, kind] of ["unregistered", "inactive", "derived", "wrong-type", "wrong-parent", "missing", "duplicate", "S0", "S02", "S-2", "S2x"].entries()) {
    const parent = `SO-LATER-INVALID-${kind}`;
    if (kind !== "missing") {await seedSalesOrder(817162080 + index, parent, { status: "B" });}
    if (kind === "duplicate") {await seedSalesOrder(817162180 + index, parent, { status: "B" });}
    const ref = `${parent}-${kind.startsWith("S") ? kind : "S2"}`;
    if (kind !== "unregistered") {
      await registerSalesSplit(kind === "wrong-parent" ? `${parent}-DIFFERENT` : parent, {
        ref, active: kind !== "inactive", kind: kind === "derived" ? "derived" : "split", type: kind === "wrong-type" ? "PO" : "SO"
      });
    }
    const states = await listFulfilledSalesDeliveryStates([ref]);
    assert.equal(states.has(ref.toLowerCase()), false, kind);
    assert.equal((await readSplitGroup([ref])).dispatchPlanningRestricted, true, kind);
  }
}));

test("an existing but different registered parent cannot supply the split's planning status", () => scenario(async () => {
  const parent = "SO-LATER-LITERAL-PARENT";
  const different = `${parent}-DIFFERENT`;
  await seedSalesOrder(817162200, parent, { status: "B" });
  await seedSalesOrder(817162201, different, { status: "B" });
  const ref = await registerSalesSplit(different, { ref: `${parent}-S2` });
  const states = await listFulfilledSalesDeliveryStates([ref]);
  assert.equal(states.has(ref.toLowerCase()), false);
  assert.equal((await readSplitGroup([ref])).dispatchPlanningRestricted, true);
}));
