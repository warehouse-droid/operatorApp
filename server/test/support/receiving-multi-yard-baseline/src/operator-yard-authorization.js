// @ts-check
import { query } from "./db.js";
import { getConsolidatedLoad } from "./consolidation-load-repository.js";
import { getDeliveryOrder } from "./delivery-repository.js";
import { getReceivingOrder, getLocalCoReceivingOrder } from "./receiving-repository.js";
import { getPublicOperatorNetSuitePostingCommand } from "./operator-netsuite-posting-controller.js";
import { assertOperatorYard, deliveryOrderWithinYards, operatorYardLocationIds, requireAssignedOperatorYards, operatorYardForbidden } from "./operator-yard-access.js";
import { operatorRequestPath, operatorRouteId } from "./operator-yard-route.js";
import { outboundOrderYards, outboundYardLocationId } from './outbound-location-domain.js';
import { ensureOutboundLocationDirectory } from './outbound-location-runtime.js';

/** @param {any} row */
function found(row) {
  if (!row) throw Object.assign(new Error("Operator record not found."), { status: 404 });
  return row;
}

/** @param {import("./operator-yard-access.js").OperatorYardAccount} operator @param {any} id */
export async function assertOperatorOrderYard(operator, id, { receiving = false, orderType = "" } = {}) {
  let order;
  if (receiving) {
    const local = orderType === "co_order" || String(id).startsWith("CO-");
    order = local ? await getLocalCoReceivingOrder(id) : await getReceivingOrder(id, { includeNetSuiteClosed: true });
    // SCM split POs and TOs also use negative IDs. Resolve those before the
    // legacy local CO fallback, matching the receiving detail route.
    if (!order && !local && Number(id) < 0) {
      order = await getLocalCoReceivingOrder(id);
    }
  } else {
    await ensureOutboundLocationDirectory();
    order = await getDeliveryOrder(id, { includeNetSuiteClosed: true });
  }
  found(order);
  if (receiving) {
    assertOperatorYard(operator, order.destination_location_id);
    assertOperatorChildOrderYards(operator, order);
  } else {
    if (!deliveryOrderWithinYards(order, operatorYardLocationIds(operator))) throw operatorYardForbidden();
    for (const yard of outboundOrderYards(order)) assertOperatorYard(operator, yard);
  }
  return order;
}

/** @param {import("./operator-yard-access.js").OperatorYardAccount} operator @param {any} order */
function assertOperatorChildOrderYards(operator, order) {
  for (const child of order.child_orders || []) assertOperatorYard(operator, child.outbound_location_id ?? child.source_location_id);
}

/** @param {import("./operator-yard-access.js").OperatorYardAccount} operator @param {Record<string, any>} [body] */
export async function assertOperatorUploadYard(operator, body = {}) {
  requireAssignedOperatorYards(operator);
  if (body.recordType === "operator-consolidation-load-photo") {
    const batch = await getConsolidatedLoad(operator, body.orderId);
    if (batch.status !== "draft") throw Object.assign(new Error("This load already has its photo evidence."), { status: 409 });
    for (const order of batch.snapshot.orders) await assertOperatorOrderYard(operator, order.netsuite_id);
    body.orderRef = batch.id;
    body.source = "operator";
    return batch.locationId;
  }
  if (body.recordType === "operator-return-photo" || body.recordType === "operator-damage-photo") return assertOperatorYard(operator, body.locationId);
  if (!body.orderId) throw Object.assign(new Error("An order is required for this photo."), { status: 400 });
  const order = await assertOperatorOrderYard(operator, body.orderId, {
    receiving: String(body.recordType).includes("receiving"), orderType: body.orderType
  });
  return String(body.recordType).includes('receiving') ? Number(order.destination_location_id)
    : outboundYardLocationId(order.outbound_location_id ?? order.source_location_id);
}

