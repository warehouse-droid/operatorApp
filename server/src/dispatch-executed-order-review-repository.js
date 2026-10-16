import { query, withTransaction } from "./db.js";
import { dispatchSourceNoticeChanges } from "./dispatch-source-notice-policy.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { lockDispatchPlanEditLease } from "./dispatch-plan-lease-repository.js";
import { persistedDispatchPlan } from "./dispatch-plan-fence.js";
import { buildExecutedOrderReviews, buildPlannedOrderReviews, plannedOrderContexts, executedSourceDigest, executedChangeMessage, reconcileExecutedSourcePlan, reviewableSourceChanges, sourceReviewChangesDigest, applyDispatchSourceOrders, dispatchSourceChangePredatesWork, dispatchSourceReceiptMatchesOrder } from "./dispatch-executed-order-review.js";
import { isDeepStrictEqual } from "node:util";
import { evaluateExecutedPrefixPolicy, digestDispatchPlan, dispatchPlanBoard } from "./dispatch-planner-performance.js";
import { preserveDispatchOrderAddress } from "./dispatch-address-guard.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";

const key = value => String(value || "").trim().toUpperCase();
const error = (message, code, status = 409) => Object.assign(new Error(message), { code, status });

async function recordedPlan(planId, { lock = false } = {}) {
  const result = await query(`SELECT p.id,p.plan_date,p.status,p.revision,p.note,s.orders,s.trucks,s.summary,s.saved_at
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1 ${lock ? "FOR UPDATE OF p" : ""}`, [planId]);
  if (!result.rows[0]) {throw error("Dispatch plan not found.", "DISPATCH_PLAN_NOT_FOUND", 404);}
  return persistedDispatchPlan(result.rows[0]);
}

function nestedOrders(order) {
  return [order, ...(order.childOrderDetails || []).flatMap(nestedOrders)];
}

export function publicExecutedOrderReview(review) {
  const { beforeOrder: _before, sourceOrder: _source, ...result } = review;
  return { ...result, changes: result.changes.map(change => ({ ...change, message: executedChangeMessage(change) })) };
}

function matchesSourceNotice(row, notice) {
  return key(row.order_ref) === key(notice.orderRef)
    && sourceReviewChangesDigest(row.changes) === sourceReviewChangesDigest(notice.changes);
}

