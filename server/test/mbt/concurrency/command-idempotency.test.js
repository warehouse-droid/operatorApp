import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { executeMbtCommand } from "../../../src/mbt/command-repository.js";
import { closeDb, query } from "../../../src/db.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const FLAG_KEY = `p1_command_race_${RUN_ID}`;
const ACTOR = Object.freeze({
  operatorId: `p1-race-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});
const IDENTITY = Object.freeze({
  commandName: "mbt.test.concurrent_update",
  idempotencyKey: `p1-race-${RUN_ID}`,
  correlationId: `corr-race-${RUN_ID}`,
  requestId: `req-race-${RUN_ID}`
});

after(async () => {
  await closeDb();
});

test("F04: independent concurrent transactions execute one command callback and replay one durable receipt", async () => {
  await query(
    `INSERT INTO mbt_feature_flags (
       flag_key, enabled, description, revision, updated_by
     ) VALUES ($1, false, 'before race', 1, $2)`,
    [FLAG_KEY, ACTOR.operatorId]
  );
  const payload = {
    flagKey: FLAG_KEY,
    description: "won once",
    expectedRevision: 1
  };
  const callbackBackendPids = [];
  const execute = () => executeMbtCommand({
    actor: ACTOR,
    commandName: IDENTITY.commandName,
    idempotencyKey: IDENTITY.idempotencyKey,
    payload,
    correlationId: IDENTITY.correlationId,
    requestId: IDENTITY.requestId,
    mutation: async () => {
      const backend = await query("SELECT pg_backend_pid()::int AS pid");
      callbackBackendPids.push(backend.rows[0].pid);
      const updated = await query(
        `UPDATE mbt_feature_flags
            SET description = 'won once',
                revision = revision + 1,
                updated_by = $2,
                updated_at = now()
          WHERE flag_key = $1
        RETURNING revision::int AS revision`,
        [FLAG_KEY, ACTOR.operatorId]
      );
      await query("SELECT pg_sleep(0.05)");
      return {
        status: 200,
        body: { flagKey: FLAG_KEY, revision: updated.rows[0].revision },
        audit: {
          action: "mbt.feature_flag.description_updated",
          entityType: "mbt_feature_flag",
          entityId: FLAG_KEY,
          beforeState: { description: "before race", revision: 1 },
          afterState: { description: "won once", revision: 2 },
          reason: "independent transaction idempotency race",
          revisionBefore: 1,
          revisionAfter: 2
        }
      };
    }
  });

  const outcomes = await Promise.all(Array.from({ length: 16 }, execute));
  assert.equal(outcomes.filter(({ replayed }) => replayed === false).length, 1);
  assert.equal(outcomes.filter(({ replayed }) => replayed === true).length, 15);
  assert.ok(outcomes.every(({ status }) => status === 200));
  assert.ok(outcomes.every(({ body }) => body.flagKey === FLAG_KEY && body.revision === 2));
  assert.equal(callbackBackendPids.length, 1, JSON.stringify(callbackBackendPids));

  const evidence = await query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_command_receipts
         WHERE actor_operator_id = $1
           AND command_name = $2
           AND idempotency_key = $3) AS receipts,
       (SELECT count(*)::int
          FROM mbt_audit_events
         WHERE actor_operator_id = $1
           AND entity_id = $4
           AND idempotency_key = $3) AS audit_events,
       (SELECT revision::int
          FROM mbt_feature_flags
         WHERE flag_key = $4) AS revision`,
    [ACTOR.operatorId, IDENTITY.commandName, IDENTITY.idempotencyKey, FLAG_KEY]
  );
  assert.deepEqual(evidence.rows[0], { receipts: 1, audit_events: 1, revision: 2 });
});
