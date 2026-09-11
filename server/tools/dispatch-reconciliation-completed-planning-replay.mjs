import assert from "node:assert/strict";

import { closeDb, query } from "../src/db.js";
import {
  assertNoRestrictedScmDispatchOrders,
  loadDispatchOrdersForResponse
} from "../src/server.js";

const orderRef = String(process.argv[2] || "SN1399744").trim();
assert(orderRef, "Provide a Dispatch order reference.");

try {
  const rows = await loadDispatchOrdersForResponse({
    search: orderRef,
    exactOrderRefs: [orderRef],
    includeCompletedScmSearch: true
  });
  const order = rows.find((candidate) =>
    String(candidate?.id || "").trim().toLowerCase() === orderRef.toLowerCase());
  assert(order, `${orderRef} was not returned by explicit Dispatch search.`);

  const evidence = await query(
    `WITH matching_state AS (
       SELECT state.source_order_ref,
              target.target_state
         FROM scm_reconciliation_order_state state
         CROSS JOIN LATERAL JSONB_EACH(
           CASE
             WHEN JSONB_TYPEOF(state.quantity_summary->'targets') = 'object'
               THEN state.quantity_summary->'targets'
             ELSE '{}'::jsonb
           END
         ) target(target_ref, target_state)
        WHERE state.order_kind IN ('PO', 'TO')
          AND LOWER(BTRIM(target.target_ref)) = LOWER(BTRIM($1))
        ORDER BY state.reconciled_at DESC NULLS LAST, state.id DESC
        LIMIT 1
     )
     SELECT state.source_order_ref,
            state.target_state->>'applicationStatus' AS reconciliation_application_status,
            state.target_state->>'operationallyCompleted' AS operationally_completed,
            schedule.status AS operational_schedule_status,
            completion.completion_evidence_type,
            EXISTS (
              SELECT 1
                FROM driver_job_records record
                CROSS JOIN LATERAL JSONB_ARRAY_ELEMENTS_TEXT(
                  CASE WHEN JSONB_TYPEOF(record.order_refs) = 'array'
                    THEN record.order_refs ELSE '[]'::jsonb END
                ) ref(value)
               WHERE LOWER(BTRIM(ref.value)) = LOWER(BTRIM($1))
                 AND LOWER(BTRIM(record.status)) IN ('complete', 'completed')
                 AND LOWER(BTRIM(record.stop_type)) = 'dropoff'
            ) AS driver_completed
       FROM matching_state state
       LEFT JOIN scm_transport_schedule schedule
         ON schedule.order_kind IN ('PO', 'TO')
        AND LOWER(BTRIM(schedule.order_ref)) = LOWER(BTRIM($1))
       LEFT JOIN dispatch_order_completion_status completion
         ON LOWER(BTRIM(completion.order_ref)) IN (
           LOWER(BTRIM($1)), LOWER(BTRIM(state.source_order_ref))
         )
      ORDER BY CASE WHEN LOWER(BTRIM(completion.order_ref)) = LOWER(BTRIM($1)) THEN 0 ELSE 1 END
      LIMIT 1`,
    [orderRef]
  );
  const proof = evidence.rows[0] || {};
  assert.equal(String(proof.reconciliation_application_status || "").toLowerCase(), "completed");
  assert.notEqual(String(proof.operationally_completed || "").toLowerCase(), "true");
  assert.equal(proof.driver_completed, false);
  assert.equal(order.dispatchReconciliationPlanningEligible, true);
  assert.notEqual(order.dispatchPlanningRestricted, true);
  assert.notEqual(order.dispatchCompletionStatus, "completed");
  await assert.doesNotReject(() => assertNoRestrictedScmDispatchOrders(
    [orderRef],
    "be added to a Dispatch plan"
  ));

  console.log(JSON.stringify({
    orderRef,
    sourceOrderRef: proof.source_order_ref || "",
    operationalScheduleStatus: proof.operational_schedule_status || "",
    reconciliationApplicationStatus: proof.reconciliation_application_status || "",
    reconciliationEvidenceType: proof.completion_evidence_type || "",
    driverCompleted: proof.driver_completed,
    dispatchReconciliationPlanningEligible: order.dispatchReconciliationPlanningEligible,
    dispatchPlanningRestricted: order.dispatchPlanningRestricted === true,
    dispatchCompletionStatus: order.dispatchCompletionStatus || "",
    planningGuardAllowed: true
  }, null, 2));
} finally {
  await closeDb();
}