/** @param {import("./operator-yard-access.js").OperatorYardAccount} operator @param {string} reference */
export async function assertOperatorOrderPhotoYard(operator, reference) {
  requireAssignedOperatorYards(operator);
  const parts = String(reference).replace(/^r2:\/\//, "").split("/");
  if (parts[0] === "operator" && parts[1] === "operator-consolidation-load-photo") {
    const batch = await getConsolidatedLoad(operator, parts[5]);
    for (const order of batch.snapshot.orders) await assertOperatorOrderYard(operator, order.netsuite_id);
    return;
  }
  const receiving = String(parts[1]).includes("receiving");
  if (parts[0] !== "operator" || !/^operator-(?:load|customer-pickup|(?:co-)?receiving)-photo$/.test(parts[1] || "")) throw operatorYardForbidden();
  const ref = parts[5];
  const result = await query(`SELECT netsuite_id::text AS id FROM sales_orders WHERE tranid=$1
    UNION ALL SELECT netsuite_id::text FROM transfer_orders WHERE tranid=$1
    UNION ALL SELECT netsuite_id::text FROM purchase_orders WHERE tranid=$1`, [ref]);
  await assertOperatorOrderYard(operator, result.rows[0]?.id || ref, { receiving });
}

/** @param {any} req @param {string[]} keys */
function suppliedYards(req, keys) {
  for (const input of [req.query, req.body]) {
    for (const key of keys) {
      if (input?.[key] !== undefined) assertOperatorYard(req.operator, input[key]);
    }
  }
}

/** @param {any} req @param {string[]} [keys] */
function selectedYard(req, keys = ["locationId"]) {
  suppliedYards(req, keys);
  const value = keys.flatMap((key) => [req.body?.[key], req.query?.[key]]).find((id) => id !== undefined);
  return assertOperatorYard(req.operator, value);
}

/** @param {any} req @param {string} kind @param {string} id */
async function assertConsolidationYard(req, kind, id) {
  const result = kind === "batches"
    ? await query("SELECT id, location_id FROM operator_consolidation_batches WHERE id=$1 AND operator_id=$2", [id, req.operator.id])
    : await query(`SELECT b.id, b.location_id FROM operator_consolidation_orders o
        JOIN operator_consolidation_batches b ON b.id=o.batch_id WHERE o.id=$1 AND b.operator_id=$2`, [id, req.operator.id]);
  const batch = found(result.rows[0]);
  assertOperatorYard(req.operator, batch.location_id);
  await assertConsolidationOrderYards(req.operator, batch.id);
}

/** @param {import("./operator-yard-access.js").OperatorYardAccount} operator @param {any} batchId */
async function assertConsolidationOrderYards(operator, batchId) {
  const result = await query("SELECT order_key FROM operator_consolidation_orders WHERE batch_id=$1", [batchId]);
  for (const row of result.rows) {
    const order = await getDeliveryOrder(row.order_key, { includeNetSuiteClosed: true });
    if (order && !deliveryOrderWithinYards(order, operatorYardLocationIds(operator))) throw operatorYardForbidden();
  }
}

/** @param {import("./operator-yard-access.js").OperatorYardAccount} operator @param {any} command */
export async function assertOperatorPostingJobYard(operator, command) {
  found(command);
  if (String(command.actorOperatorId) !== String(operator.id) && !operator.roles?.includes("admin") && operator.role !== "admin") {
    throw operatorYardForbidden("This job belongs to another operator.");
  }
  assertOperatorYard(operator, command.locationId);
}

/** @param {any} req @param {Map<string, any>} jobs @param {string} id @param {boolean} receiving */
async function assertJobYard(req, jobs, id, receiving) {
  const job = jobs.get(id);
  if (!job) return assertOperatorPostingJobYard(req.operator, await getPublicOperatorNetSuitePostingCommand(id));
  if (job.operatorId && job.operatorId !== req.operator.id && !req.operator.roles?.includes("admin")) throw operatorYardForbidden();
  await assertOperatorOrderYard(req.operator, job.orderId, { receiving });
}

/** @param {import("./operator-yard-access.js").OperatorYardAccount} operator @param {any} id */
export async function assertOperatorReturnDraftYard(operator, id, { allowNew = false } = {}) {
  if (!id) return;
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw Object.assign(new Error("Invalid return draft ID."), { status: 400 });
  }
  const result = await query("SELECT operator_id, receiving_location_id FROM return_drafts WHERE id=$1", [id]);
  if (!result.rowCount && allowNew) return;
  const row = found(result.rows[0]);
  if (row.operator_id !== operator.id) throw operatorYardForbidden("This draft belongs to another operator.");
  assertOperatorYard(operator, row.receiving_location_id);
}

