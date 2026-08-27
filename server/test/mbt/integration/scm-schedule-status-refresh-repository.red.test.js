import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { listStaleScmScheduleStatusCandidates } from "../../../src/scm-schedule-status-refresh-repository.js";

after(closeDb);

test("SAS-RI1: candidate discovery excludes fresh, completed, and recently attempted schedules", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
      const base = 9_996_000_000 + Math.floor(Math.random() * 100_000);
      const refs = {
        stale: `PO-SAS-STALE-${suffix}`,
        fresh: `PO-SAS-FRESH-${suffix}`,
        stateProjected: `PO-SAS-STATE-PARTIAL-${suffix}`,
        completed: `TO-SAS-COMPLETE-${suffix}`,
        recent: `TO-SAS-RECENT-${suffix}`
      };
      for (const [index, [name, ref]] of Object.entries(refs).entries()) {
        const kind = ["stale", "fresh", "stateProjected"].includes(name) ? "PO" : "TO";
        const state = await query(
          `INSERT INTO scm_reconciliation_order_state (
             order_kind, source_order_netsuite_id, source_order_ref,
             application_status, reconciliation_status, reconciliation_source,
             reconciled_at
           ) VALUES (
             $1, $2, $3,
             CASE WHEN $4 = 'stateProjected' THEN 'Partially Done' ELSE 'Queued' END,
             'ok', 'backfill',
             CASE WHEN $4 = 'fresh' THEN $5::timestamptz - interval '1 hour'
                  ELSE $5::timestamptz - interval '2 days' END
           ) RETURNING id`,
          [kind, base + index, ref, name, "2026-08-27T12:00:00.000Z"]
        );
        await query(
           `INSERT INTO scm_transport_schedule (
             order_kind, order_ref, method, status,
             reconciliation_order_state_id, created_by, updated_by, created_at, updated_at
           ) VALUES (
             $1, $2, 'MBT', $3, $4, 'sas-test', 'sas-test',
             $5::timestamptz - interval '3 days', $5::timestamptz - interval '3 days'
           )`,
          [kind, ref, index % 2 === 0 ? "Queued" : "Planned", state.rows[0].id, "2026-08-27T12:00:00.000Z"]
        );
      }
      await query(
        `SELECT dispatch_record_order_completion(
           'TO', $1, $2::timestamptz - interval '1 day', 'manual_dispatch',
           $3, NULL, NULL, NULL, 'operator', 'sas-admin',
           'Verified completed fixture', '{}'::jsonb
         )`,
        [refs.completed, "2026-08-27T12:00:00.000Z", `sas-complete-${suffix}`]
      );
      await query(
        `INSERT INTO scm_reconciliation_runs (
           run_key, trigger_source, scope_kind, target_order_kind,
           target_order_ref, dry_run, apply_unambiguous, status,
           requested_by, created_at
         ) VALUES (
           $1, 'backfill', 'order_family', 'TO', $2,
           false, true, 'succeeded', 'sas-test', $3::timestamptz - interval '10 minutes'
         )`,
        [`sas-recent-${suffix}`, refs.recent, "2026-08-27T12:00:00.000Z"]
      );

      const candidates = await listStaleScmScheduleStatusCandidates({
        now: new Date("2026-08-27T12:00:00.000Z"),
        staleAfterMs: 6 * 60 * 60 * 1000,
        recentAttemptMs: 60 * 60 * 1000,
        limit: 30
      });
      assert.deepEqual(candidates, [{ orderKind: "PO", orderRef: refs.stale }]);
    });
  } finally {
    await rollback.rollback();
  }
});

test("SAS-RI2: candidate discovery canonicalizes split/group aliases and skips local-only rows", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const suffix = crypto.randomUUID().replaceAll("-", "").toUpperCase();
      const sourceId = 9_997_000_000 + Math.floor(Math.random() * 100_000);
      const groupedSourceId = sourceId + 1;
      const localOnlyId = -(sourceId + 2);
      const sourceRef = `PO-SAS-SOURCE-${suffix}`;
      const groupedSourceRef = `PO-SAS-GROUP-MEMBER-${suffix}`;
      const splitRef = `PO-SAS-SPLIT-${suffix}`;
      const aliasRef = `PO-SAS-ALIAS-${suffix}`;
      const groupRef = `PGO-SAS-${suffix}`;
      const localOnlyRef = `PO-SAS-LOCAL-${suffix}`;

      await query(
        `INSERT INTO purchase_orders (
           netsuite_id, tranid, dispatch_ref, status, status_text, netsuite_active, synced_at
         ) VALUES
           ($1, $2, $3, 'B', 'Purchase Order : Pending Receipt', true, $7),
           ($4, $5, NULL, 'B', 'Purchase Order : Pending Receipt', true, $7),
           ($6, $8, $8, 'B', 'Purchase Order : Pending Receipt (local)', true, $7)`,
        [
          sourceId,
          sourceRef,
          aliasRef,
          groupedSourceId,
          groupedSourceRef,
          localOnlyId,
          "2026-08-24T12:00:00.000Z",
          localOnlyRef
        ]
      );
      await query(
        `INSERT INTO dispatch_scm_po_splits (
           source_po_id, source_po_ref, split_po_ref, status, created_by, created_at
         ) VALUES ($1, $2, $3, 'active', 'sas-test', $4)`,
        [sourceId, sourceRef, splitRef, "2026-08-24T12:00:00.000Z"]
      );
      const group = await query(
        `INSERT INTO scm_schedule_groups (group_ref, status, created_by, created_at)
         VALUES ($1, 'active', 'sas-test', $2)
         RETURNING id`,
        [groupRef, "2026-08-24T12:00:00.000Z"]
      );
      await query(
        `INSERT INTO scm_schedule_group_members (group_id, order_kind, order_ref)
         VALUES ($1, 'PO', $2)`,
        [group.rows[0].id, groupedSourceRef]
      );
      for (const ref of [splitRef, aliasRef, groupRef, localOnlyRef]) {
        await query(
          `INSERT INTO scm_transport_schedule (
             order_kind, order_ref, method, status, created_by, updated_by, created_at, updated_at
           ) VALUES ('PO', $1, 'MBT', 'Queued', 'sas-test', 'sas-test', $2, $2)`,
          [ref, "2026-08-24T12:00:00.000Z"]
        );
      }

      const candidates = await listStaleScmScheduleStatusCandidates({
        now: new Date("2026-08-27T12:00:00.000Z"),
        staleAfterMs: 6 * 60 * 60 * 1000,
        recentAttemptMs: 60 * 60 * 1000,
        limit: 30
      });
      assert.deepEqual(
        candidates
          .map((candidate) => `${candidate.orderKind}:${candidate.orderRef}`)
          .sort(),
        [`PO:${groupedSourceRef}`, `PO:${sourceRef}`].sort()
      );
    });
  } finally {
    await rollback.rollback();
  }
});
