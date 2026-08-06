import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import { executeMbtCommand } from "../../../src/mbt/command-repository.js";
import { MbtError, toErrorEnvelope } from "../../../src/mbt/errors.js";
import { updateMbtFeatureFlagDescription } from "../../../src/mbt/feature-flag-repository.js";
import { hashCommandPayload } from "../../../src/mbt/idempotency.js";
import { listAudit, listAuditOptions } from "../../../src/auth-repository.js";
import { closeDb, query } from "../../../src/db.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const ACTOR = Object.freeze({
  operatorId: `p1-command-${RUN_ID}`,
  roles: Object.freeze(["admin", "mbt_billing"])
});
let fixtureSequence = 0;

function nextIdentity(label) {
  fixtureSequence += 1;
  const suffix = `${RUN_ID}${fixtureSequence}`;
  return {
    flagKey: `p1_${label}_${suffix}`,
    commandName: `mbt.test.${label}`,
    idempotencyKey: `p1-${label}-${suffix}`,
    correlationId: `corr-${label}-${suffix}`,
    requestId: `req-${label}-${suffix}`
  };
}

async function createFlag(flagKey, {
  description = "initial",
  revision = 1,
  updatedBy = ACTOR.operatorId
} = {}) {
  await query(
    `INSERT INTO mbt_feature_flags (
       flag_key, enabled, description, revision, updated_by
     ) VALUES ($1, false, $2, $3, $4)`,
    [flagKey, description, revision, updatedBy]
  );
}