async function reviewState(plan, suppliedActivity) {
  const activity = suppliedActivity || (await query(`SELECT status,load_id,stop_id,stop_type,order_refs,job_details
    FROM driver_job_records WHERE plan_id=$1 AND status IN ('in_progress', 'complete') ORDER BY id`, [plan.id])).rows;
  const contexts = plannedOrderContexts(plan);
  const protectedRefs = new Set(contexts.map(context => key(context.orderRef)));
  const orders = (plan.orders || []).filter(order => protectedRefs.has(key(order.id))).flatMap(nestedOrders);
  const stored = (await query("SELECT * FROM dispatch_executed_order_reviews WHERE plan_id=$1 ORDER BY observed_at,token", [plan.id])).rows;
  const refs = [...new Set([...orders.map(order => order.id), ...stored.map(row => row.order_ref)].map(key).filter(Boolean))];
  if (!refs.length) {return { plan, activity, reviews: [], notices: [], sourceOrders: [], publicReviews: [] };}
  const { listDispatchOrders } = await import("./dispatch-repository.js");
  const sourceOrders = [];
  for (let offset = 0; offset < refs.length; offset += 200) {
    sourceOrders.push(...await listDispatchOrders({ exactOrderRefs: refs.slice(offset, offset + 200), includeHiddenScm: true,
      includeFulfilledSalesDeliveries: true, includeInactiveSalesOrderLines: false,
      includeAllDiscoverableScmPurchaseOrders: true, unboundedPerType: true }));
  }
  // Empty refresh values cannot erase a known delivery address, including inside groups.
  const previousByRef = new Map(orders.map(order => [key(order.id), order]));
  const protectedSources = sourceOrders.map(order => preserveDispatchOrderAddress(previousByRef.get(key(order.id)) || {}, order).order);
  const freshByRef = new Map(protectedSources.map(order => [key(order.id), order]));
  const reviews = buildExecutedOrderReviews({ previousPlan: plan, activity, sourceOrders: protectedSources });
  const notices = buildPlannedOrderReviews({ previousPlan: plan, activity, sourceOrders: protectedSources });
  for (const review of notices) {
    if (stored.some(row => matchesSourceNotice(row, review))) {continue;}
    const publicReview = publicExecutedOrderReview(review);
    await query(`INSERT INTO dispatch_executed_order_reviews (plan_id,token,order_ref,source_digest,review,changes)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT DO NOTHING`,
    [plan.id, review.token, key(review.orderRef), executedSourceDigest(review.sourceOrder), JSON.stringify(publicReview), JSON.stringify(publicReview.changes)]);
  }
  const records = notices.length ? (await query("SELECT * FROM dispatch_executed_order_reviews WHERE plan_id=$1 ORDER BY observed_at,token", [plan.id])).rows : stored;
  // Weight changes do not replace an existing notice or undo its acknowledgement.
  const currentNotices = new Map(notices.flatMap(notice => {
    const matching = records.filter(row => matchesSourceNotice(row, notice));
    const row = matching.find(record => record.decision) || matching.find(record => record.acknowledged_at) || matching[0];
    return row ? [[row.token, notice]] : [];
  }));
  const sourceTimes = await query(`SELECT DISTINCT ON (netsuite_order_id,record_type)
      netsuite_order_id,record_type,source_modified_at,received_at,completed_at,payload,status
    FROM netsuite_order_webhook_inbox
    WHERE netsuite_order_id=ANY($1::text[]) AND status='succeeded'
    ORDER BY netsuite_order_id,record_type,received_at DESC,id DESC`,
  [[...new Set(protectedSources.map(order => String(order.netsuiteId || "")).filter(Boolean))]]);
  const timeBySource = new Map(sourceTimes.rows.map(row => [`${row.record_type}:${row.netsuite_order_id}`, row]));
  const nativeIds = [...new Set(protectedSources.map(order => String(order.netsuiteId || "")).filter(id => /^[1-9]\d*$/u.test(id)))];
  const nativeAudits = nativeIds.length ? (await query(`SELECT actor_type,source,action,order_id,line_id,details,created_at
    FROM delivery_audit_log WHERE order_id=ANY($1::bigint[]) AND source='netsuite' AND actor_type='system'
    AND action IN ('netsuite.order.update','netsuite.line.update','netsuite.receiving_order.update','netsuite.receiving_line.update')
    AND created_at >= (SELECT created_at FROM dispatch_plans WHERE id=$2) ORDER BY created_at,id`, [nativeIds, plan.id])).rows : [];
  const plannedRefs = new Set(orders.map((/** @type {any} */ order) => key(order.id)));
  const publicReviews = records.filter(row => {
    if (!reviewableSourceChanges(row.changes).length) {return false;}
    const source = freshByRef.get(key(row.order_ref));
    if (!source) {return !row.acknowledged_at;}
    return notices.some(notice => matchesSourceNotice(row, notice))
      ? currentNotices.has(row.token) : row.source_digest === executedSourceDigest(source);
  }).map(row => {
    const source = freshByRef.get(key(row.order_ref));
    const recordType = { SO: "sales_order", PO: "purchase_order", TO: "transfer_order" }[source?.type];
    const timestamps = timeBySource.get(`${recordType}:${source?.netsuiteId}`);
    const noticeChanges = dispatchSourceNoticeChanges({ source, beforeOrder: currentNotices.get(row.token)?.beforeOrder || previousByRef.get(key(row.order_ref)),
      changes: reviewableSourceChanges(row.changes), receipt: timestamps, audits: nativeAudits });
    return { ...row.review, token: row.token, acknowledged: Boolean(row.acknowledged_at),
    changes: reviewableSourceChanges(row.changes),
    contexts: currentNotices.get(row.token)?.contexts || row.review.contexts,
    replanRequested: Boolean(currentNotices.get(row.token)?.replanRequested),
    observedAt: row.observed_at, acknowledgedAt: row.acknowledged_at, acknowledgedBy: row.actor_name,
    decision: row.decision || null, decisionRequired: !row.decision, decidedAt: row.decided_at || null,
    sourceModifiedAt: timestamps?.source_modified_at || null, sourceReceivedAt: timestamps?.received_at || null,
    sourceAppliedAt: timestamps?.completed_at || null,
    sourceReceiptVerified: Boolean(timestamps && dispatchSourceReceiptMatchesOrder(source, timestamps.payload, row.changes)),
    sourceAvailable: Boolean(source),
    notifyDispatcher: plannedRefs.has(key(row.order_ref)) && noticeChanges.length > 0,
    noticeChanges };
  });
  return { plan, activity, reviews, notices, sourceOrders: protectedSources, publicReviews };
}

export async function getDispatchExecutedOrderReviews(planId) {
  return (await automaticallyAcceptPreExecutionSourceReviews(planId)).publicReviews;
}

