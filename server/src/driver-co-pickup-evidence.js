import { planJobsForDriver } from "./driver-repository.js";
import { dispatchLocationsShareYard } from "./dispatch-location.js";

const text = value => String(value || "").trim();
const refSet = values => [...new Set((values || []).map(value => text(value).toLowerCase()))].sort();
const sameRefs = (left, right) => JSON.stringify(refSet(left)) === JSON.stringify(refSet(right));

function completedCorrection(record, order, corrections, location) {
  const matches = corrections.filter(row => row.co_ref === order.id
    && String(row.proof?.planId) === String(record.plan_id) && row.proof?.loadId === record.load_id
    && row.proof?.stopType === "drop");
  if (matches.length !== 1) {return null;}
  const row = matches[0];
  const pickupAt = new Date(record.completed_at).getTime();
  const createdAt = new Date(row.proof.coCreatedAt).getTime();
  const arrivedAt = new Date(row.completion_at).getTime();
  if (row.status !== "completed" || !row.completion_at || !Number.isFinite(pickupAt)
    || !Number.isFinite(createdAt) || !Number.isFinite(arrivedAt) || pickupAt < createdAt || pickupAt > arrivedAt
    || !dispatchLocationsShareYard(location, row.proof.fromYard)
    || !dispatchLocationsShareYard(location, row.from_location)
    || !sameRefs(order.childOrders, row.proof.sourceRefs)) {return null;}
  return row.proof.sourceRefs;
}

function canInterpretPickup(record, corrections) {
  return record.stop_type === "pickup" && record.status === "complete" && Boolean(record.completed_at)
    && Boolean(record.snapshot_orders) && Boolean(record.snapshot_trucks) && corrections.length > 0;
}

// Interpret only the old CO expansion bug, without editing historical evidence.
// Any extra/missing cargo or missing route/proof leaves the original blocker intact.
export function driverActivityOrderRefs(record, corrections = []) {
  const original = record.order_refs || [];
  if (!canInterpretPickup(record, corrections)) { return original; }
  const plan = { id: record.plan_id, planDate: record.plan_date,
    orders: record.snapshot_orders, trucks: record.snapshot_trucks };
  const jobs = planJobsForDriver(plan, record.driver_login).filter(job => job.jobId === record.job_id
    && job.loadId === record.load_id && job.stopId === record.stop_id && job.stopType === "pickup");
  if (jobs.length !== 1 || !dispatchLocationsShareYard(jobs[0].location, record.job_details?.location)) {return original;}
  const expected = jobs[0].orderRefs;
  let corrected = false;
  const legacy = expected.flatMap(ref => {
    const order = plan.orders.find(candidate => candidate.id === ref && candidate.type === "CO");
    const sources = order && completedCorrection(record, order, corrections, jobs[0].location);
    if (!sources) {return [ref];}
    corrected = true;
    return sources;
  });
  return corrected && sameRefs(legacy, original) ? expected : original;
}