async function readFlag(flagKey) {
  const result = await query(
    `SELECT flag_key, enabled, description, revision::int AS revision, updated_by
       FROM mbt_feature_flags
      WHERE flag_key = $1`,
    [flagKey]
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

function commandInput(identity, payload, mutation, extras = {}) {
  return {
    actor: ACTOR,
    commandName: identity.commandName,
    idempotencyKey: identity.idempotencyKey,
    payload,
    correlationId: identity.correlationId,
    requestId: identity.requestId,
    mutation,
    ...extras
  };
}

function descriptionMutation(identity, description, { auditAfter = null } = {}) {
  return async () => {
    const selected = await query(
      `SELECT description, revision::int AS revision
         FROM mbt_feature_flags
        WHERE flag_key = $1
        FOR UPDATE`,
      [identity.flagKey]
    );
    assert.equal(selected.rowCount, 1);
    const before = selected.rows[0];
    const revision = before.revision + 1;
    await query(
      `UPDATE mbt_feature_flags
          SET description = $2,
              revision = $3,
              updated_by = $4,
              updated_at = now()
        WHERE flag_key = $1`,
      [identity.flagKey, description, revision, ACTOR.operatorId]
    );
    return {
      status: 200,
      body: { flagKey: identity.flagKey, description, revision },
      audit: {
        action: "mbt.feature_flag.description_updated",
        entityType: "mbt_feature_flag",
        entityId: identity.flagKey,
        beforeState: { description: before.description, revision: before.revision },
        afterState: auditAfter || { description, revision },
        reason: "Phase 1 repository verification",
        revisionBefore: before.revision,
        revisionAfter: revision
      }
    };
  };
}

async function evidenceCounts(identity) {
  const result = await query(
    `SELECT
       (SELECT count(*)::int
          FROM mbt_command_receipts
         WHERE actor_operator_id = $1
           AND command_name = $2
           AND idempotency_key = $3) AS receipts,
       (SELECT count(*)::int
          FROM mbt_audit_events
         WHERE actor_operator_id = $1
           AND action = 'mbt.feature_flag.description_updated'
           AND entity_id = $4
           AND idempotency_key = $3) AS audit_events`,
    [ACTOR.operatorId, identity.commandName, identity.idempotencyKey, identity.flagKey]
  );
  return result.rows[0];
}

after(async () => {
  await closeDb();
});

test("F04: an exact command retry returns its stored result without invoking the mutation callback", async () => {
  const identity = nextIdentity("exact_retry");
  await createFlag(identity.flagKey);
  const payload = {
    flagKey: identity.flagKey,
    description: "updated once",
    expectedRevision: 1
  };
  let callbackCalls = 0;
  const first = await executeMbtCommand(commandInput(
    identity,
    payload,
    async () => {
      callbackCalls += 1;
      return descriptionMutation(identity, "updated once")();
    }
  ));
  const replay = await executeMbtCommand(commandInput(
    identity,
    {
      expectedRevision: 1,
      description: "updated once",
      flagKey: identity.flagKey
    },
    async () => {
      callbackCalls += 1;
      throw new Error("An exact replay must never execute this callback.");
    }
  ));

  const expectedBody = {
    flagKey: identity.flagKey,
    description: "updated once",
    revision: 2
  };
  assert.deepEqual(first, { status: 200, body: expectedBody, replayed: false });
  assert.deepEqual(replay, { status: 200, body: expectedBody, replayed: true });
  assert.equal(callbackCalls, 1);
  assert.deepEqual(await evidenceCounts(identity), { receipts: 1, audit_events: 1 });
  assert.equal((await readFlag(identity.flagKey)).revision, 2);
});

test("F04: reusing a command key with a different canonical payload returns the stable 409 conflict", async () => {
  const identity = nextIdentity("payload_conflict");
  await createFlag(identity.flagKey);
  const originalPayload = {
    flagKey: identity.flagKey,
    description: "original command",
    expectedRevision: 1
  };
  await executeMbtCommand(commandInput(
    identity,
    originalPayload,
    descriptionMutation(identity, "original command")
  ));

  const conflictingPayload = { ...originalPayload, description: "different command" };
  let callbackCalled = false;
  await assert.rejects(
    () => executeMbtCommand(commandInput(
      identity,
      conflictingPayload,
      async () => {
        callbackCalled = true;
        throw new Error("A payload conflict must be detected before mutation.");
      }
    )),
    (error) => {
      assert.ok(error instanceof MbtError);
      assert.deepEqual(toErrorEnvelope(error, { correlationId: identity.correlationId }), {
        status: 409,
        body: {
          error: "Idempotency key was already used with a different payload.",
          code: "MBT_IDEMPOTENCY_CONFLICT",
          details: {
            storedPayloadHash: hashCommandPayload(originalPayload),
            candidatePayloadHash: hashCommandPayload(conflictingPayload)
          },
          correlationId: identity.correlationId
        }
      });
      return true;
    }
  );

  assert.equal(callbackCalled, false);
  assert.deepEqual(await evidenceCounts(identity), { receipts: 1, audit_events: 1 });
  assert.equal((await readFlag(identity.flagKey)).description, "original command");
});

test("F04: malformed command envelopes fail before callbacks or durable evidence", async () => {
  const identity = nextIdentity("malformed_command");
  let callbackCalls = 0;
  const mutation = async () => {
    callbackCalls += 1;
    throw new Error("A malformed command must not invoke its callback.");
  };
  const valid = commandInput(identity, { flagKey: identity.flagKey }, mutation);
  const malformed = [
    [{ ...valid, actor: null }, "A command actor operator ID is required."],
    [{ ...valid, commandName: null }, "A command name is required."],
    [{ ...valid, idempotencyKey: " " }, "A command idempotency key is required."],
    [{ ...valid, correlationId: null }, "A command correlation ID is required."],
    [{ ...valid, requestId: null }, "A command request ID is required."],
    [{ ...valid, mutation: null }, "A command mutation callback is required."]
  ];
  for (const [input, message] of malformed) {
    await assert.rejects(
      () => executeMbtCommand(input),
      { name: "TypeError", message }
    );
  }
  assert.equal(callbackCalls, 0);
  assert.deepEqual(await evidenceCounts(identity), { receipts: 0, audit_events: 0 });
});

test("F05: invalid callback results roll domain changes back without audit or receipt evidence", async () => {
  const invalidResults = [
    null,
    {
      status: 500,
      body: { invalid: true },
      audit: { action: "invalid", entityType: "mbt_feature_flag", entityId: "invalid" }
    },
    {
      status: 200,
      body: [],
      audit: { action: "invalid", entityType: "mbt_feature_flag", entityId: "invalid" }
    },
    { status: 200, body: { invalid: true }, audit: null }
  ];

  for (const [index, invalidResult] of invalidResults.entries()) {
    const identity = nextIdentity(`invalid_result_${index}`);
    await createFlag(identity.flagKey);
    await assert.rejects(
      () => executeMbtCommand(commandInput(identity, { flagKey: identity.flagKey }, async () => {
        await query(
          `UPDATE mbt_feature_flags
              SET description = 'must roll back', revision = revision + 1
            WHERE flag_key = $1`,
          [identity.flagKey]
        );
        return invalidResult;
      })),
      (error) => error instanceof TypeError
    );
    assert.deepEqual(await readFlag(identity.flagKey), {
      flag_key: identity.flagKey,
      enabled: false,
      description: "initial",
      revision: 1,
      updated_by: ACTOR.operatorId
    });
    assert.deepEqual(await evidenceCounts(identity), { receipts: 0, audit_events: 0 });
  }
});

test("F05: a successful privileged mutation, redacted audit event, and command receipt commit atomically", async () => {
  const identity = nextIdentity("redacted_atomic");
  await createFlag(identity.flagKey);
  const payload = {
    flagKey: identity.flagKey,
    description: "safe persisted description",
    expectedRevision: 1
  };
  const result = await executeMbtCommand(commandInput(
    identity,
    payload,
    descriptionMutation(identity, "safe persisted description", {
      auditAfter: {
        description: "safe persisted description",
        revision: 2,
        password: "must-not-be-stored",
        oauthToken: "must-not-be-stored",
        nested: { bankAccount: "must-not-be-stored" },
        note: "prefix configured-secret suffix"
      }
    }),
    { secretValues: ["configured-secret"] }
  ));

  assert.equal(result.replayed, false);
  assert.equal((await readFlag(identity.flagKey)).description, "safe persisted description");

  const receipt = await query(
    `SELECT actor_roles, canonical_payload_hash, http_status,
            response_body, entity_type, entity_id, correlation_id, request_id
       FROM mbt_command_receipts
      WHERE actor_operator_id = $1
        AND command_name = $2
        AND idempotency_key = $3`,
    [ACTOR.operatorId, identity.commandName, identity.idempotencyKey]
  );
  assert.equal(receipt.rowCount, 1);
  assert.deepEqual(receipt.rows[0], {
    actor_roles: [...ACTOR.roles],
    canonical_payload_hash: hashCommandPayload(payload),
    http_status: 200,
    response_body: result.body,
    entity_type: "mbt_feature_flag",
    entity_id: identity.flagKey,
    correlation_id: identity.correlationId,
    request_id: identity.requestId
  });

  const audit = await query(
    `SELECT actor_type, actor_operator_id, actor_roles, action,
            entity_type, entity_id, before_state, after_state, reason,
            revision_before::int AS revision_before,
            revision_after::int AS revision_after,
            correlation_id, request_id, idempotency_key, source
       FROM mbt_audit_events
      WHERE entity_id = $1
        AND idempotency_key = $2`,
    [identity.flagKey, identity.idempotencyKey]
  );
  assert.equal(audit.rowCount, 1);
  assert.deepEqual(audit.rows[0], {
    actor_type: "operator",
    actor_operator_id: ACTOR.operatorId,
    actor_roles: [...ACTOR.roles],
    action: "mbt.feature_flag.description_updated",
    entity_type: "mbt_feature_flag",
    entity_id: identity.flagKey,
    before_state: { description: "initial", revision: 1 },
    after_state: {
      description: "safe persisted description",
      revision: 2,
      password: "[REDACTED]",
      oauthToken: "[REDACTED]",
      nested: { bankAccount: "[REDACTED]" },
      note: "[REDACTED]"
    },
    reason: "Phase 1 repository verification",
    revision_before: 1,
    revision_after: 2,
    correlation_id: identity.correlationId,
    request_id: identity.requestId,
    idempotency_key: identity.idempotencyKey,
    source: "mbt"
  });
  assert.doesNotMatch(JSON.stringify(audit.rows[0]), /must-not-be-stored|configured-secret/);
});

test("F05: configured secrets are centrally redacted from audit and replay receipts", async () => {
  const identity = nextIdentity("configured_secret");
  const configuredSecret = `configured-${RUN_ID}`;
  process.env.MBT_TEST_SECRET_TOKEN = configuredSecret;
  await createFlag(identity.flagKey);
  try {
    const first = await executeMbtCommand(commandInput(
      identity,
      { flagKey: identity.flagKey, expectedRevision: 1 },
      async () => {
        const mutation = await descriptionMutation(identity, "secret-safe", {
          auditAfter: {
            description: "secret-safe",
            revision: 2,
            note: `prefix ${configuredSecret} suffix`
          }
        })();
        mutation.body.note = `prefix ${configuredSecret} suffix`;
        return mutation;
      }
    ));
    assert.equal(first.body.note, "[REDACTED]");

    const stored = await query(
      `SELECT r.response_body, a.after_state
         FROM mbt_command_receipts r
         JOIN mbt_audit_events a
           ON a.actor_operator_id = r.actor_operator_id
          AND a.idempotency_key = r.idempotency_key
        WHERE r.actor_operator_id = $1
          AND r.command_name = $2
          AND r.idempotency_key = $3`,
      [ACTOR.operatorId, identity.commandName, identity.idempotencyKey]
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].response_body.note, "[REDACTED]");
    assert.equal(stored.rows[0].after_state.note, "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(stored.rows[0]), new RegExp(configuredSecret));
  } finally {
    delete process.env.MBT_TEST_SECRET_TOKEN;
  }
});

test("F05: incomplete privileged audit evidence rolls back the mutation and stores no receipt", async () => {
  const identity = nextIdentity("minimal_audit");
  const actor = Object.freeze({
    operatorId: `p1-system-${RUN_ID}`,
    actorType: "system",
    roles: Object.freeze([])
  });
  await createFlag(identity.flagKey);
  await assert.rejects(
    () => executeMbtCommand(commandInput(
      identity,
      { flagKey: identity.flagKey, description: "system update" },
      async () => {
        await query(
          `UPDATE mbt_feature_flags
              SET description = 'system update', revision = 2, updated_by = $2
            WHERE flag_key = $1`,
          [identity.flagKey, actor.operatorId]
        );
        return {
          status: 204,
          body: { flagKey: identity.flagKey },
          audit: {
            action: "mbt.feature_flag.description_updated",
            entityType: "mbt_feature_flag",
            entityId: identity.flagKey,
            beforeState: null,
            afterState: undefined,
            reason: null,
            revisionBefore: null,
            revisionAfter: undefined,
            source: "mbt-system-test"
          }
        };
      },
      { actor }
    )),
    /command actor roles|required audit (before state|after state|reason|revision)/i
  );
  assert.deepEqual(await readFlag(identity.flagKey), {
    flag_key: identity.flagKey,
    enabled: false,
    description: "initial",
    revision: 1,
    updated_by: ACTOR.operatorId
  });
  assert.deepEqual(await evidenceCounts(identity), { receipts: 0, audit_events: 0 });
});

test("F05: an audit insertion failure rolls the domain mutation back and stores no receipt", async () => {
  const identity = nextIdentity("audit_rollback");
  await createFlag(identity.flagKey);
  const payload = { flagKey: identity.flagKey, expectedRevision: 1 };

  await assert.rejects(
    () => executeMbtCommand(commandInput(identity, payload, async () => {
      await query(
        `UPDATE mbt_feature_flags
            SET description = 'must roll back', revision = 2
          WHERE flag_key = $1`,
        [identity.flagKey]
      );
      return {
        status: 200,
        body: { shouldNotPersist: true },
        audit: {
          action: null,
          entityType: "mbt_feature_flag",
          entityId: identity.flagKey,
          beforeState: { revision: 1 },
          afterState: { revision: 2 },
          revisionBefore: 1,
          revisionAfter: 2
        }
      };
    })),
    /audit action|required|not blank|check constraint/i
  );

  assert.deepEqual(await readFlag(identity.flagKey), {
    flag_key: identity.flagKey,
    enabled: false,
    description: "initial",
    revision: 1,
    updated_by: ACTOR.operatorId
  });
  assert.deepEqual(await evidenceCounts(identity), { receipts: 0, audit_events: 0 });
});

test("F03: a stale feature-flag revision returns 409 with no state, audit, or receipt change", async () => {
  const identity = nextIdentity("stale_revision");
  await createFlag(identity.flagKey, { description: "current", revision: 4 });

  await assert.rejects(
    () => updateMbtFeatureFlagDescription({
      actor: ACTOR,
      flagKey: identity.flagKey,
      description: "stale overwrite",
      expectedRevision: 3,
      reason: "stale browser test",
      commandName: identity.commandName,
      idempotencyKey: identity.idempotencyKey,
      correlationId: identity.correlationId,
      requestId: identity.requestId
    }),
    (error) => {
      assert.ok(error instanceof MbtError);
      assert.deepEqual(toErrorEnvelope(error, { correlationId: identity.correlationId }), {
        status: 409,
        body: {
          error: "This MBT record changed. Refresh it before saving again.",
          code: "MBT_STALE_REVISION",
          details: {},
          correlationId: identity.correlationId
        }
      });
      return true;
    }
  );

  assert.deepEqual(await readFlag(identity.flagKey), {
    flag_key: identity.flagKey,
    enabled: false,
    description: "current",
    revision: 4,
    updated_by: ACTOR.operatorId
  });
  assert.deepEqual(await evidenceCounts(identity), { receipts: 0, audit_events: 0 });
});

test("F03/F05: description maintenance preserves a disabled flag and commits its audit atomically", async () => {
  const identity = nextIdentity("feature_flag_success");
  await createFlag(identity.flagKey, { updatedBy: null });
  const result = await updateMbtFeatureFlagDescription({
    actor: ACTOR,
    flagKey: identity.flagKey,
    description: null,
    expectedRevision: 1,
    reason: "Clear an obsolete description",
    idempotencyKey: identity.idempotencyKey,
    correlationId: identity.correlationId,
    requestId: identity.requestId
  });
  assert.deepEqual(result, {
    status: 200,
    body: {
      flag: {
        flagKey: identity.flagKey,
        enabled: false,
        description: "",
        revision: 2,
        updatedBy: ACTOR.operatorId
      }
    },
    replayed: false
  });
  assert.deepEqual(await readFlag(identity.flagKey), {
    flag_key: identity.flagKey,
    enabled: false,
    description: "",
    revision: 2,
    updated_by: ACTOR.operatorId
  });

  const evidence = await query(
    `SELECT r.command_name, r.http_status, a.before_state, a.after_state,
            a.reason, a.revision_before::int AS revision_before,
            a.revision_after::int AS revision_after
       FROM mbt_command_receipts r
       JOIN mbt_audit_events a
         ON a.actor_operator_id = r.actor_operator_id
        AND a.idempotency_key = r.idempotency_key
      WHERE r.actor_operator_id = $1
        AND r.idempotency_key = $2`,
    [ACTOR.operatorId, identity.idempotencyKey]
  );
  assert.deepEqual(evidence.rows[0], {
    command_name: "mbt.feature_flag.description_updated",
    http_status: 200,
    before_state: {
      flagKey: identity.flagKey,
      enabled: false,
      description: "initial",
      revision: 1,
      updatedBy: null
    },
    after_state: {
      flagKey: identity.flagKey,
      enabled: false,
      description: "",
      revision: 2,
      updatedBy: ACTOR.operatorId
    },
    reason: "Clear an obsolete description",
    revision_before: 1,
    revision_after: 2
  });
});

test("F03: missing or malformed feature-flag targets fail without durable evidence", async () => {
  const missing = nextIdentity("feature_flag_missing");
  await assert.rejects(
    () => updateMbtFeatureFlagDescription({
      actor: ACTOR,
      flagKey: missing.flagKey,
      description: "must not exist",
      expectedRevision: 1,
      reason: "Missing flag contract",
      commandName: missing.commandName,
      idempotencyKey: missing.idempotencyKey,
      correlationId: missing.correlationId,
      requestId: missing.requestId
    }),
    (error) => error instanceof MbtError
      && error.status === 404
      && error.code === "MBT_FEATURE_FLAG_NOT_FOUND"
  );
  assert.deepEqual(await evidenceCounts(missing), { receipts: 0, audit_events: 0 });

  const malformed = [
    { ...missing, flagKey: null, reason: "reason" },
    { ...missing, flagKey: missing.flagKey, reason: null }
  ];
  for (const input of malformed) {
    await assert.rejects(
      () => updateMbtFeatureFlagDescription({
        actor: ACTOR,
        flagKey: input.flagKey,
        description: "invalid",
        expectedRevision: 1,
        reason: input.reason,
        commandName: input.commandName,
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        requestId: input.requestId
      }),
      (error) => error instanceof TypeError
    );
  }
  assert.deepEqual(await evidenceCounts(missing), { receipts: 0, audit_events: 0 });
});

test("F05: PostgreSQL rejects UPDATE and DELETE for audit events and command receipts", async () => {
  const identity = nextIdentity("immutable_evidence");
  await createFlag(identity.flagKey);
  await executeMbtCommand(commandInput(
    identity,
    { flagKey: identity.flagKey, description: "immutable", expectedRevision: 1 },
    descriptionMutation(identity, "immutable")
  ));

  for (const statement of [
    {
      sql: "UPDATE mbt_command_receipts SET http_status = 201 WHERE idempotency_key = $1",
      params: [identity.idempotencyKey]
    },
    {
      sql: "DELETE FROM mbt_command_receipts WHERE idempotency_key = $1",
      params: [identity.idempotencyKey]
    },
    {
      sql: "UPDATE mbt_audit_events SET reason = 'rewritten' WHERE entity_id = $1",
      params: [identity.flagKey]
    },
    {
      sql: "DELETE FROM mbt_audit_events WHERE entity_id = $1",
      params: [identity.flagKey]
    }
  ]) {
    await assert.rejects(
      () => query(statement.sql, statement.params),
      (error) => error?.code === "55000"
    );
  }

  assert.deepEqual(await evidenceCounts(identity), { receipts: 1, audit_events: 1 });
});

test("F05: the existing unified Admin audit exposes MBT events and filter options", async () => {
  const identity = nextIdentity("unified_audit");
  await createFlag(identity.flagKey);
  await executeMbtCommand(commandInput(
    identity,
    { flagKey: identity.flagKey, description: "unified", expectedRevision: 1 },
    descriptionMutation(identity, "unified")
  ));

  const rows = await listAudit({ limit: 10, tranid: identity.flagKey });
  const event = rows.find((row) => row.entity_id === identity.flagKey);
  assert.ok(event, JSON.stringify(rows));
  assert.equal(event.audit_stream, "mbt");
  assert.equal(event.actor_operator_id, ACTOR.operatorId);
  assert.equal(event.action, "mbt.feature_flag.description_updated");
  assert.equal(event.tranid, identity.flagKey);
  assert.equal(typeof event.id, "string");
  assert.match(event.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.deepEqual(event.details, {
    entityType: "mbt_feature_flag",
    entityId: identity.flagKey,
    before: { description: "initial", revision: 1 },
    after: { description: "unified", revision: 2 },
    auditEventId: event.id,
    actorRoles: [...ACTOR.roles],
    reason: "Phase 1 repository verification",
    revisionBefore: 1,
    revisionAfter: 2,
    correlationId: identity.correlationId,
    requestId: identity.requestId,
    idempotencyKey: identity.idempotencyKey
  });

  const options = await listAuditOptions({ tranid: identity.flagKey });
  assert.ok(options.actors.includes(ACTOR.operatorId), JSON.stringify(options));
  assert.ok(options.actions.includes("mbt.feature_flag.description_updated"), JSON.stringify(options));
});

test("F05 non-regression: tied legacy audit rows retain numeric ID ordering", async () => {
  const action = `mbt.legacy_audit_order.${RUN_ID}`;
  const lowerId = "9000000000000009";
  const higherId = "10000000000000010";
  try {
    await query("DELETE FROM delivery_audit_log WHERE action = $1", [action]);
    await query(
      `INSERT INTO delivery_audit_log (
         id, actor_type, source, action, details, created_at
       ) VALUES
         ($1::bigint, 'system', 'mbt-non-regression', $3, '{}'::jsonb, $4::timestamptz),
         ($2::bigint, 'system', 'mbt-non-regression', $3, '{}'::jsonb, $4::timestamptz)`,
      [lowerId, higherId, action, "2099-01-01T00:00:00.000Z"]
    );

    const rows = await listAudit({ limit: 2, action });
    assert.deepEqual(
      rows.map((row) => row.id),
      [higherId, lowerId],
      "Legacy bigint audit IDs must still break timestamp ties numerically."
    );
  } finally {
    await query("DELETE FROM delivery_audit_log WHERE action = $1", [action]);
  }
});