export async function getDispatchSourceReviewPayload(planId, { baseRevision } = {}) {
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const previous = await recordedPlan(planId);
    const reviews = await getDispatchExecutedOrderReviews(planId);
    const plan = await recordedPlan(planId);
    const resolved = reviews.filter(review => review.decision === "protect_driver_work"
      || (review.decision === "accept_netsuite_change" && !review.acknowledged));
    const refs = new Set(resolved.flatMap(review => [key(review.orderRef), key(review.groupRef)]).filter(Boolean));
    return { reviews, orderRefs: resolved.map(review => review.orderRef),
      ...(resolved.length ? { orders: plan.orders.filter(order => nestedOrders(order).some(child => refs.has(key(child.id)))),
        plan: { id: plan.id, revision: plan.revision, digest: plan.digest, savedAt: plan.savedAt,
          safeToAdvanceRevision: baseRevision !== undefined && Number(baseRevision) === previous.revision } } : {}) };
  });
}

async function automaticallyAcceptPreExecutionSourceReviews(planId) {
  const initial = await reviewState(await recordedPlan(planId));
  if (!initial.publicReviews.some(review => review.decisionRequired && review.sourceAvailable && review.sourceAppliedAt && review.sourceReceiptVerified)) {return initial;}
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const plan = await recordedPlan(planId, { lock: true });
    await lockSourceMirrorRows(plan, initial.publicReviews.map(review => review.token));
    const activity = (await query(`SELECT status,load_id,stop_id,stop_type,order_refs,job_details,started_at,created_at
      FROM driver_job_records WHERE plan_id=$1 AND status IN ('in_progress','complete') ORDER BY id`, [planId])).rows;
    const state = await reviewState(plan, activity);
    const selected = state.publicReviews.filter(review => review.decisionRequired && review.sourceAvailable && review.sourceReceiptVerified
      && dispatchSourceChangePredatesWork(review, activity));
    if (!selected.length) {return state;}
    const sessionId = "netsuite-before-driver-work";
    const next = await persistAcceptedSourcePlan(plan, applyDispatchSourceOrders(plan, state.sourceOrders, selected.map(review => review.orderRef)), sessionId);
    for (const review of selected) {
      await query(`UPDATE dispatch_executed_order_reviews SET decision='accept_netsuite_change',decided_at=now(),
        acknowledged_at=NULL,actor_id=NULL,actor_name='NetSuite (before driver work)' WHERE plan_id=$1 AND token=$2 AND decision IS NULL`,
      [planId, review.token]);
      await writeDispatchAudit({ action: "dispatch_source_change_auto_accepted", entityType: "order", entityId: review.orderRef,
        orderId: review.orderRef, planId, planDate: plan.planDate, sessionId, before: plan.orders, after: next.orders,
        details: { token: review.token, decision: "accept_netsuite_change", contexts: review.contexts,
          changes: review.changes, sourceModifiedAt: review.sourceModifiedAt, sourceReceivedAt: review.sourceReceivedAt,
          sourceAppliedAt: review.sourceAppliedAt, previousAcknowledgedAt: review.acknowledgedAt,
          previousAcknowledgedBy: review.acknowledgedBy, dispatchAcknowledgementRequired: true } });
    }
    return reviewState(next, activity);
  });
}

export async function prepareDispatchExecutedOrderComparison({ previousPlan = {}, nextPlan = {}, activity } = {}) {
  const planId = previousPlan.id || previousPlan.planId || nextPlan.id || nextPlan.planId;
  if (!planId) {return previousPlan;}
  const plan = await recordedPlan(planId);
  const state = await reviewState(plan, activity);
  // The exception is proven against the current server mirror, never a browser
  // acknowledgement/force-save flag. Pending reviews do not block planning.
  const protectedNotices = state.notices.filter(notice => state.publicReviews.some(review =>
    review.decision === "protect_driver_work" && key(review.orderRef) === key(notice.orderRef)
    && sourceReviewChangesDigest(review.changes) === sourceReviewChangesDigest(notice.changes)));
  const reviews = [...state.reviews, ...protectedNotices.filter(notice => !state.reviews.some(review => review.token === notice.token))];
  const reconciled = reconcileExecutedSourcePlan({ previousPlan: plan, nextPlan, reviews });
  nextPlan.orders = reconciled.orders;
  nextPlan.trucks = reconciled.trucks;
  return reconcileExecutedSourcePlan({ previousPlan: plan, nextPlan: previousPlan, reviews });
}