/** @param {any} req @param {string} pathname */
async function authorizeReturnRequest(req, pathname) {
  suppliedYards(req, ["receivingLocationId", "yardLocationId", "yard"]);
  if (["/api/returns/orders/lookup", "/api/returns/drafts", "/api/returns/submit", "/api/returns/operator/drafts"].includes(pathname)) {
    selectedYard(req, ["receivingLocationId", "yardLocationId"]);
    await assertOperatorReturnDraftYard(req.operator, req.body?.draftId || req.body?.draft_id || (pathname === "/api/returns/drafts" ? req.body?.id : null), { allowNew: pathname === "/api/returns/drafts" || pathname === "/api/returns/submit" });
  }
  const draft = pathname.match(/^\/api\/returns\/drafts\/([^/]+)$/);
  if (draft) await assertOperatorReturnDraftYard(req.operator, operatorRouteId(draft[1]));
  const record = pathname.match(/^\/api\/returns\/operator\/history\/([^/]+)$/);
  if (record) {
    const result = await query("SELECT receiving_location_id FROM return_records WHERE id=$1 AND operator_id=$2", [operatorRouteId(record[1]), req.operator.id]);
    assertOperatorYard(req.operator, found(result.rows[0]).receiving_location_id);
  }
}

/** @param {import("./operator-yard-access.js").OperatorYardAccount} operator */
export async function assertOperatorCycleDraftYards(operator) {
  const result = await query(`SELECT DISTINCT l.location_id FROM cycle_count_lines l
    JOIN cycle_count_records r ON r.id=l.record_id WHERE r.operator_id=$1 AND r.status='draft'`, [operator.id]);
  for (const line of result.rows) assertOperatorYard(operator, line.location_id);
}

/** @param {any} req @param {string} pathname */
function controlInventorySync(req, pathname) {
  if (pathname !== "/api/inventory/sync") return false;
  const roles = [...(req.operator.roles || []), req.operator.role];
  // This shared action is also available to Control. Only server-verified roles
  // can supply that authority; a source/header flag never grants it.
  if (!roles.some((role) => ["admin", "yard_manager"].includes(role))) return false;
  const allowed = roles.includes("admin") ? [1, 28, 15, 26] : [...new Set([...(req.operator.yardLocationIds || []), ...operatorYardLocationIds(req.operator)])];
  const ids = req.body?.locationIds;
  if (!Array.isArray(ids) || !ids.length) throw operatorYardForbidden();
  for (const id of ids) assertOperatorYard({ operatorYardLocationIds: allowed }, id);
  return true;
}

const DELIVERY_LISTS = new Set(["sync", "orders", "vrma-orders", "bootstrap", "load-trucks", "load-orders", "saved-orders", "saved-order-keys", "consolidation/queue", "consolidation/active", "consolidation/start", "consolidation/release", "notifications", "current-draft"]);

/** @param {any} req @param {string} pathname */
async function authorizeDeliveryRequest(req, pathname) {
  const name = pathname.slice("/api/delivery/".length);
  if (DELIVERY_LISTS.has(name) || name.startsWith("saved-orders/")) selectedYard(req);
  if (["consolidation/active", "consolidation/release"].includes(name)) {
    const batches = await query("SELECT id FROM operator_consolidation_batches WHERE operator_id=$1 AND location_id=$2 AND status='active'", [req.operator.id, selectedYard(req)]);
    for (const batch of batches.rows) await assertConsolidationOrderYards(req.operator, batch.id);
  }
  const savedPathId = pathname.match(/^\/api\/delivery\/saved-orders\/([^/]+)$/)?.[1];
  const savedId = req.body?.orderId || (savedPathId ? operatorRouteId(savedPathId) : "");
  if (savedId) await assertOperatorOrderYard(req.operator, savedId);
}

