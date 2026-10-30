import { isDeepStrictEqual } from 'node:util';
import { digestDispatchPlan } from './dispatch-planner-performance.js';

const sourceFields = new Set(['items', 'address', 'destinationAddress', 'dropAddress', 'sourceYard', 'sourceAddress',
  'pickupLocations', 'destinationYard', 'destinationLocationId', 'toLocation', 'pallets', 'layers',
  'sections', 'pieces', 'salesQty', 'weight', 'committedQty', 'salesQuantities']);

function orderStructure(order) {
  return Object.fromEntries(Object.entries(order).filter(([field]) => !sourceFields.has(field))
    .map(([field, value]) => [field, field === 'childOrderDetails' && Array.isArray(value) ? value.map(orderStructure) : value]));
}

// The archive is evidence, not permission to relax a save fence. Every revision
// must be a source acceptance, and the original persisted digest must match.
export function dispatchSourceRefreshBaseline(plan, checkpoints, { baseRevision, baseDigest } = {}) {
  const revision = Number(baseRevision);
  const distance = Number(plan.revision) - revision;
  if (!Number.isSafeInteger(revision) || revision < 0 || !baseDigest || distance < 1 || distance > 100
    || checkpoints.length !== distance) {return null;}
  const structure = plan.orders.map(orderStructure);
  for (const [index, row] of checkpoints.entries()) {
    if (Number(row.revision) !== revision + index || row.archive_reason !== 'before_netsuite_source_acceptance'
      || !isDeepStrictEqual(row.trucks, plan.trucks) || !isDeepStrictEqual(row.summary, plan.summary)
      || !isDeepStrictEqual(row.orders.map(orderStructure), structure)) {return null;}
  }
  const baseline = { ...plan, revision, orders: checkpoints[0].orders, trucks: checkpoints[0].trucks, summary: checkpoints[0].summary };
  if (digestDispatchPlan(baseline) !== baseDigest) {return null;}
  return { revision, digest: baseDigest, orders: baseline.orders };
}