async function lockSourceMirrorRows(plan, tokens) {
  const stored = (await query("SELECT order_ref FROM dispatch_executed_order_reviews WHERE plan_id=$1 AND token=ANY($2::text[])", [plan.id, tokens])).rows;
  const refs = [...new Set([...plan.orders.flatMap(nestedOrders).map(order => key(order.id)), ...stored.map(row => key(row.order_ref))])];
  for (const [table, lines, foreignKey] of [["sales_orders", "sales_order_lines", "sales_order_id"],
    ["purchase_orders", "purchase_order_lines", "purchase_order_id"], ["transfer_orders", "transfer_order_lines", "transfer_order_id"]]) {
    const rows = (await query(`SELECT netsuite_id FROM ${table} WHERE upper(tranid)=ANY($1::text[]) ORDER BY netsuite_id FOR SHARE`, [refs])).rows;
    if (rows.length) {
      await query(`SELECT id FROM ${lines} WHERE ${foreignKey}=ANY($1::bigint[]) ORDER BY id FOR SHARE`, [rows.map(row => row.netsuite_id)]);
    }
  }
}

async function persistAcceptedSourcePlan(previous, next, sessionId) {
  if (isDeepStrictEqual(previous.orders, next.orders)) {return previous;}
  const counts = dispatchPlanBoard(next);
  await query(`INSERT INTO dispatch_plan_snapshot_history
    (plan_id,plan_date,revision,orders,trucks,summary,original_saved_at,archive_reason,session_id)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,'before_netsuite_source_acceptance',$8)`,
  [previous.id, previous.planDate, previous.revision, JSON.stringify(previous.orders), JSON.stringify(previous.trucks),
    JSON.stringify(previous.summary), previous.savedAt, sessionId]);
  const updated = (await query("UPDATE dispatch_plans SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING revision", [previous.id])).rows[0];
  next = { ...next, revision: Number(updated.revision), digest: digestDispatchPlan(next) };
  const snapshot = (await query(`UPDATE dispatch_plan_snapshots SET orders=$2::jsonb,saved_at=now(),plan_digest=$3,
    order_count=$4,truck_count=$5,load_count=$6,stop_count=$7 WHERE plan_id=$1 RETURNING saved_at`,
  [next.id, JSON.stringify(next.orders), next.digest, counts.orderRefs.length, counts.truckCount, counts.loadCount, counts.stopCount])).rows[0];
  next.savedAt = snapshot.saved_at;
  const { syncDispatchDeliveryGroupsFromPlan } = await import("./dispatch-delivery-group-repository.js");
  const { syncDispatchPlanOrderAssignments, syncDispatchPlanRelationEdges } = await import("./dispatch-planner-v2-repository.js");
  await syncDispatchDeliveryGroupsFromPlan(next);
  await syncDispatchPlanOrderAssignments(next);
  await syncDispatchPlanRelationEdges(next);
  return next;
}