/** @param {any} req */
function authorizeInventorySync(req) {
  const ids = req.body?.locationIds;
  if (!Array.isArray(ids) || !ids.length) throw operatorYardForbidden();
  for (const id of ids) assertOperatorYard(req.operator, id);
}

/** @param {any} req @param {string} pathname */
async function authorizeListRequest(req, pathname) {
  if (pathname.startsWith("/api/delivery/")) return authorizeDeliveryRequest(req, pathname);
  if (pathname.startsWith("/api/receiving/")) return selectedYard(req, ["destinationLocationId", "locationId"]);
  if (pathname === "/api/inventory/sync") return authorizeInventorySync(req);
  if (pathname.startsWith("/api/inventory/")) return selectedYard(req);
  if (["/api/customer-pickup/lookup", "/api/operator/requests", "/api/operator/netsuite-posting-policy", "/api/cycle-count/lines"].includes(pathname)) return selectedYard(req);
  if (pathname === "/api/cycle-count/submit") return assertOperatorCycleDraftYards(req.operator);
}

/** @param {any} req @param {RegExpMatchArray} job @param {{receivingJobs: Map<string, any>, fulfillmentJobs: Map<string, any>}} jobs */
async function authorizeJobRequest(req, job, { receivingJobs, fulfillmentJobs }) {
  const kind = job[1] || "";
  const id = operatorRouteId(job[2]);
  if (kind.startsWith("operator/")) {
    return assertOperatorPostingJobYard(req.operator, await getPublicOperatorNetSuitePostingCommand(id));
  }
  const receiving = kind.startsWith("receiving/");
  return assertJobYard(req, receiving ? receivingJobs : fulfillmentJobs, id, receiving);
}

/** @param {any} req @param {string} pathname @param {{receivingJobs: Map<string, any>, fulfillmentJobs: Map<string, any>}} jobs */
async function authorizeOperatorRequest(req, pathname, jobs) {
  if (pathname.startsWith("/api/returns/")) return authorizeReturnRequest(req, pathname);
  const order = pathname.match(/^\/api\/(delivery|receiving|customer-pickup)\/orders\/([^/]+)/);
  if (order) {
    return assertOperatorOrderYard(req.operator, operatorRouteId(order[2]), { receiving: order[1] === "receiving", orderType: req.body?.orderType || req.query.orderType });
  }
  const consolidation = pathname.match(/^\/api\/delivery\/consolidation\/(orders|batches)\/([^/]+)/);
  if (consolidation) return assertConsolidationYard(req, consolidation[1] || "", operatorRouteId(consolidation[2]));
  const job = pathname.match(/^\/api\/(delivery\/fulfillment-jobs|receiving\/receipt-jobs|operator\/netsuite-posting-jobs)\/([^/]+)/);
  if (job) return authorizeJobRequest(req, job, jobs);
  return authorizeListRequest(req, pathname);
}

export function createOperatorYardGuard({ receivingJobs = new Map(), fulfillmentJobs = new Map() } = {}) {
  /** @param {any} req @param {any} _res @param {(error?: any) => void} next */
  return async function requireOperatorYardRequest(req, _res, next) {
    try {
      const pathname = operatorRequestPath(req.originalUrl);
      if (/^\/api\/inventory\/classifications(?:\/|$)/.test(pathname) || pathname === "/api/cycle-count/records") return next();
      if (controlInventorySync(req, pathname)) return next();
      requireAssignedOperatorYards(req.operator);
      suppliedYards(req, ["locationId", "destinationLocationId"]);
      if (/^\/api\/(?:delivery|customer-pickup)\//.test(pathname)) await ensureOutboundLocationDirectory();
      req.operatorYardOrder = await authorizeOperatorRequest(req, pathname, { receivingJobs, fulfillmentJobs });
      next();
    } catch (error) { next(error); }
  };
}
