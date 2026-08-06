// @ts-check

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { query } from "../../../src/db.js";
import {
  advanceDispatchV2Followup,
  completeDispatchV2Followup,
  failDispatchV2Followup,
  pendingDispatchV2Followups,
  pruneExpiredDispatchV2Checkpoints
} from "../../../src/dispatch-planner-v2-repository.js";
import { createDispatchV2Fixture } from "../support/dispatch-v2-fixture.js";

let fixture;

before(async () => {
  fixture = await createDispatchV2Fixture();
});

after(async () => {
  await fixture?.close();
});

test("DP-14: retention prunes only expired checkpoint documents and preserves active command state", async () => {
  const seeded = await fixture.seedPlan({ date: "2025-03-01", refs: ["DP-RETENTION-A"] });
  const commandId = `dp-retention-${crypto.randomUUID()}`;
  const inserted = await query(
    `INSERT INTO dispatch_plan_snapshot_history (
       plan_id, plan_date, revision, orders, trucks, summary, archived_at, archive_reason, session_id
     ) VALUES
       ($1, $2::date, 1, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now() - interval '9 days', 'test-expired-oldest', 'dp14'),
       ($1, $2::date, 2, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now() - interval '8 days', 'test-expired-next', 'dp14'),
       ($1, $2::date, 3, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, now() - interval '6 days', 'test-current', 'dp14')
     RETURNING id::text, archive_reason`,
    [seeded.id, seeded.plan_date]
  );
  const oldestExpiredId = inserted.rows.find((row) => row.archive_reason === "test-expired-oldest").id;
  const nextExpiredId = inserted.rows.find((row) => row.archive_reason === "test-expired-next").id;
  const currentId = inserted.rows.find((row) => row.archive_reason === "test-current").id;
  await query(
    `INSERT INTO dispatch_plan_commands (
       command_id, plan_id, plan_date, command_type, request_hash,
       base_revision, applied_revision, session_id, actor_id, result
     ) VALUES ($1, $2, $3::date, 'remove_order', $4, 0, 1, 'dp14', 'test-actor', '{}'::jsonb)`,
    [commandId, seeded.id, seeded.plan_date, crypto.randomUUID()]
  );
  await query(
    `INSERT INTO dispatch_plan_followup_outbox (command_id, plan_id, command_type)
     VALUES ($1, $2, 'remove_order')`,
    [commandId, seeded.id]
  );

  const firstBatch = await pruneExpiredDispatchV2Checkpoints({ retentionDays: 7, batchSize: 1 });
  assert.equal(firstBatch.deleted, 1, "Retention must prune in bounded batches.");
  assert.deepEqual(firstBatch.checkpointIds, [oldestExpiredId]);
  const result = await pruneExpiredDispatchV2Checkpoints({ retentionDays: 7, batchSize: 25 });
  assert.deepEqual(result.checkpointIds, [nextExpiredId]);
  assert.ok(!result.checkpointIds.includes(currentId));
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_plans WHERE id = $1", [seeded.id])).rows[0].count, 1);
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_plan_snapshots WHERE plan_id = $1", [seeded.id])).rows[0].count, 1);
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_plan_commands WHERE command_id = $1", [commandId])).rows[0].count, 1);
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_plan_followup_outbox WHERE command_id = $1", [commandId])).rows[0].count, 1);
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_plan_snapshot_history WHERE id = ANY($1::bigint[])", [[oldestExpiredId, nextExpiredId]])).rows[0].count, 0);
  assert.equal((await query("SELECT count(*)::int AS count FROM dispatch_plan_snapshot_history WHERE id = $1", [currentId])).rows[0].count, 1);
});

test("DP-16: concurrent workers atomically claim an outbox row once and retry it durably", async () => {
  const seeded = await fixture.seedPlan({ date: "2025-03-02", refs: ["DP-OUTBOX-A"] });
  const commandId = `dp-outbox-${crypto.randomUUID()}`;
  await query(
    `INSERT INTO dispatch_plan_commands (
       command_id, plan_id, plan_date, command_type, request_hash,
       base_revision, applied_revision, session_id, actor_id, result
     ) VALUES ($1, $2, $3::date, 'assign_order', $4, 0, 1, 'dp16', 'test-actor', '{}'::jsonb)`,
    [commandId, seeded.id, seeded.plan_date, crypto.randomUUID()]
  );
  const outbox = await query(
    `INSERT INTO dispatch_plan_followup_outbox (command_id, plan_id, command_type)
     VALUES ($1, $2, 'assign_order')
     RETURNING id::text`,
    [commandId, seeded.id]
  );
  const outboxId = outbox.rows[0].id;

  const [left, right] = await Promise.all([
    pendingDispatchV2Followups({ limit: 25 }),
    pendingDispatchV2Followups({ limit: 25 })
  ]);
  const claimed = [...left, ...right].filter((row) => String(row.command_id) === commandId);
  assert.equal(claimed.length, 1, "Two workers must never receive the same outbox row.");
  assert.equal(
    (await query("SELECT status FROM dispatch_plan_followup_outbox WHERE id = $1", [outboxId])).rows[0].status,
    "running"
  );

  await advanceDispatchV2Followup(outboxId, "order_dependencies");

  await failDispatchV2Followup(outboxId, new Error("retryable test failure"));
  let state = (await query(
    "SELECT status, attempts, last_error FROM dispatch_plan_followup_outbox WHERE id = $1",
    [outboxId]
  )).rows[0];
  assert.equal(state.status, "failed");
  assert.equal(state.attempts, 1);
  assert.match(state.last_error, /retryable test failure/);

  await query("UPDATE dispatch_plan_followup_outbox SET available_at = now() WHERE id = $1", [outboxId]);
  const retry = await pendingDispatchV2Followups({ limit: 1 });
  const retried = retry.find((row) => String(row.command_id) === commandId);
  assert.ok(retried);
  assert.ok(retried.progress?.order_dependencies?.completedAt, "A retry must resume after its durable completed stage.");
  await completeDispatchV2Followup(outboxId);
  state = (await query(
    "SELECT status, attempts, completed_at FROM dispatch_plan_followup_outbox WHERE id = $1",
    [outboxId]
  )).rows[0];
  assert.equal(state.status, "complete");
  assert.equal(state.attempts, 1);
  assert.ok(state.completed_at);
});