export async function resolveDispatchSourceOrderReviews({ planId, tokens, decision, actorId, actorName = "", editLease, baseRevision } = {}) {
  if (!["protect_driver_work", "accept_netsuite_change"].includes(decision)) {
    throw error("Choose Protect driver work or Accept NetSuite change.", "DISPATCH_SOURCE_DECISION_INVALID", 400);
  }
  if (!actorId || !editLease?.token || !editLease?.sessionId) {
    throw error("Enter Edit Mode to confirm source updates.", "DISPATCH_PLAN_EDIT_LEASE_REQUIRED");
  }
  if (!Array.isArray(tokens) || !tokens.length || tokens.length > 200 || tokens.some(token => typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token))) {
    throw error("Select the displayed source updates to confirm.", "DISPATCH_EXECUTED_SOURCE_REVIEW_INVALID", 400);
  }
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const plan = await recordedPlan(planId, { lock: true });
    await lockDispatchPlanEditLease({ ...editLease, planDate: plan.planDate, operatorId: actorId });
    await lockSourceMirrorRows(plan, tokens);
    const state = await reviewState(plan);
    const selected = [...new Set(tokens)].map(token => state.publicReviews.find(review => review.token === token && review.sourceAvailable));
    if (selected.some(review => !review)) {
      throw error("Source information changed again. Review the latest values before confirming.", "DISPATCH_EXECUTED_SOURCE_REVIEW_STALE");
    }
    if (selected.some(review => review.decision && review.decision !== decision)) {
      throw error("This source change already has a different decision. Refresh to see the recorded choice.", "DISPATCH_SOURCE_DECISION_ALREADY_RESOLVED");
    }
    const pending = selected.filter(review => !review.decision);
    if (pending.length && (baseRevision === null || baseRevision === undefined || baseRevision === "" || Number(baseRevision) !== plan.revision)) {
      throw error("The plan changed. Review the latest plan before choosing how to resolve this source change.", "DISPATCH_SOURCE_DECISION_PLAN_STALE");
    }
    let next = plan;
    if (pending.length && decision === "accept_netsuite_change") {
      next = await persistAcceptedSourcePlan(plan, applyDispatchSourceOrders(plan, state.sourceOrders, pending.map(review => review.orderRef)), editLease.sessionId);
    }
    for (const review of pending) {
      await query(`UPDATE dispatch_executed_order_reviews SET decision=$3,decided_at=now(),acknowledged_at=now(),actor_id=$4,actor_name=$5
        WHERE plan_id=$1 AND token=$2 AND decision IS NULL`, [planId, review.token, decision, actorId, actorName]);
      await writeDispatchAudit({ action: "dispatch_source_change_resolved", entityType: "order", entityId: review.orderRef,
        orderId: review.orderRef, planId, planDate: plan.planDate, operatorId: actorId, operatorName: actorName,
        sessionId: editLease.sessionId, before: plan.orders, after: next.orders,
        details: { token: review.token, decision, contexts: review.contexts, changes: review.changes,
          sourceModifiedAt: review.sourceModifiedAt, sourceReceivedAt: review.sourceReceivedAt } });
    }
    const refs = new Set(selected.flatMap(review => [key(review.orderRef), key(review.groupRef)]).filter(Boolean));
    return { reviews: (await reviewState(next)).publicReviews,
      orderRefs: selected.map(review => review.orderRef),
      orders: next.orders.filter(order => nestedOrders(order).some(child => refs.has(key(child.id)))),
      plan: { id: next.id, revision: next.revision, digest: next.digest, savedAt: next.savedAt,
        safeToAdvanceRevision: Number(baseRevision) === plan.revision } };
  });
}

export async function evaluateDispatchReviewedPrefix({ previousPlan = {}, nextPlan = {}, activity } = {}) {
  const planId = previousPlan.id || previousPlan.planId;
  const statuses = activity || (await query(`SELECT status,load_id,stop_id,stop_type,order_refs,job_details
    FROM driver_job_records WHERE plan_id=$1 AND status IN ('in_progress', 'complete') ORDER BY id`, [planId])).rows;
  const comparison = await prepareDispatchExecutedOrderComparison({ previousPlan, nextPlan, activity: statuses });
  return evaluateExecutedPrefixPolicy({ previousPlan: comparison, nextPlan, activity: statuses });
}

export async function acknowledgeDispatchExecutedOrderReviews({ planId, tokens, actorId, actorName = "", editLease } = {}) {
  if (!actorId || !editLease?.token || !editLease?.sessionId) {throw error("Enter Edit Mode to confirm source updates.", "DISPATCH_PLAN_EDIT_LEASE_REQUIRED");}
  if (!Array.isArray(tokens) || !tokens.length || tokens.length > 200 || tokens.some(token => typeof token !== "string" || !/^[a-f0-9]{64}$/u.test(token))) {
    throw error("Select the displayed source updates to confirm.", "DISPATCH_EXECUTED_SOURCE_REVIEW_INVALID", 400);
  }
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    const plan = await recordedPlan(planId);
    await lockDispatchPlanEditLease({ ...editLease, planDate: plan.planDate, operatorId: actorId });
    const state = await reviewState(plan);
    const selected = [...new Set(tokens)].map(token => state.publicReviews.find(review => review.token === token && review.sourceAvailable));
    if (selected.some(review => !review)) {throw error("Source information changed again. Review the latest values before confirming.", "DISPATCH_EXECUTED_SOURCE_REVIEW_STALE");}
    for (const review of selected.filter(candidate => !candidate.acknowledged)) {
      await query(`UPDATE dispatch_executed_order_reviews SET acknowledged_at=now(),actor_id=$3,actor_name=$4
        WHERE plan_id=$1 AND token=$2 AND acknowledged_at IS NULL`, [planId, review.token, actorId, actorName]);
      await writeDispatchAudit({ action: "dispatch_executed_source_update_acknowledged", entityType: "order", entityId: review.orderRef,
        orderId: review.orderRef, planId, planDate: plan.planDate, operatorId: actorId, operatorName: actorName,
        sessionId: editLease.sessionId, after: review.changes, details: { token: review.token, contexts: review.contexts } });
    }
    return (await reviewState(plan)).publicReviews;
  });
}
