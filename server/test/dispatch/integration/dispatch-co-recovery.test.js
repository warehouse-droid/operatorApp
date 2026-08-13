// @ts-check

import assert from "node:assert/strict";
import test from "node:test";

import { beginRollbackContext, query } from "../../../src/db.js";
import { recoverOriginalGoaCo } from "../../../src/dispatch-co-recovery.js";

const CO_REF = "CO-GOA-3464-3470-6922";

async function seedRecoveryFixture() {
  await query(
    `INSERT INTO dispatch_plans (id, plan_date, status, revision, confirmed_at)
     VALUES (48, '2026-07-14', 'confirmed', 326, '2026-07-14T12:00:00Z')`
  );
  await query(
    `INSERT INTO dispatch_plan_snapshots (plan_id, orders, trucks, summary)
     VALUES (48, $1::jsonb, $2::jsonb, '{}'::jsonb)`,
    [
      JSON.stringify([{
        id: CO_REF,
        type: "CO",
        sourceYard: "2967",
        destinationYard: "150",
        address: "150 Clark Blvd, Brampton, ON L6T 4Y8, Canada",
        pickupLocations: ["2967"]
      }]),
      JSON.stringify([{
        id: "T2",
        plate: "BC71838",
        loads: [{
          id: "T2-L-ORIGINAL",
          name: "Load 2",
          stops: [
            { id: "original-pick", type: "pick", orderId: CO_REF, location: "2967" },
            { id: "original-drop", type: "drop", orderId: CO_REF, location: "2967" }
          ]
        }]
      }])
    ]
  );
  await query(
    `INSERT INTO local_co_orders (
       id, co_ref, source_order_ref, from_location_id, from_location,
       to_location_id, to_location, status, dispatch_plan_id, dispatch_plan_date,
       dispatch_truck_plate, dispatch_load_name, delivery_order_id, details
     ) VALUES (
       102, $1, 'GOA-3464-3470-6922', 28, '2967',
       15, '12441', 'cancelled', 48, '2026-07-14',
       'BC71838', 'Load 2', -102, $2::jsonb
     )`,
    [CO_REF, JSON.stringify({
      customer: "3 orders grouped",
      cancelledAt: "2026-08-13T12:30:15.800Z",
      cancelledBy: "regression-session",
      childOrderDetails: [{
        id: "SOA03464",
        sourceYard: "12441",
        pickupLocations: ["12441"],
        transitCo: { id: CO_REF, fromYard: "2967", toYard: "12441", sourceOrderId: "SOA03464" }
      }]
    })]
  );
  await query(
    `INSERT INTO local_co_order_lines (
       id, co_id, line_id, item_id, item_name, sku, quantity, unit, raw
     ) VALUES
       (327, 102, 4438672, 2055, 'MBBS-Special Order', 'MBBS-Special Order', 72, 'PC', '{"fixture":1}'::jsonb),
       (328, 102, 4438982, 1784, 'PALLET', 'PALLET', 35, 'EACH', '{"fixture":2}'::jsonb)`
  );
}

async function jsonRow(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0]?.value;
}

