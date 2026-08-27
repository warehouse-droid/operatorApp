// @ts-check

import crypto from "node:crypto";

import { query, withTransaction } from "./db.js";

/** @param {string} code @param {string} message @param {number} [status] */
function repositoryError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}

/** @param {unknown} value @param {string} label */
function requiredText(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw repositoryError("OPERATOR_NETSUITE_POSTING_INPUT_INVALID", `${label} is required.`, 400);
  }
  return normalized;
}

/** @param {unknown} value */
function errorText(value) {
  if (value instanceof Error) {return value.message || value.name;}
  return String(value || "Operator NetSuite posting failed.");
}

/** @param {Record<string, any>} row */
function publicStep(row) {
  return {
    id: Number(row.id),
    commandId: row.command_id,
    stepIndex: Number(row.step_index),
    sourceOrderKind: row.source_order_kind,
    sourceNetSuiteId: Number(row.source_netsuite_id),
    sourceOrderRef: row.source_order_ref,
    transactionType: row.transaction_type,
    externalId: row.external_id,
    payloadHash: row.payload_hash,
    payload: row.payload || {},
    lineSnapshot: row.line_snapshot || [],
    baselineTransactionIds: row.baseline_transaction_ids || [],
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    netSuiteTransactionId: row.netsuite_transaction_id === null
      ? null
      : Number(row.netsuite_transaction_id),
    netSuiteTransactionRef: row.netsuite_transaction_ref,
    response: row.response || {},
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    postedAt: row.posted_at
  };
}

/** @param {Record<string, any>} row @param {Array<Record<string, any>>} steps @param {string[]} claims */
function publicCommand(row, steps, claims) {
  return {
    id: row.id,
    requestId: row.request_id,
    actorOperatorId: row.actor_operator_id,
    functionKey: row.function_key,
    transactionType: row.transaction_type,
    canonicalLocationId: Number(row.canonical_location_id),
    yardCode: row.yard_code,
    gateKey: row.gate_key,
    gateRevision: Number(row.gate_revision),
    inputHash: row.input_hash,
    inputSnapshot: row.input_snapshot || {},
    photoRefs: row.photo_refs || [],
    status: row.status,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    result: row.result || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    steps: steps.map(publicStep),
    activeClaims: claims
  };
}

/** @param {string} commandId */
async function hydratedCommand(commandId) {
  const commandResult = await query(
    `SELECT *
       FROM operator_netsuite_posting_commands
      WHERE id = $1`,
    [commandId]
  );
  if (!commandResult.rows[0]) {return null;}
  // These reads deliberately remain sequential: within withTransaction they
  // share one pg client, which cannot safely execute concurrent queries.
  const stepResult = await query(
    `SELECT *
       FROM operator_netsuite_posting_steps
      WHERE command_id = $1
      ORDER BY step_index ASC`,
    [commandId]
  );
  const claimResult = await query(
    `SELECT local_order_key
       FROM operator_netsuite_posting_order_claims
      WHERE command_id = $1
        AND active = true
      ORDER BY local_order_key ASC`,
    [commandId]
  );
  return publicCommand(
    commandResult.rows[0],
    stepResult.rows,
    claimResult.rows.map((/** @type {Record<string, any>} */ row) => row.local_order_key)
  );
}

/** @param {unknown} error */
function translateCreateConflict(error) {
  const details = error && typeof error === "object"
    ? /** @type {Record<string, any>} */ (error)
    : {};
  if (details.code === "23505"
      && (details.constraint === "operator_netsuite_posting_order_claims_active_idx"
        || String(details.detail || "").includes("function_key, local_order_key"))) {
    return repositoryError(
      "OPERATOR_NETSUITE_POSTING_ORDER_CLAIMED",
      "This order already has an active Operator NetSuite posting command."
    );
  }
  return error;
}

/**
 * Persist an immutable command or replay the command bound to the same request.
 *
 * @param {Record<string, any>} draft
 */
