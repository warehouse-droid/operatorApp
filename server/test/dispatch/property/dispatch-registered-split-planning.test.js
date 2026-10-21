import assert from "node:assert/strict";
import test, { after } from "node:test";
import fc from "fast-check";
import { closeDb, query } from "../../../src/db.js";
import { listFulfilledSalesDeliveryStates } from "../../../src/dispatch-fulfilled-so-repository.js";
import { scenario, seedSalesOrder, splitSalesOrder } from "../support/fulfilled-so-fixture.js";
import { readSplitGroup, registerSalesSplit } from "../support/registered-split-fixture.js";

after(closeDb);
const options = { numRuns: 50, seed: 92229223 };
const identity = fc.tuple(fc.integer({ min: 2, max: 10000 }), fc.constantFrom("PLAIN", "A.B", "A+B", "A[B]", "A(B)", "A$B", "A-S1"));

test("property: every positive later split number resolves its literal registered parent and normalized reference", async () => {
  await fc.assert(fc.asyncProperty(identity, ([number, name]) => scenario(async () => {
    const parent = `SO-PROP-${name}`;
    await seedSalesOrder(817162900, parent, { status: "B" });
    const ref = await registerSalesSplit(parent, { suffix: `S${number}` });
    const state = (await listFulfilledSalesDeliveryStates([` ${ref.toLowerCase()} `])).get(ref.toLowerCase());
    assert.equal(state?.blocked, false);
    assert.equal(state?.locallyCompleted, false);
    assert.equal((await readSplitGroup([ref])).dispatchPlanningRestricted, false);
  })), options);
});

test("property: registration lifecycle and exact parent association control alias availability", async () => {
  await fc.assert(fc.asyncProperty(identity, fc.constantFrom("active", "inactive", "derived", "mismatched"), ([number, name], mode) => scenario(async () => {
    const parent = `SO-PROP-REG-${name}`;
    await seedSalesOrder(817162901, parent, { status: "B" });
    const ref = `${parent}-S${number}`;
    const wrongParent = `${parent}-OTHER`;
    if (mode === "mismatched") {await seedSalesOrder(817162902, wrongParent, { status: "B" });}
    await registerSalesSplit(mode === "mismatched" ? wrongParent : parent, {
      ref, active: mode !== "inactive", kind: mode === "derived" ? "derived" : "split"
    });
    const states = await listFulfilledSalesDeliveryStates([ref]);
    assert.equal(states.has(ref.toLowerCase()), mode === "active");
    assert.equal((await readSplitGroup([ref])).dispatchPlanningRestricted, mode !== "active");
  })), options);
});

test("property: alias completion and materialized cancellation cannot be overridden by an open parent", async () => {
  await fc.assert(fc.asyncProperty(identity, fc.constantFrom("pending", "completed", "materialized"), ([number, name], mode) => scenario(async () => {
    const parent = `SO-PROP-GUARD-${name}`;
    await seedSalesOrder(817162903, parent, { status: "B" });
    const ref = await registerSalesSplit(parent, { suffix: `S${number}` });
    if (mode === "completed") {
      await query(`INSERT INTO dispatch_order_completion_events
        (order_kind,order_ref,dispatch_completed_at,completion_evidence_type,completion_evidence_id,actor_type,actor_id,reason)
        VALUES ('SO',$1,now(),'manual_dispatch',$1,'operator','test','Delivered split')`, [ref]);
    }
    if (mode === "materialized") {
      await seedSalesOrder(-817162903, ref, { status: "B", active: false, yard: "Cancelled" });
      await splitSalesOrder(817162903, parent, -817162903, ref, "cancelled");
    }
    const state = (await listFulfilledSalesDeliveryStates([ref])).get(ref.toLowerCase());
    assert.equal(state?.locallyCompleted, mode === "completed");
    assert.equal(state?.blocked, mode === "materialized");
    assert.equal((await readSplitGroup([ref])).dispatchPlanningRestricted, mode !== "pending");
  })), options);
});