test("original GOA CO recovery is dry-run safe, exact, audited, and idempotent", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await seedRecoveryFixture();
      const beforeCo = await jsonRow("SELECT to_jsonb(co) AS value FROM local_co_orders co WHERE id = 102");
      const beforeLines = await jsonRow(
        "SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id) AS value FROM local_co_order_lines line WHERE co_id = 102"
      );
      const beforePlan = await jsonRow(
        `SELECT jsonb_build_object(
           'plan', to_jsonb(p), 'snapshot', to_jsonb(s)
         ) AS value
           FROM dispatch_plans p
           JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
          WHERE p.id = 48`
      );

      const dryRun = await recoverOriginalGoaCo({
        apply: false,
        requestedBy: "co-recovery-test",
        now: () => new Date("2026-08-13T15:00:00.000Z")
      });
      assert.equal(dryRun.mode, "dry-run");
      assert.equal(dryRun.applied, false);
      assert.equal(dryRun.alreadyRecovered, false);
      assert.equal(dryRun.before.toYard, "12441");
      assert.equal(dryRun.after.toYard, "150");
      assert.deepEqual(
        await jsonRow("SELECT to_jsonb(co) AS value FROM local_co_orders co WHERE id = 102"),
        beforeCo
      );
      assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_audit_log WHERE order_id = $1", [CO_REF])).rows[0].count, 0);

      const applied = await recoverOriginalGoaCo({
        apply: true,
        requestedBy: "co-recovery-test",
        now: () => new Date("2026-08-13T15:00:00.000Z")
      });
      assert.equal(applied.applied, true);
      assert.equal(applied.after.status, "pending_load");
      assert.equal(applied.after.fromYard, "2967");
      assert.equal(applied.after.toYard, "150");
      const recovered = await jsonRow("SELECT to_jsonb(co) AS value FROM local_co_orders co WHERE id = 102");
      assert.equal(recovered.status, "pending_load");
      assert.equal(recovered.from_location_id, 28);
      assert.equal(recovered.to_location_id, 26);
      assert.equal(recovered.to_location, "150");
      assert.equal(recovered.dispatch_plan_id, 48);
      assert.equal(recovered.dispatch_plan_date, "2026-07-14");
      assert.equal(recovered.dispatch_truck_plate, "BC71838");
      assert.equal(recovered.dispatch_load_name, "Load 2");
      assert.equal(recovered.details.cancelledAt, undefined);
      assert.equal(recovered.details.cancelledBy, undefined);
      assert.equal(recovered.details.dispatchCoRecovery.version, 1);
      assert.equal(recovered.details.childOrderDetails[0].transitCo.toYard, "150");
      assert.equal(recovered.details.childOrderDetails[0].sourceYard, "150");
      assert.deepEqual(recovered.details.childOrderDetails[0].pickupLocations, ["150"]);
      assert.deepEqual(
        await jsonRow("SELECT jsonb_agg(to_jsonb(line) ORDER BY line.id) AS value FROM local_co_order_lines line WHERE co_id = 102"),
        beforeLines
      );
      assert.deepEqual(
        await jsonRow(
          `SELECT jsonb_build_object(
             'plan', to_jsonb(p), 'snapshot', to_jsonb(s)
           ) AS value
             FROM dispatch_plans p
             JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
            WHERE p.id = 48`
        ),
        beforePlan
      );
      const audit = await query(
        `SELECT action, plan_id, plan_date::text AS plan_date, details
           FROM dispatch_audit_log
          WHERE order_id = $1`,
        [CO_REF]
      );
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].action, "co_recovered_from_confirmed_plan");
      assert.equal(String(audit.rows[0].plan_id), "48");
      assert.equal(audit.rows[0].plan_date, "2026-07-14");
      assert.equal(audit.rows[0].details.lineCount, 2);

      const beforeRepeat = await jsonRow("SELECT to_jsonb(co) AS value FROM local_co_orders co WHERE id = 102");
      const repeated = await recoverOriginalGoaCo({ apply: true, requestedBy: "co-recovery-test-repeat" });
      assert.equal(repeated.applied, false);
      assert.equal(repeated.alreadyRecovered, true);
      assert.deepEqual(
        await jsonRow("SELECT to_jsonb(co) AS value FROM local_co_orders co WHERE id = 102"),
        beforeRepeat
      );
      assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_audit_log WHERE order_id = $1", [CO_REF])).rows[0].count, 1);

      await query("UPDATE dispatch_plans SET revision = 325 WHERE id = 48");
      await assert.rejects(
        recoverOriginalGoaCo({ apply: true, requestedBy: "co-recovery-invalid-source" }),
        (error) => error?.code === "DISPATCH_CO_RECOVERY_PREDICATE_FAILED"
      );
      assert.deepEqual(
        await jsonRow("SELECT to_jsonb(co) AS value FROM local_co_orders co WHERE id = 102"),
        beforeRepeat
      );
      assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_audit_log WHERE order_id = $1", [CO_REF])).rows[0].count, 1);
    });
  } finally {
    await rollback.rollback();
  }
});