export async function createOrReplayOperatorNetSuitePostingCommand(draft) {
  try {
    return await withTransaction(async () => {
      const inserted = await query(
        `INSERT INTO operator_netsuite_posting_commands (
           id,
           request_id,
           actor_operator_id,
           function_key,
           transaction_type,
           canonical_location_id,
           yard_code,
           gate_key,
           gate_revision,
           input_hash,
           input_snapshot,
           photo_refs
         )
         VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
         ON CONFLICT (request_id) DO NOTHING
         RETURNING id`,
        [
          draft.requestId,
          draft.actorOperatorId,
          draft.functionKey,
          draft.transactionType,
          draft.policy.locationId,
          draft.policy.yardCode,
          draft.policy.gateKey,
          draft.policy.revision,
          draft.inputHash,
          JSON.stringify(draft.inputSnapshot),
          JSON.stringify(draft.photoRefs)
        ]
      );

      if (!inserted.rows[0]) {
        const existing = await query(
          `SELECT id, input_hash
             FROM operator_netsuite_posting_commands
            WHERE request_id = $1
            FOR UPDATE`,
          [draft.requestId]
        );
        if (!existing.rows[0] || existing.rows[0].input_hash !== draft.inputHash) {
          throw repositoryError(
            "OPERATOR_NETSUITE_POSTING_IDEMPOTENCY_CONFLICT",
            "This Operator request ID is already bound to different posting input."
          );
        }
        return {
          replayed: true,
          command: await hydratedCommand(existing.rows[0].id)
        };
      }

      for (const localOrderKey of draft.claims) {
        await query(
          `INSERT INTO operator_netsuite_posting_order_claims (
             command_id,
             function_key,
             local_order_key
           )
           VALUES ($1, $2, $3)`,
          [draft.requestId, draft.functionKey, localOrderKey]
        );
      }
      for (const step of draft.steps) {
        await query(
          `INSERT INTO operator_netsuite_posting_steps (
             command_id,
             step_index,
             source_order_kind,
             source_netsuite_id,
             source_order_ref,
             transaction_type,
             external_id,
             payload_hash,
             payload,
             line_snapshot,
             baseline_transaction_ids
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)`,
          [
            draft.requestId,
            step.stepIndex,
            step.sourceOrderKind,
            step.sourceNetSuiteId,
            step.sourceOrderRef,
            step.transactionType,
            step.externalId,
            step.payloadHash,
            JSON.stringify(step.payload),
            JSON.stringify(step.lineSnapshot),
            JSON.stringify(step.baselineTransactionIds || [])
          ]
        );
      }
      return {
        replayed: false,
        command: await hydratedCommand(draft.requestId)
      };
    });
  } catch (error) {
    throw translateCreateConflict(error);
  }
}

/** @param {string} commandId */
export async function getOperatorNetSuitePostingCommand(commandId) {
  return hydratedCommand(requiredText(commandId, "Operator posting command ID"));
}

/**
 * Gate-off/local mutations must not pass a draft that is frozen by an
 * accepted remote-post command (including a local child of a mixed group).
 *
 * @param {{ functionKey: string, localOrderKeys: string[] }} input
 */
