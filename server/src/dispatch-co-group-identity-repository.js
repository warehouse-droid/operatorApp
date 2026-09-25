import { deferDispatchPlanMaintenance, enqueueDispatchPlanMaintenance } from "./dispatch-plan-maintenance-queue.js";
import { notifyDispatchPlanMaintenance } from "./dispatch-plan-maintenance.js";
import { query, withTransaction } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import {
  canonicalizeDispatchCoGroupIdentities,
  dispatchCoGroupIdentityMappings
} from "./dispatch-co-group-identity.js";
import { syncDispatchDeliveryGroupsFromPlan } from "./dispatch-delivery-group-repository.js";
import { evaluateDispatchExecutedPrefixPreservation } from "./dispatch-executed-prefix-repository.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import {
  syncDispatchPlanOrderAssignments,
  syncDispatchPlanRelationEdges
} from "./dispatch-planner-v2-repository.js";
import {
  buildCompactDispatchSnapshot,
  digestDispatchPlan,
  dispatchPlanBoard
} from "./dispatch-planner-performance.js";

function text(value) {
  return String(value ?? "").trim();
}

export async function repairDispatchCoGroupIdentities({ planIds = [], limit = 5000 } = {}) {
  const selectedPlanIds = [...new Set((planIds || []).map(text).filter((value) => /^\d+$/u.test(value)))];
  const safeLimit = Math.min(Math.max(Number(limit) || 5000, 1), 20_000);
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const candidates = await query(
      `SELECT p.id::text, p.plan_date::text AS plan_date, p.status, p.note, p.revision,
              p.created_at, p.updated_at, s.saved_at, s.orders, s.trucks, s.summary,
              s.schema_version
         FROM dispatch_plans p
         JOIN dispatch_plan_snapshots s ON s.plan_id = p.id
        WHERE (cardinality($1::bigint[]) = 0 OR p.id = ANY($1::bigint[]))
        ORDER BY p.plan_date, p.id
        LIMIT $2`,
      [selectedPlanIds, safeLimit]
    );
    const repairedPlanIds = [];
    const deferredPlanIds = [];
    const repairedMappings = [];
    for (const row of candidates.rows) {
      const current = {
        id: text(row.id),
        planId: text(row.id),
        planDate: text(row.plan_date).slice(0, 10),
        status: row.status || "draft",
        note: row.note || "",
        revision: Number(row.revision || 0),
        savedAt: row.saved_at || row.updated_at || null,
        orders: Array.isArray(row.orders) ? row.orders : [],
        trucks: Array.isArray(row.trucks) ? row.trucks : [],
        summary: row.summary && typeof row.summary === "object" ? row.summary : {}
      };
      const mappings = dispatchCoGroupIdentityMappings(current);
      if (!mappings.length) continue;
      if (await deferDispatchPlanMaintenance(current, { kind: "co_identity" })) {
        deferredPlanIds.push(text(row.id));
        continue;
      }
      await query("SELECT id FROM dispatch_plans WHERE id=$1 FOR UPDATE", [row.id]);
      const canonical = buildCompactDispatchSnapshot(canonicalizeDispatchCoGroupIdentities(current));
      const executionPolicy = await evaluateDispatchExecutedPrefixPreservation({
        previousPlan: current,
        nextPlan: canonical
      });
      if (!executionPolicy.allowed) {
        await enqueueDispatchPlanMaintenance(row.id, { kind: "co_identity" });
        deferredPlanIds.push(text(row.id));
        continue;
      }
      canonical.revision = Number((await query("UPDATE dispatch_plans SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision", [row.id])).rows[0].revision);
      const board = dispatchPlanBoard(canonical);
      await query(
        `UPDATE dispatch_plan_snapshots
            SET orders = $2::jsonb,
                trucks = $3::jsonb,
                summary = $4::jsonb,
                plan_digest = $5,
                order_count = $6,
                truck_count = $7,
                load_count = $8,
                stop_count = $9,
                saved_at = now()
          WHERE plan_id = $1`,
        [
          row.id,
          JSON.stringify(canonical.orders || []),
          JSON.stringify(canonical.trucks || []),
          JSON.stringify(canonical.summary || {}),
          digestDispatchPlan(canonical),
          (canonical.orders || []).length,
          board.truckCount,
          board.loadCount,
          board.stopCount
        ]
      );
      await syncDispatchPlanOrderAssignments(canonical);
      await syncDispatchPlanRelationEdges(canonical);
      await syncDispatchDeliveryGroupsFromPlan(canonical);
      for (const mapping of mappings) {
        await writeDispatchAudit({
          action: "dispatch_co_group_identity_repaired",
          entityType: "dispatch_order",
          entityId: mapping.newRef,
          orderId: mapping.newRef,
          planId: row.id,
          planDate: current.planDate,
          source: "dispatch-co-group-identity-startup-repair",
          before: { orderRef: mapping.oldRef },
          after: { orderRef: mapping.newRef },
          details: {
            reason: "canonicalize_grouped_internal_co_identity",
            previousRevision: current.revision,
            revision: canonical.revision
          }
        });
        repairedMappings.push({
          planId: text(row.id),
          oldRef: mapping.oldRef,
          newRef: mapping.newRef
        });
      }
      notifyDispatchPlanMaintenance(canonical, mappings.flatMap(mapping => [mapping.oldRef, mapping.newRef]));
      repairedPlanIds.push(text(row.id));
    }
    return {
      scanned: candidates.rowCount,
      repaired: repairedPlanIds.length,
      planIds: repairedPlanIds,
      deferredPlanIds,
      mappings: repairedMappings
    };
  });
}
