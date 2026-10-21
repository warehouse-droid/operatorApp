// Run inside the live app; PostgreSQL enforces a read-only, rolled-back probe.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.equal(process.env.FIRST_SPLIT_READ_ONLY, "1");
const runtime = name => import(pathToFileURL(resolve("src", name)).href);
const { query, withTransaction, closeDb } = await runtime("db.js");
const { getDispatchOrderCatalogOrder } = await runtime("dispatch-order-catalog-repository.js");
const { listFulfilledSalesDeliveryStates } = await runtime("dispatch-fulfilled-so-repository.js");
const { loadDispatchOrdersForResponse } = await runtime("server.js");

try {
  const result = await withTransaction(async () => {
    await query("SET TRANSACTION READ ONLY");
    await query("SET LOCAL statement_timeout='25s'");
    const ref = "GOA-9140S1-9143S1";
    const group = await getDispatchOrderCatalogOrder(ref);
    assert.ok(group);
    assert.equal(group.dispatchPlanningRestricted, false);
    assert.equal(group.dispatchCompletionStatus === "completed", false);
    assert.equal(group.scm?.status, "Queued");
    const states = await listFulfilledSalesDeliveryStates(group.childOrders);
    for (const member of group.childOrders) {
      const state = states.get(member.toLowerCase());
      assert.ok(state, member);
      assert.equal(state.fulfilled, false, member);
      assert.equal(state.locallyCompleted, false, member);
      assert.equal(state.blocked, false, member);
    }
    const feed = await loadDispatchOrdersForResponse({ type: "SO", search: ref, includeCompletedScmSearch: true });
    const order = feed.find(candidate => candidate.id === ref);
    assert.ok(order, "The actual order feed includes the group");
    assert.equal(order.dispatchPlanningRestricted, false);
    assert.equal(order.dispatchCompletionStatus === "completed", false);
    const assignments = await query("SELECT count(*)::int AS count FROM dispatch_plan_order_assignments WHERE order_ref=ANY($1)", [[ref, ...group.childOrders]]);
    return { passed: true, readOnly: true, order: ref, members: group.childOrders,
      status: group.scm.status, planningRestricted: group.dispatchPlanningRestricted,
      completed: group.dispatchCompletionStatus === "completed", plannedAssignments: assignments.rows[0].count,
      membersRecognised: group.childOrders.length, orderFeedVerified: true };
  }, { rollback: true });
  console.log(JSON.stringify(result));
} finally {
  await closeDb();
}