export async function assertNoActiveOperatorNetSuitePostingClaims({ functionKey, localOrderKeys }) {
  const keys = [...new Set((localOrderKeys || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!keys.length) {return;}
  const result = await query(
    `SELECT command_id, local_order_key
       FROM operator_netsuite_posting_order_claims
      WHERE function_key = $1
        AND local_order_key = ANY($2::text[])
        AND active = true
      ORDER BY created_at
      LIMIT 1`,
    [requiredText(functionKey, "Operator function"), keys]
  );
  if (result.rows[0]) {
    throw repositoryError(
      "OPERATOR_NETSUITE_POSTING_IN_PROGRESS",
      "This order is frozen while its NetSuite posting command is being verified."
    );
  }
}

/**
 * @param {{ commandId: string, workerId: string, leaseSeconds?: number }} input
 */
export async function claimOperatorNetSuitePostingCommand(input) {
  const commandId = requiredText(input?.commandId, "Operator posting command ID");
  const workerId = requiredText(input?.workerId, "Operator posting worker ID");
  const leaseSeconds = Number(input?.leaseSeconds ?? 30);
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) {
    throw repositoryError(
      "OPERATOR_NETSUITE_POSTING_INPUT_INVALID",
      "Operator posting lease seconds must be an integer from 1 to 3600.",
      400
    );
  }
  return withTransaction(async () => {
    const expired = await query(
      `SELECT id
         FROM operator_netsuite_posting_commands
        WHERE id = $1
          AND status IN ('posting', 'finalizing')
          AND lease_expires_at <= now()
        FOR UPDATE`,
      [commandId]
    );
    if (expired.rows[0]) {
      await query(
        `UPDATE operator_netsuite_posting_attempts AS attempt
            SET outcome = 'uncertain',
                details = jsonb_build_object('reason', 'lease_expired'),
                error = 'Worker lease expired before an outcome was recorded.',
                finished_at = now()
           FROM operator_netsuite_posting_steps AS step
          WHERE step.command_id = $1
            AND attempt.step_id = step.id
            AND attempt.outcome = 'posting'`,
        [commandId]
      );
      await query(
        `UPDATE operator_netsuite_posting_steps
            SET status = 'uncertain',
                last_error = 'Worker lease expired before an outcome was recorded.',
                updated_at = now()
          WHERE command_id = $1
            AND status = 'posting'`,
        [commandId]
      );
      await query(
        `UPDATE operator_netsuite_posting_commands
            SET status = 'queued',
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                last_error = 'Previous worker lease expired; external-ID recovery is required.',
                updated_at = now()
          WHERE id = $1`,
        [commandId]
      );
    }

    const leaseToken = crypto.randomUUID();
    const claimed = await query(
      `UPDATE operator_netsuite_posting_commands
          SET status = 'posting',
              lease_owner = $2,
              lease_token = $3,
              lease_expires_at = now() + ($4::integer * interval '1 second'),
              updated_at = now()
        WHERE id = (
          SELECT id
            FROM operator_netsuite_posting_commands
           WHERE id = $1
             AND status = 'queued'
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id`,
      [commandId, workerId, leaseToken, leaseSeconds]
    );
    if (!claimed.rows[0]) {return null;}
    return hydratedCommand(commandId);
  });
}

/**
 * Extend only the exact live lease. A stale worker can never revive its token.
 *
 * @param {{ commandId: string, leaseToken: string, leaseSeconds?: number }} input
 */
export async function renewOperatorNetSuitePostingLease(input) {
  const commandId = requiredText(input?.commandId, "Operator posting command ID");
  const leaseToken = requiredText(input?.leaseToken, "Operator posting lease token");
  const leaseSeconds = Number(input?.leaseSeconds ?? 300);
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 3600) {
    throw repositoryError(
      "OPERATOR_NETSUITE_POSTING_INPUT_INVALID",
      "Operator posting lease seconds must be an integer from 1 to 3600.",
      400
    );
  }
  return withTransaction(async () => {
    await lockedLeasedCommand(commandId, leaseToken);
    await query(
      `UPDATE operator_netsuite_posting_commands
          SET lease_expires_at = now() + ($3::integer * interval '1 second'),
              updated_at = now()
        WHERE id = $1
          AND lease_token = $2`,
      [commandId, leaseToken, leaseSeconds]
    );
    return hydratedCommand(commandId);
  });
}

/** @param {string} commandId @param {string} leaseToken */
async function lockedLeasedCommand(commandId, leaseToken) {
  const result = await query(
    `SELECT *,
            (lease_expires_at > now()) AS lease_valid
       FROM operator_netsuite_posting_commands
      WHERE id = $1
      FOR UPDATE`,
    [commandId]
  );
  const row = result.rows[0];
  if (!row
      || !["posting", "finalizing"].includes(row.status)
      || String(row.lease_token || "") !== leaseToken
      || row.lease_valid !== true) {
    throw repositoryError(
      "OPERATOR_NETSUITE_POSTING_LEASE_LOST",
      "The Operator NetSuite posting lease is missing, expired, or owned by another worker."
    );
  }
  return row;
}

