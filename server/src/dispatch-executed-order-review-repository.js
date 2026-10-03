import { query, withTransaction } from "./db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { lockDispatchPlanEditLease } from "./dispatch-plan-lease-repository.js";
import { persistedDispatchPlan } from "./dispatch-plan-fence.js";
import { buildExecutedOrderReviews, buildPlannedOrderReviews, plannedOrderContexts, executedSourceDigest, executedChangeMessage, reconcileExecutedSourcePlan, reviewableSourceChanges, sourceReviewChangesDigest } from "./dispatch-executed-order-review.js";
import { evaluateExecutedPrefixPolicy } from "./dispatch-planner-performance.js";
import { preserveDispatchOrderAddress } from "./dispatch-address-guard.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";

const key = value => String(value || "").trim().toUpperCase();
const error = (message, code, status = 409) => Object.assign(new Error(message), { code, status });

async function recordedPlan(planId) {
  const result = await query(`SELECT p.id,p.plan_date,p.status,p.revision,p.note,s.orders,s.trucks,s.summary,s.saved_at
    FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [planId]);
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
  if (!refs.length) {return { plan, activity, reviews: [], publicReviews: [] };}
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
    const row = matching.find(record => record.acknowledged_at) || matching[0];
    return row ? [[row.token, notice]] : [];
  }));
  const publicReviews = records.filter(row => {
    if (!reviewableSourceChanges(row.changes).length) {return false;}
    const source = freshByRef.get(key(row.order_ref));
    if (!source) {return !row.acknowledged_at;}
    return notices.some(notice => matchesSourceNotice(row, notice))
      ? currentNotices.has(row.token) : row.source_digest === executedSourceDigest(source);
  }).map(row => ({ ...row.review, token: row.token, acknowledged: Boolean(row.acknowledged_at),
    changes: reviewableSourceChanges(row.changes),
    replanRequested: Boolean(currentNotices.get(row.token)?.replanRequested),
    observedAt: row.observed_at, acknowledgedAt: row.acknowledged_at, acknowledgedBy: row.actor_name,
    sourceAvailable: freshByRef.has(key(row.order_ref)) }));
  return { plan, activity, reviews, publicReviews };
}

export async function getDispatchExecutedOrderReviews(planId) {
  return (await reviewState(await recordedPlan(planId))).publicReviews;
}

export async function prepareDispatchExecutedOrderComparison({ previousPlan = {}, nextPlan = {}, activity } = {}) {
  const planId = previousPlan.id || previousPlan.planId || nextPlan.id || nextPlan.planId;
  if (!planId) {return previousPlan;}
  const plan = await recordedPlan(planId);
  const state = await reviewState(plan, activity);
  // The exception is proven against the current server mirror, never a browser
  // acknowledgement/force-save flag. Pending reviews do not block planning.
  const reconciled = reconcileExecutedSourcePlan({ previousPlan: plan, nextPlan, reviews: state.reviews });
  nextPlan.orders = reconciled.orders;
  nextPlan.trucks = reconciled.trucks;
  return reconcileExecutedSourcePlan({ previousPlan: plan, nextPlan: previousPlan, reviews: state.reviews });
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
