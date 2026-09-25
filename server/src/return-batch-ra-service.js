import { query, withTransaction, withIndependentTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { createOrUpdateReturnAuthorizationInNetSuite, createStandaloneReturnAuthorizationInNetSuite,
  fetchReturnAuthorizationFromNetSuite, suiteqlAll } from "./netsuite.js";
import { findReturnTransactionByExternalId } from "./return-netsuite.js";
import { withNetSuiteOperationalWork } from "./netsuite-operational-work.js";
import { buildReturnBatchIntent, buildReturnBatchPayload, verifyReturnBatchSnapshot, hydrateReturnBatchSourceLinks } from "./return-batch-ra-domain.js";

function error(message, code = "RETURN_BATCH_RA_BLOCKED") {
  return Object.assign(new Error(message), { status: 409, code });
}

export async function findReturnBatchAuthorization(recordId) {
  const result = await query(`SELECT a.* FROM return_batch_authorizations a
    JOIN return_records r ON r.batch_id=a.batch_id WHERE r.id=$1`, [recordId]);
  return result.rows[0] || null;
}

export async function admitReturnBatchAuthorization({ records, postingPolicies }) {
  const intent = buildReturnBatchIntent(records);
  const effective = records.every(record => {
    const policy = postingPolicies[`${record.recordType}_return`];
    return policy?.effective === true && Number(policy.locationId) === intent.receivingLocationId
      && policy.functionKey === `${record.recordType}_return`;
  });
  if (records.some(record => record.netSuiteTransactionId || record.netSuiteRaAttemptedAt)) {
    throw error("A return already has a NetSuite transaction or an uncertain creation attempt.");
  }
  const result = await query(`INSERT INTO return_batch_authorizations
    (batch_id,external_id,intent_snapshot,posting_policy,sync_status)
    VALUES($1,$2,$3::jsonb,$4::jsonb,$5) RETURNING *`, [intent.batchId, intent.externalId, JSON.stringify(intent),
    JSON.stringify({ effective, locationId: intent.receivingLocationId, components: postingPolicies }), effective ? "pending" : "disabled"]);
  await query("UPDATE return_records SET netsuite_sync_status=$2 WHERE batch_id=$1", [intent.batchId, result.rows[0].sync_status]);
  return result.rows[0];
}

async function checkpoint(callback) { return withIndependentTransaction(callback); }

function transactionStatusOf(snapshot) {
  if (!snapshot) {return null;}
  return String(snapshot.status?.refName ?? snapshot.status?.id ?? snapshot.status ?? "");
}

function transactionRefOf(snapshot) { return snapshot?.tranId || snapshot?.tranid || null; }

async function setState(batchId, status, { message = null, snapshot = null, resetAttempt = false, actorOperatorId = null } = {}) {
  const reference = transactionRefOf(snapshot);
  const transactionStatus = transactionStatusOf(snapshot);
  await checkpoint(async q => {
    await q(`UPDATE return_batch_authorizations SET sync_status=$2,sync_error=$3,
      netsuite_transaction_ref=COALESCE($4,netsuite_transaction_ref),
      netsuite_transaction_status=COALESCE($5,netsuite_transaction_status),
      netsuite_snapshot=COALESCE($6::jsonb,netsuite_snapshot),
      attempted_at=CASE WHEN $7 THEN NULL ELSE attempted_at END,last_synced_at=now(),updated_at=now()
      WHERE batch_id=$1`, [batchId, status, message, reference, transactionStatus, snapshot ? JSON.stringify(snapshot) : null, resetAttempt]);
    await q(`UPDATE return_records r SET netsuite_sync_status=a.sync_status,netsuite_sync_error=a.sync_error,
      netsuite_transaction_ref=a.netsuite_transaction_ref,netsuite_transaction_status=a.netsuite_transaction_status,
      netsuite_stage=CASE WHEN a.netsuite_transaction_id IS NOT NULL THEN 'return_authorization' ELSE r.netsuite_stage END,
      netsuite_snapshot=a.netsuite_snapshot,netsuite_last_synced_at=a.last_synced_at,updated_at=now()
      FROM return_batch_authorizations a WHERE a.batch_id=$1 AND r.batch_id=a.batch_id`, [batchId]);
    await q(`INSERT INTO return_sync_events(return_record_id,event_type,status,request_snapshot,response_snapshot,error,actor_operator_id)
      SELECT id,'batch_return_authorization',$2,jsonb_build_object('batchId',$1::bigint),$3::jsonb,$4,$5
      FROM return_records WHERE batch_id=$1`, [batchId, status, JSON.stringify({ reference }), message, actorOperatorId]);
  });
}

async function identify(batchId, transactionId) {
  const id = Number(transactionId);
  if (!Number.isSafeInteger(id) || id <= 0) {throw error("NetSuite Return Authorization creation is unconfirmed.", "RETURN_RA_CREATION_UNCERTAIN");}
  await checkpoint(q => q(`UPDATE return_batch_authorizations SET netsuite_transaction_id=$2,updated_at=now()
    WHERE batch_id=$1 AND (netsuite_transaction_id IS NULL OR netsuite_transaction_id=$2) RETURNING batch_id`, [batchId, id])
    .then(result => {
      if (!result.rowCount) {throw error("This return batch already has a different Return Authorization.");}
    }));
  return id;
}

async function markAttempt(batchId) {
  await checkpoint(async q => {
    const marked = await q(`UPDATE return_batch_authorizations SET attempted_at=now(),sync_attempts=sync_attempts+1,
      sync_status='pending',sync_error=NULL,updated_at=now()
      WHERE batch_id=$1 AND attempted_at IS NULL AND netsuite_transaction_id IS NULL RETURNING batch_id`, [batchId]);
    if (!marked.rowCount) {throw error("NetSuite Return Authorization creation is unconfirmed.", "RETURN_RA_CREATION_UNCERTAIN");}
    await q("UPDATE return_records SET netsuite_sync_attempts=netsuite_sync_attempts+1 WHERE batch_id=$1", [batchId]);
  });
}

function definiteRejection(problem) {
  return problem.netsuiteResponseReceived === true && [400, 401, 403, 404, 422].includes(Number(problem.status))
    && !(problem.netsuiteErrorCodes || []).some(code => /DUP|EXIST/i.test(code));
}

async function postOrRecover(batch) {
  const intent = batch.intent_snapshot;
  let found = batch.netsuite_transaction_id;
  if (!found) {found = (await findReturnTransactionByExternalId(batch.external_id, "return_authorization"))?.id;}
  if (!found) {
    if (batch.attempted_at) {throw error("NetSuite RA creation is unconfirmed. Recheck this return; another RA will not be created.", "RETURN_RA_CREATION_UNCERTAIN");}
    await markAttempt(batch.batch_id);
    try {
      const payload = buildReturnBatchPayload(intent);
      const created = intent.sourceSalesOrderId
        ? await createOrUpdateReturnAuthorizationInNetSuite({ salesOrderId: intent.sourceSalesOrderId, payload })
        : await createStandaloneReturnAuthorizationInNetSuite(payload);
      found = created.id || (await findReturnTransactionByExternalId(batch.external_id, "return_authorization"))?.id;
    } catch (problem) {
      problem.returnRaCreationRejected = definiteRejection(problem);
      throw problem;
    }
  }
  const transactionId = await identify(batch.batch_id, found);
  const snapshot = await readBatchSnapshot(batch, transactionId);
  return { transactionId, snapshot };
}

async function readBatchSnapshot(batch, transactionId) {
  const snapshot = await fetchReturnAuthorizationFromNetSuite(transactionId);
  if (!snapshot) {throw error("The NetSuite Return Authorization could not be read back.");}
  const intent = batch.intent_snapshot;
  if (!intent.sourceSalesOrderId || snapshot.item?.items?.some(row => row.orderLine || row.orderline)) {return snapshot;}
  const links = await suiteqlAll(`/* return_batch_source_links */
    SELECT source_tl.uniquekey AS source_line_id, source_tl.id AS source_order_line,
      source_tl.units AS source_units_id, next_tl.id AS return_line_id
    FROM NextTransactionLineLink source_link
    JOIN transactionline source_tl ON source_tl.transaction=source_link.previousdoc AND source_tl.id=source_link.previousline
    JOIN transactionline next_tl ON next_tl.transaction=source_link.nextdoc AND next_tl.id=source_link.nextline
    WHERE source_link.previousdoc=${Number(intent.sourceSalesOrderId)} AND source_link.nextdoc=${Number(transactionId)}
      AND next_tl.mainline='F' AND next_tl.item IS NOT NULL
      AND (next_tl.taxline='F' OR next_tl.taxline IS NULL)`);
  return hydrateReturnBatchSourceLinks(intent, snapshot, links);
}

async function activeMembers(batch) {
  const result = await query("SELECT id,status FROM return_records WHERE batch_id=$1 ORDER BY id", [batch.batch_id]);
  const ids = result.rows.map(row => Number(row.id));
  if (JSON.stringify(ids) !== JSON.stringify(batch.intent_snapshot.recordIds)
      || result.rows.some(row => ["voided", "rejected", "pending_approval", "partially_pending"].includes(row.status))) {
    throw error("This return batch changed or has unfinished decisions; its Return Authorization cannot be posted.");
  }
}

async function verifyManualCandidate(batch, manualTransactionId, manualTransactionRef) {
  if (batch.netsuite_transaction_id && Number(batch.netsuite_transaction_id) !== Number(manualTransactionId)) {
    throw error("This return batch already has a different Return Authorization.");
  }
  const candidate = await readBatchSnapshot(batch, manualTransactionId);
  verifyReturnBatchSnapshot({ ...batch.intent_snapshot, netSuiteTransactionId: manualTransactionId }, candidate);
  if (manualTransactionRef && String(transactionRefOf(candidate)).toUpperCase() !== String(manualTransactionRef).trim().toUpperCase()) {
    throw error("NetSuite Return Authorization number does not match.");
  }
  await identify(batch.batch_id, manualTransactionId);
  return { transactionId: manualTransactionId, snapshot: candidate };
}

export async function synchronizeReturnBatchAuthorization({ recordId, actorOperatorId = null, reconcile = false, manualTransactionId = null, manualTransactionRef = "" }) {
  const initial = await findReturnBatchAuthorization(recordId);
  if (!initial) {throw error("Shared Return Authorization was not found.");}
  const outcome = await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [`return-batch-ra:${initial.batch_id}`]);
    const batch = await findReturnBatchAuthorization(recordId);
    if (!reconcile && !manualTransactionId && ["succeeded", "manual_linked"].includes(batch.sync_status)) {return {};}
    if (batch.posting_policy.effective !== true) {return { error: error("This return was saved locally and was not admitted for NetSuite posting.") };}
    try {
      await activeMembers(batch);
      const { transactionId, snapshot } = await withNetSuiteOperationalWork(
        reconcile ? "returns.reconcile" : "returns.pending", () => manualTransactionId
          ? verifyManualCandidate(batch, manualTransactionId, manualTransactionRef) : postOrRecover(batch));
      verifyReturnBatchSnapshot({ ...batch.intent_snapshot, netSuiteTransactionId: transactionId }, snapshot, { allowInactive: reconcile || Boolean(batch.netsuite_transaction_id) });
      const inactive = /cancel|void|reject/i.test(transactionStatusOf(snapshot));
      await setState(batch.batch_id, inactive ? "cancelled" : manualTransactionId ? "manual_linked" : "succeeded", { snapshot, actorOperatorId });
      await writeAudit({ actorOperatorId, source: "returns", action: "returns.netsuite.batch_ra.linked",
        orderId: batch.intent_snapshot.sourceSalesOrderId,
        details: { batchId: Number(batch.batch_id), recordIds: batch.intent_snapshot.recordIds, transactionId,
          transactionRef: transactionRefOf(snapshot), receivingLocationId: batch.intent_snapshot.receivingLocationId } });
      return {};
    } catch (problem) {
      await setState(batch.batch_id, "failed", { message: String(problem.message || problem).slice(0, 4000),
        resetAttempt: problem.returnRaCreationRejected === true, actorOperatorId });
      return { error: problem };
    }
  });
  if (outcome.error) {throw outcome.error;}
  return findReturnBatchAuthorization(recordId);
}

export async function assertSharedReturnCanVoid(recordId) {
  const batch = await findReturnBatchAuthorization(recordId);
  if (!batch) {return;}
  await query("SELECT pg_advisory_xact_lock(hashtext($1))", [`return-batch-ra:${batch.batch_id}`]);
  const current = await findReturnBatchAuthorization(recordId);
  if (current.attempted_at && !current.netsuite_transaction_id) {
    throw error("NetSuite RA creation is unconfirmed. Recover the transaction before voiding this return.", "RETURN_RA_CREATION_UNCERTAIN");
  }
  if (current.netsuite_transaction_id && current.sync_status !== "cancelled") {
    throw error(`Cancel or void NetSuite Return Authorization ${current.netsuite_transaction_ref || current.netsuite_transaction_id} before voiding this return.`);
  }
}