/** @param {string} commandId @param {number} stepId */
async function lockedStep(commandId, stepId) {
  const result = await query(
    `SELECT *
       FROM operator_netsuite_posting_steps
      WHERE id = $1
        AND command_id = $2
      FOR UPDATE`,
    [stepId, commandId]
  );
  if (!result.rows[0]) {
    throw repositoryError(
      "OPERATOR_NETSUITE_POSTING_STEP_NOT_FOUND",
      "The Operator NetSuite posting step was not found.",
      404
    );
  }
  return result.rows[0];
}

/**
 * @param {{ commandId: string, stepId: number, leaseToken: string }} input
 */
export async function startOperatorNetSuitePostingAttempt(input) {
  const commandId = requiredText(input?.commandId, "Operator posting command ID");
  const leaseToken = requiredText(input?.leaseToken, "Operator posting lease token");
  const stepId = Number(input?.stepId);
  return withTransaction(async () => {
    await lockedLeasedCommand(commandId, leaseToken);
    const step = await lockedStep(commandId, stepId);
    if (step.status === "posted") {
      throw repositoryError(
        "OPERATOR_NETSUITE_POSTING_STEP_ALREADY_POSTED",
        "This NetSuite posting step is already complete."
      );
    }
    const activeAttempt = await query(
      `SELECT attempt_number
         FROM operator_netsuite_posting_attempts
        WHERE step_id = $1
          AND outcome = 'posting'
        ORDER BY attempt_number DESC
        LIMIT 1`,
      [stepId]
    );
    if (activeAttempt.rows[0]) {
      return {
        attemptNumber: Number(activeAttempt.rows[0].attempt_number),
        step: publicStep(step)
      };
    }
    const attemptNumber = Number(step.attempt_count || 0) + 1;
    await query(
      `INSERT INTO operator_netsuite_posting_attempts (
         step_id,
         attempt_number,
         outcome
       )
       VALUES ($1, $2, 'posting')`,
      [stepId, attemptNumber]
    );
    const updated = await query(
      `UPDATE operator_netsuite_posting_steps
          SET status = 'posting',
              attempt_count = $2,
              last_error = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [stepId, attemptNumber]
    );
    return { attemptNumber, step: publicStep(updated.rows[0]) };
  });
}

/**
 * @param {{
 *   commandId: string,
 *   stepId: number,
 *   leaseToken: string,
 *   attemptNumber: number,
 *   transactionId: number,
 *   transactionRef?: string,
 *   response?: Record<string, any>,
 *   recovered?: boolean
 * }} input
 */
export async function recordOperatorNetSuitePostingStepSuccess(input) {
  const commandId = requiredText(input?.commandId, "Operator posting command ID");
  const leaseToken = requiredText(input?.leaseToken, "Operator posting lease token");
  const stepId = Number(input?.stepId);
  const attemptNumber = Number(input?.attemptNumber);
  const transactionId = Number(input?.transactionId);
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
    throw repositoryError(
      "OPERATOR_NETSUITE_POSTING_INPUT_INVALID",
      "A positive NetSuite transaction ID is required.",
      400
    );
  }
  return withTransaction(async () => {
    await lockedLeasedCommand(commandId, leaseToken);
    const step = await lockedStep(commandId, stepId);
    if (step.status === "posted") {return publicStep(step);}
    const attempt = await query(
      `UPDATE operator_netsuite_posting_attempts
          SET outcome = $3,
              details = $4::jsonb,
              error = NULL,
              finished_at = now()
        WHERE step_id = $1
          AND attempt_number = $2
          AND outcome = 'posting'
        RETURNING id`,
      [
        stepId,
        attemptNumber,
        input?.recovered ? "recovered" : "posted",
        JSON.stringify(input?.response || {})
      ]
    );
    if (!attempt.rows[0]) {
      throw repositoryError(
        "OPERATOR_NETSUITE_POSTING_ATTEMPT_NOT_ACTIVE",
        "The NetSuite posting attempt is no longer active."
      );
    }
    const updated = await query(
      `UPDATE operator_netsuite_posting_steps
          SET status = 'posted',
              netsuite_transaction_id = $2,
              netsuite_transaction_ref = NULLIF($3, ''),
              response = $4::jsonb,
              last_error = NULL,
              posted_at = now(),
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [stepId, transactionId, String(input?.transactionRef || "").trim(), JSON.stringify(input?.response || {})]
    );
    return publicStep(updated.rows[0]);
  });
}

/**
 * @param {{
 *   commandId: string,
 *   stepId: number,
 *   leaseToken: string,
 *   attemptNumber: number,
 *   error: unknown,
 *   uncertain?: boolean
 * }} input
 */
export async function recordOperatorNetSuitePostingStepFailure(input) {
  const commandId = requiredText(input?.commandId, "Operator posting command ID");
  const leaseToken = requiredText(input?.leaseToken, "Operator posting lease token");
  const stepId = Number(input?.stepId);
  const attemptNumber = Number(input?.attemptNumber);
  const message = errorText(input?.error);
  const outcome = input?.uncertain ? "uncertain" : "failed";
  return withTransaction(async () => {
    await lockedLeasedCommand(commandId, leaseToken);
    const step = await lockedStep(commandId, stepId);
    if (step.status === "posted") {
      throw repositoryError(
        "OPERATOR_NETSUITE_POSTING_STEP_ALREADY_POSTED",
        "This NetSuite posting step is already complete."
      );
    }
    const attempt = await query(
      `UPDATE operator_netsuite_posting_attempts
          SET outcome = $3,
              error = $4,
              finished_at = now()
        WHERE step_id = $1
          AND attempt_number = $2
          AND outcome = 'posting'
        RETURNING id`,
      [stepId, attemptNumber, outcome, message]
    );
    if (!attempt.rows[0]) {
      throw repositoryError(
        "OPERATOR_NETSUITE_POSTING_ATTEMPT_NOT_ACTIVE",
        "The NetSuite posting attempt is no longer active."
      );
    }
    const updated = await query(
      `UPDATE operator_netsuite_posting_steps
          SET status = $2,
              last_error = $3,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [stepId, outcome, message]
    );
    return publicStep(updated.rows[0]);
  });
}

/**
 * @param {{ commandId: string, leaseToken: string, error: unknown }} input
 */
export async function markOperatorNetSuitePostingCommandAttention(input) {
  const commandId = requiredText(input?.commandId, "Operator posting command ID");
  const leaseToken = requiredText(input?.leaseToken, "Operator posting lease token");
  return withTransaction(async () => {
    await lockedLeasedCommand(commandId, leaseToken);
    await query(
      `UPDATE operator_netsuite_posting_commands
          SET status = 'attention',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error = $2,
              updated_at = now()
        WHERE id = $1`,
      [commandId, errorText(input?.error)]
    );
    return hydratedCommand(commandId);
  });
}

/**
 * Release a draft only when no NetSuite step was ever verified as posted.
 *
 * @param {{ commandId: string, leaseToken: string, error: unknown }} input
 */
export async function failOperatorNetSuitePostingCommand(input) {
  const commandId = requiredText(input?.commandId, "Operator posting command ID");
  const leaseToken = requiredText(input?.leaseToken, "Operator posting lease token");
  return withTransaction(async () => {
    await lockedLeasedCommand(commandId, leaseToken);
    const posted = await query(
      `SELECT count(*)::integer AS count
         FROM operator_netsuite_posting_steps
        WHERE command_id = $1
          AND status = 'posted'`,
      [commandId]
    );
    if (Number(posted.rows[0]?.count || 0) > 0) {
      throw repositoryError(
        "OPERATOR_NETSUITE_POSTING_REMOTE_WORK_EXISTS",
        "A command with verified NetSuite work must remain frozen for attention."
      );
    }
    await query(
      `UPDATE operator_netsuite_posting_order_claims
          SET active = false,
              released_at = now()
        WHERE command_id = $1
          AND active = true`,
      [commandId]
    );
    await query(
      `UPDATE operator_netsuite_posting_commands
          SET status = 'failed',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error = $2,
              updated_at = now()
        WHERE id = $1`,
      [commandId, errorText(input?.error)]
    );
    return hydratedCommand(commandId);
  });
}

/** @param {{ limit?: number }} [input] */
export async function listOperatorNetSuitePostingAttentionCommands({ limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const result = await query(
    `SELECT id
       FROM operator_netsuite_posting_commands
      WHERE status = 'attention'
      ORDER BY updated_at ASC, id ASC
      LIMIT $1`,
    [safeLimit]
  );
  const commands = [];
  for (const row of result.rows) {
    const command = await hydratedCommand(row.id);
    if (command) {commands.push(command);}
  }
  return commands;
}

/** @param {{ limit?: number }} [input] */
export async function listRunnableOperatorNetSuitePostingCommandIds({ limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const result = await query(
    `SELECT id
       FROM operator_netsuite_posting_commands
      WHERE status = 'queued'
         OR (
           status IN ('posting', 'finalizing')
           AND lease_expires_at <= now()
         )
      ORDER BY created_at ASC, id ASC
      LIMIT $1`,
    [safeLimit]
  );
  return result.rows.map((/** @type {Record<string, any>} */ row) => String(row.id));
}

/** @param {string} commandId */
export async function resumeOperatorNetSuitePostingCommand(commandId) {
  const id = requiredText(commandId, "Operator posting command ID");
  return withTransaction(async () => {
    const updated = await query(
      `UPDATE operator_netsuite_posting_commands
          SET status = 'queued',
              last_error = NULL,
              updated_at = now()
        WHERE id = $1
          AND status = 'attention'
        RETURNING id`,
      [id]
    );
    if (!updated.rows[0]) {
      const existing = await hydratedCommand(id);
      if (!existing) {
        throw repositoryError(
          "OPERATOR_NETSUITE_POSTING_COMMAND_NOT_FOUND",
          "The Operator NetSuite posting command was not found.",
          404
        );
      }
      if (existing.status === "queued") {return existing;}
      throw repositoryError(
        "OPERATOR_NETSUITE_POSTING_NOT_ATTENTION",
        "Only an attention command can be resumed."
      );
    }
    return hydratedCommand(id);
  });
}

/**
 * Complete the command and its existing local operation in one database
 * transaction. The callback must contain database-local finalization only.
 *
 * @param {{
 *   commandId: string,
 *   leaseToken: string,
 *   result?: Record<string, any>,
 *   finalize: () => Promise<unknown>
 * }} input
 */
export async function completeOperatorNetSuitePostingCommand(input) {
  const commandId = requiredText(input?.commandId, "Operator posting command ID");
  const leaseToken = requiredText(input?.leaseToken, "Operator posting lease token");
  if (typeof input?.finalize !== "function") {
    throw repositoryError(
      "OPERATOR_NETSUITE_POSTING_INPUT_INVALID",
      "A local Operator finalization callback is required.",
      400
    );
  }
  return withTransaction(async () => {
    const current = await query(
      `SELECT *
         FROM operator_netsuite_posting_commands
        WHERE id = $1
        FOR UPDATE`,
      [commandId]
    );
    if (current.rows[0]?.status === "completed") {return hydratedCommand(commandId);}
    await lockedLeasedCommand(commandId, leaseToken);
    const incomplete = await query(
      `SELECT count(*)::integer AS count
         FROM operator_netsuite_posting_steps
        WHERE command_id = $1
          AND status <> 'posted'`,
      [commandId]
    );
    if (Number(incomplete.rows[0]?.count || 0) !== 0) {
      throw repositoryError(
        "OPERATOR_NETSUITE_POSTING_STEPS_INCOMPLETE",
        "Every NetSuite posting step must be verified before local completion."
      );
    }
    await query(
      `UPDATE operator_netsuite_posting_commands
          SET status = 'finalizing',
              updated_at = now()
        WHERE id = $1`,
      [commandId]
    );
    const localFinalization = await input.finalize();
    await query(
      `UPDATE operator_netsuite_posting_order_claims
          SET active = false,
              released_at = now()
        WHERE command_id = $1
          AND active = true`,
      [commandId]
    );
    await query(
      `UPDATE operator_netsuite_posting_commands
          SET status = 'completed',
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              last_error = NULL,
              result = $2::jsonb,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [
        commandId,
        JSON.stringify({
          ...(input?.result || {}),
          localFinalization: localFinalization ?? null
        })
      ]
    );
    return hydratedCommand(commandId);
  });
}
