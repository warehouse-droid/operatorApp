// @ts-check
import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { DISPATCH_FLEET_PLANNING_LOCK } from "./dispatch-fleet-status.js";
import { lockConsolidatedLoadOrders } from "./consolidation-load-locks.js";
import { getOperatorProgressDetails } from "./operator-order-progress-repository.js";
import { assertSalesDeliveryPlanningAllowed, overlayFulfilledSalesDeliveryPlanning } from "./dispatch-fulfilled-so-repository.js";
import { assertNoActiveOrderDependenciesByRefs } from "./order-dependency-repository.js";
import { assertNoActiveConsolidationClaimsByRefs } from "./delivery-consolidation-repository.js";
import { materializeSalesSplitOrder, deactivateUnplannedDispatchSplitOrders, getNextDispatchSplitSuffix } from "./delivery-repository.js";
import { deactivateDispatchGlobalOrderDefinitions, syncDispatchGlobalOrderSplitsFromPlan } from "./dispatch-delivery-group-repository.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";
import { getDispatchSplitPreview } from "./dispatch-split-preview-repository.js";
import { persistedDispatchPlan } from "./dispatch-plan-fence.js";

const QUANTITIES = ["quantity", "pallets", "layers", "sections", "pieces"];
/** @param {any} value */
const text = (/** @type {any} */ value) => String(value ?? "").trim();
/** @param {string} code @param {string} message */
const failure = (code, message) => Object.assign(new Error(message), { code, status: 409 });
/** @param {any} item */
const itemKey = (/** @type {any} */ item) => text(item.lineId ?? item.line_id ?? item.lineRowId ?? item.id ?? item.sku);
/** @param {any} item */
function itemQuantities(item) {
  return Object.fromEntries(QUANTITIES.map(key => {
    const value = Number(item[key] ?? 0);
    if (!Number.isFinite(value) || value < 0) {
      throw failure("DISPATCH_SPLIT_QUANTITY_INVALID", "Split quantities must be finite and nonnegative.");
    }
    return [key, value];
  }));
}
/** @param {any[]} items */
function quantitySignature(items) {
  return JSON.stringify(items.map(item => [itemKey(item), ...QUANTITIES.map(key => Number(Number(item[key] ?? 0).toFixed(6)))])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
/** @param {any} item @param {Record<string, number>} quantities */
function assertConversion(item, quantities) {
  const converted = [["pallets", "toPlt"], ["layers", "toLyr"], ["sections", "toSec"], ["pieces", "toPcs"]];
  if (!converted.some(([key, conversion]) => Number(item[conversion] || 0) > 0 && Number(item[key] || 0) > 0)) { return; }
  const sales = converted.reduce((sum, [key, conversion]) => sum + quantities[key] * Number(item[conversion] || 0), 0);
  if (Math.abs(sales - quantities.quantity) > 0.000001) {
    throw failure("DISPATCH_SPLIT_QUANTITY_INVALID", "Each split's sales quantity must match its packing-unit conversions.");
  }
}
/** @param {any} source @param {any} part @returns {any[]} */
function resplitItems(source, part) {
  if (!Array.isArray(part?.items) || !part.items.length) {
    throw failure("DISPATCH_SPLIT_QUANTITY_INVALID", "Each split needs at least one item quantity.");
  }
  const canonical = new Map(source.items.map((/** @type {any} */ item) => [itemKey(item), item]));
  const seen = new Set();
  return part.items.map((/** @type {any} */ item) => {
    const key = itemKey(item), original = canonical.get(key);
    if (!original || seen.has(key)) {
      throw failure("DISPATCH_SPLIT_QUANTITY_INVALID", "Split items must identify unique lines from the unfinished order.");
    }
    seen.add(key);
    const quantities = itemQuantities(item);
    if (!Object.values(quantities).some(value => value > 0)) {
      throw failure("DISPATCH_SPLIT_QUANTITY_INVALID", "Remove empty item lines from the split.");
    }
    assertConversion(original, quantities);
    return { ...original, ...quantities, splitQty: quantities.quantity };
  });
}
/** @param {any} source @param {any[]} children */
function assertConserved(source, children) {
  const keys = new Set(source.items.map(itemKey));
  for (const child of children) {
    const seen = new Set();
    for (const item of child.items) {
      if (!keys.has(itemKey(item)) || seen.has(itemKey(item))) {
        throw failure("DISPATCH_SPLIT_QUANTITY_INVALID", "Split items must identify unique lines from the original order.");
      }
      seen.add(itemKey(item));
      itemQuantities(item);
    }
  }
  for (const item of source.items) {
    const expected = itemQuantities(item);
    const allocated = children.flatMap(child => child.items).filter(candidate => itemKey(candidate) === itemKey(item));
    for (const key of QUANTITIES) {
      const total = allocated.reduce((sum, candidate) => sum + candidate[key], 0);
      if (Math.abs(total - expected[key]) > 0.000001) {
        throw failure("DISPATCH_SPLIT_QUANTITY_INVALID", `Split quantities for ${item.sku || itemKey(item)} must equal the unfinished order's ${key}: ${expected[key]}.`);
      }
    }
  }
}

/** @param {any} source @param {any[]} children */
function assertUnsplitConserved(source, children) {
  // Legacy sales-only non-inventory splits omitted unconverted display pack
  // counts. The unchanged canonical parent restores those descriptive counts.
  const items = source.items.map((/** @type {any} */ item) => {
    const legacy = item.itemType === "NonInvtPart"
      && ["toPlt", "toLyr", "toSec", "toPcs"].every(key => Number(item[key] || 0) === 0);
    const result = { ...item };
    for (const key of QUANTITIES.filter(key => key !== "quantity")) {
      const parts = children.flatMap(child => child.items).filter(part => itemKey(part) === itemKey(item));
      if (legacy && parts.every(part => Number(part[key] || 0) === 0)) result[key] = 0;
    }
    return result;
  });
  assertConserved({ ...source, items }, children);
}
/** @param {any} source @param {any[]} parts @param {number} nextSuffix */
export function buildSalesResplits(source, parts, nextSuffix) {
  const parent = text(source.originalOrderId);
  if (!parent || !text(source.id).startsWith(parent + "-S") || !Array.isArray(source.items) || !source.items.length
      || !Array.isArray(parts) || parts.length < 2 || parts.length > 10 || !Number.isSafeInteger(nextSuffix) || nextSuffix < 1) {
    throw failure("DISPATCH_SPLIT_QUANTITY_INVALID", "Choose two to ten parts of the unfinished split order.");
  }
  if (new Set(source.items.map(itemKey)).size !== source.items.length) {
    throw failure("DISPATCH_SPLIT_QUANTITY_INVALID", "The unfinished order has duplicate item identities. Refresh Orders.");
  }
  const children = parts.map((part, index) => {
    const items = resplitItems(source, part);
    return { ...source, id: `${parent}-S${nextSuffix + index}`, originalOrderId: parent,
      resplitSourceOrderId: source.id, items, planOwned: true, netsuiteId: "",
      globalOrderSourcePlanId: "", globalOrderSourcePlanDate: "", dispatchSnapshotSourcePlanId: "", dispatchSnapshotSourcePlanDate: "",
      dispatchPlanned: false, dispatchPlanId: "", dispatchPlanDate: "", dispatchTruckPlate: "", dispatchLoadName: "",
      dispatchParkingSpot: "", localDispatchStatus: "open", operatorStatus: "open", localYardOrderStatus: "Open",
      salesQty: items.reduce((sum, item) => sum + item.quantity, 0),
      pallets: items.reduce((sum, item) => sum + item.pallets + (item.layers > 0 ? 1 : 0), 0),
      weight: items.reduce((sum, item) => sum + item.quantity * Number(item.itemWeight || 0), 0),
      notes: `Split ${index + 1}/${parts.length} from ${source.id}. ${source.notes || ""}` };
  });
  assertConserved(source, children);
  return children;
}
/** @param {string} ref */
async function assertUnplannedSource(ref) {
  const assignments = await query(`SELECT 1 FROM dispatch_plan_order_assignments
    WHERE lower(order_ref)=lower($1) OR lower(planned_order_ref)=lower($1) LIMIT 1`, [ref]);
  const grouped = await query(`SELECT 1 FROM dispatch_global_order_group_members m JOIN dispatch_global_order_groups g USING(group_ref)
    WHERE lower(m.member_order_ref)=lower($1) AND g.active LIMIT 1`, [ref]);
  const planned = await query(`SELECT 1 FROM sales_orders WHERE tranid=$1
    AND (dispatch_planned OR dispatch_plan_date IS NOT NULL OR COALESCE(dispatch_truck_plate,'')<>'' OR COALESCE(dispatch_load_name,'')<>'') LIMIT 1`, [ref]);
  if (assignments.rowCount || grouped.rowCount || planned.rowCount) {
    throw failure("DISPATCH_SPLIT_PLANNED", `Unplan or ungroup ${ref} before splitting its unfinished quantity.`);
  }
}
/** @param {string} ref @param {any} header @param {any[]} lines */
async function assertUnfinishedSource(ref, header, lines) {
  const executed = await query(`SELECT 1 FROM driver_job_records WHERE order_refs ? $1
    AND (started_at IS NOT NULL OR completed_at IS NOT NULL OR status IN ('in_progress','complete','completed')) LIMIT 1`, [ref]);
  if (executed.rowCount || header?.fulfilled_at || header?.last_item_fulfillment_id
      || /^(fulfilled|partial_fulfilled|shipped)$/iu.test(text(header?.fulfillment_status))
      || lines.some(line => ["fulfilled_pallet_qty", "fulfilled_layer_qty", "fulfilled_section_qty", "fulfilled_piece_qty"]
        .some(key => Number(line[key] || 0) > 0))) {
    throw failure("DISPATCH_SPLIT_EXECUTED", `Cannot split ${ref}: it has started Driver work or recorded fulfillment. Completed siblings remain retained.`);
  }
  const progress = (await getOperatorProgressDetails([ref]))[0];
  if (progress && ["packed", "loaded"].includes(progress.status)) {
    const actor = progress.operator ? ` by ${progress.operator.displayName}` : "";
    throw failure("DISPATCH_SPLIT_OPERATOR_ACTIVITY", `Cannot split ${ref}: it is ${progress.status}${actor}. Reopen or unpack this order first.`);
  }
  const claims = await query(`SELECT 1 FROM operator_netsuite_posting_order_claims WHERE active
    AND local_order_key=ANY($1::text[]) LIMIT 1`, [[`delivery_prep:sales_order:${header?.netsuite_id}`, `customer_pickup:sales_order:${header?.netsuite_id}`]]);
  const links = await query("SELECT 1 FROM dispatch_so_po_allocations WHERE dispatch_target_ref=$1 AND status='active' LIMIT 1", [ref]);
  if (claims.rowCount || links.rowCount) {
    throw failure("DISPATCH_SPLIT_RESERVED", `Cannot split ${ref}: resolve its pending posting or unlink its PO allocation first.`);
  }
}

/** @param {{orderRef?: string, planId?: any, planDate?: string, expectedItems?: any[], parts?: any[], actor?: any, sessionId?: string, assertEditLease?: () => Promise<any>}} input */
export async function resplitUnfinishedSalesOrder(input = {}) {
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    if (input.assertEditLease) { await input.assertEditLease(); }
    const ref = text(input.orderRef);
    const row = (await query(`SELECT * FROM dispatch_global_order_splits WHERE lower(split_ref)=lower($1)
      AND order_type='SO' AND definition_kind='split' FOR UPDATE`, [ref])).rows[0];
    if (!row || !/^[\s\S]+-S[1-9][0-9]*$/u.test(row.split_ref)
        || row.split_ref.replace(/-S[0-9]+$/u, "") !== row.parent_order_ref) {
      throw failure("DISPATCH_SPLIT_NOT_FOUND", "Select an existing Sales Order split and refresh Orders.");
    }
    if (!/^[1-9][0-9]*$/u.test(text(input.planId))) {
      throw failure("DISPATCH_SPLIT_PLAN_MISMATCH", "Reload the current date plan before splitting this order.");
    }
    const plan = (await query("SELECT id,plan_date::text AS plan_date,revision,status FROM dispatch_plans WHERE id=$1 FOR UPDATE", [input.planId])).rows[0];
    if (!plan || plan.plan_date !== input.planDate || plan.status === "cancelled") {
      throw failure("DISPATCH_SPLIT_PLAN_MISMATCH", "Reload the current date plan before splitting this order.");
    }
    const requestHash = crypto.createHash("sha256").update(JSON.stringify({ planId: String(input.planId),
      planDate: input.planDate, expectedItems: input.expectedItems, parts: input.parts })).digest("hex");
    const previous = row.full_order.resplitReplacement;
    if (!row.active) {
      if (previous?.requestHash === requestHash) { return { ...previous.result, idempotentReplay: true }; }
      throw failure("DISPATCH_SPLIT_RETIRED", `${row.split_ref} was already replaced. Refresh Orders.`);
    }
    const source = { ...row.full_order, id: row.split_ref, originalOrderId: row.parent_order_ref };
    if (!Array.isArray(input.expectedItems) || quantitySignature(input.expectedItems) !== quantitySignature(source.items || [])) {
      throw failure("DISPATCH_SPLIT_STALE", `${row.split_ref} quantities changed. Refresh Orders and enter the split again.`);
    }
    await assertUnplannedSource(row.split_ref);
    const header = (await query("SELECT * FROM sales_orders WHERE tranid=$1", [row.split_ref])).rows[0];
    if (header) { await lockConsolidatedLoadOrders([header.netsuite_id]); }
    const current = header ? (await query("SELECT * FROM sales_orders WHERE netsuite_id=$1 FOR UPDATE", [header.netsuite_id])).rows[0] : null;
    /** @type {any[]} */
    const lines = current ? (await query("SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id FOR UPDATE", [current.netsuite_id])).rows : [];
    await assertUnfinishedSource(row.split_ref, current, lines);
    const nativeItems = lines.filter(line => line.netsuite_active !== false).map(line => ({ lineId: line.line_id,
      lineRowId: line.id, sku: line.sku, quantity: line.quantity, pallets: line.pallet_qty,
      layers: line.layer_qty, sections: line.section_qty, pieces: line.piece_qty }));
    if (current && quantitySignature(nativeItems) !== quantitySignature(source.items)) {
      throw failure("DISPATCH_SPLIT_STALE", `${row.split_ref} native quantities changed. Refresh Orders before splitting.`);
    }
    await assertSalesDeliveryPlanningAllowed([row.split_ref], "split the unfinished order");
    await assertNoActiveOrderDependenciesByRefs([row.split_ref], "split this unfinished order");
    await assertNoActiveConsolidationClaimsByRefs([row.split_ref], "split this unfinished order");
    const seed = await getNextDispatchSplitSuffix({ originalOrderId: row.parent_order_ref, orderType: "SO" });
    const orders = buildSalesResplits(source, input.parts ?? [], seed.nextSuffix);
    const parent = (await query("SELECT netsuite_id FROM sales_orders WHERE tranid=$1 AND netsuite_id>0 FOR UPDATE", [row.parent_order_ref])).rows[0];
    if (!parent) { throw failure("DISPATCH_SPLIT_NOT_FOUND", "The original Sales Order was not found. Refresh Orders."); }
    await deactivateUnplannedDispatchSplitOrders({ originalOrderId: row.parent_order_ref, orderType: "SO", splitOrderIds: [row.split_ref] });
    for (const order of orders) { order.netsuiteId = String(await materializeSalesSplitOrder(order, parent)); }
    await syncDispatchGlobalOrderSplitsFromPlan({ id: plan.id, planDate: plan.plan_date, revision: plan.revision, orders, trucks: [] });
    await deactivateDispatchGlobalOrderDefinitions([row.split_ref]);
    const result = { orders, retiredGlobalOrderRefs: [row.split_ref], planRevision: Number((await query("SELECT revision FROM dispatch_plans WHERE id=$1", [plan.id])).rows[0].revision) };
    await query("UPDATE dispatch_global_order_splits SET full_order=full_order||$2::jsonb WHERE split_ref=$1",
      [row.split_ref, JSON.stringify({ resplitReplacement: { requestHash, result } })]);
    await writeDispatchAudit({ action: "order_resplit", entityType: "order", entityId: row.split_ref, orderId: row.split_ref,
      planId: plan.id, planDate: plan.plan_date, sessionId: input.sessionId, operatorId: input.actor?.id,
      before: source, after: orders, details: { preservedParentRef: row.parent_order_ref, createdOrderIds: orders.map(order => order.id) } });
    return result;
  });
}

/** @typedef {{rootRef: string, restoreRef: string, siblings: any[], safetyRefs: string[], source: any}} SalesUnsplitFamily */
/** @param {any[]} definitions @param {string} selectedRef @returns {SalesUnsplitFamily} */
export function resolveSalesUnsplitFamily(definitions, selectedRef) {
  const selected = definitions.find(row => text(row.split_ref).toLowerCase() === text(selectedRef).toLowerCase());
  if (!selected?.active) {
    throw failure("DISPATCH_UNSPLIT_STALE", "This split is no longer active. Refresh Orders before using Unsplit.");
  }
  const rootRef = text(selected.parent_order_ref);
  const restoreRef = text(selected.full_order.resplitSourceOrderId) || rootRef;
  const active = definitions.filter(row => row.active && row.parent_order_ref === rootRef);
  const siblings = active.filter(row => (text(row.full_order.resplitSourceOrderId) || rootRef) === restoreRef);
  const source = restoreRef === rootRef ? null : definitions.find(row => row.split_ref === restoreRef);
  const expected = source?.full_order.resplitReplacement?.result?.orders?.map((/** @type {any} */ order) => text(order.id)).sort();
  const incomplete = source
    ? source.active || !expected || JSON.stringify(expected) !== JSON.stringify(siblings.map(row => row.split_ref).sort())
    : restoreRef !== rootRef || siblings.length !== active.length;
  if (incomplete || siblings.length < 2) {
    throw failure("DISPATCH_UNSPLIT_DESCENDANTS", "Unsplit blocked. Every sibling in this split step must be available. Completed or further-split siblings cannot be merged.");
  }
  const safetyRefs = (restoreRef === rootRef
    ? definitions.filter(row => row.parent_order_ref === rootRef && !text(row.full_order.resplitSourceOrderId))
    : siblings).map(row => text(row.split_ref));
  return { rootRef, restoreRef, siblings, safetyRefs, source };
}

/** @param {string[]} refs @param {any[]} headers @param {any[]} definitions */
async function assertUnsplitOrdersUnstarted(refs, headers, definitions = []) {
  const activeRefs = refs.filter(ref => !definitions.some(row => row.split_ref === ref && row.active === false));
  await assertSalesDeliveryPlanningAllowed(activeRefs, "unsplit these orders");
  /** @type {any[]} */
  const completed = (await query(`SELECT DISTINCT order_ref FROM dispatch_effective_order_completion_events
    WHERE order_kind='SO' AND lower(btrim(order_ref))=ANY($1::text[])
      AND completion_evidence_type IN ('driver_job','manual_dispatch','direct_dependency')`, [refs.map(ref => ref.toLowerCase())])).rows;
  if (completed.length) {
    throw failure("DISPATCH_UNSPLIT_ACTIVITY", `Unsplit blocked. ${completed.map(row => row.order_ref).join(", ")} was completed.`);
  }
  await assertNoActiveOrderDependenciesByRefs(refs, "unsplit these orders");
  await assertNoActiveConsolidationClaimsByRefs(refs, "unsplit these orders");
  const activityKeys = ["loaded_qty", "packed_sales_qty", "packed_pallet_qty", "packed_layer_qty", "packed_section_qty",
    "packed_piece_qty", "fulfilled_pallet_qty", "fulfilled_layer_qty", "fulfilled_section_qty", "fulfilled_piece_qty"];
  for (const ref of refs) {
    await assertUnplannedSource(ref);
    const header = headers.find(row => row.tranid === ref);
    /** @type {any[]} */
    const lines = header ? (await query("SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id FOR UPDATE", [header.netsuite_id])).rows : [];
    const definition = definitions.find(row => row.split_ref === ref);
    const nativeItems = lines.filter(line => line.netsuite_active !== false).map(line => ({ lineId: line.line_id,
      lineRowId: line.id, quantity: line.quantity, pallets: line.pallet_qty, layers: line.layer_qty, sections: line.section_qty, pieces: line.piece_qty }));
    if (header && definition?.active && quantitySignature(nativeItems) !== quantitySignature(definition.full_order.items || [])) {
      throw failure("DISPATCH_UNSPLIT_STALE", `${ref} quantities changed. Refresh Orders before using Unsplit.`);
    }
    if (lines.some(line => line.confirmed || activityKeys.some(key => Number(line[key] || 0) > 0))) {
      throw failure("DISPATCH_UNSPLIT_ACTIVITY", `Unsplit blocked. ${ref} has packing, loading or fulfillment activity. Reopen or clear it first.`);
    }
    await assertUnfinishedSource(ref, header, lines);
  }
}

/** @param {SalesUnsplitFamily} family @param {any} parent @param {any[]} headers @returns {Promise<any>} */
async function restoredSalesUnsplitOrder(family, parent, headers) {
  if (family.source) {
    const original = headers.find(row => row.tranid === family.restoreRef);
    if (original && (original.netsuite_active !== false || Number(original.netsuite_id) >= 0)) {
      throw failure("DISPATCH_UNSPLIT_STALE", "The split parent already has an active identity. Refresh Orders.");
    }
    const restored = { ...family.source.full_order };
    delete restored.resplitReplacement;
    restored.netsuiteId = String(await materializeSalesSplitOrder(restored, parent, { existingSplitId: original?.netsuite_id }));
    const owner = (await query("SELECT id,plan_date::text AS plan_date,revision FROM dispatch_plans WHERE id=$1", [family.source.source_plan_id])).rows[0];
    if (!owner) {
      throw failure("DISPATCH_UNSPLIT_STALE", "The split's source plan is unavailable. Refresh Orders.");
    }
    await syncDispatchGlobalOrderSplitsFromPlan({ id: owner.id, planDate: owner.plan_date, revision: owner.revision, orders: [restored], trucks: [] });
    await assertSalesDeliveryPlanningAllowed([restored.id], "restore this split");
    return restored;
  }
  const preview = await getDispatchSplitPreview({ orderRef: family.rootRef, type: "SO" });
  return { ...family.siblings[0].full_order, ...preview, id: family.rootRef, originalOrderId: "", resplitSourceOrderId: "",
    netsuiteId: String(parent.netsuite_id), globalOrderDefinition: false, globalOrderDefinitionKind: "",
    globalOrderSourcePlanId: "", globalOrderSourcePlanDate: "", planOwned: false,
    address: parent.dispatch_address, destinationAddress: parent.dispatch_address, notes: parent.memo || "",
    salesQty: preview.items.reduce((/** @type {number} */ sum, /** @type {any} */ item) => sum + item.quantity, 0) };
}

/** @param {any} input @returns {Promise<any>} */
export async function unsplitSalesOrder(input = {}) {
  return withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext($1))", [DISPATCH_FLEET_PLANNING_LOCK]);
    if (input.assertEditLease) { await input.assertEditLease(); }
    const ref = text(input.orderRef || input.splitOrderIds?.[0]);
    const selected = (await query(`SELECT parent_order_ref FROM dispatch_global_order_splits
      WHERE lower(split_ref)=lower($1) AND order_type='SO' AND definition_kind='split'`, [ref])).rows[0];
    if (!selected) { throw failure("DISPATCH_UNSPLIT_STALE", "Select an active SO split and refresh Orders."); }
    /** @type {any[]} */
    const definitions = (await query(`SELECT * FROM dispatch_global_order_splits WHERE parent_order_ref=$1
      AND order_type='SO' AND definition_kind='split' ORDER BY split_ref FOR UPDATE`, [selected.parent_order_ref])).rows;
    const family = resolveSalesUnsplitFamily(definitions, ref);
    const plan = /^[1-9][0-9]*$/u.test(text(input.planId))
      ? (await query("SELECT id,plan_date::text AS plan_date,revision,status FROM dispatch_plans WHERE id=$1 FOR UPDATE", [input.planId])).rows[0] : null;
    if (!plan || plan.plan_date !== input.planDate || plan.status === "cancelled") {
      throw failure("DISPATCH_SPLIT_PLAN_MISMATCH", "Reload the current date plan before using Unsplit.");
    }
    const refs = family.siblings.map(row => row.split_ref);
    const checkedRefs = [...new Set([...family.safetyRefs, family.restoreRef])];
    /** @type {any[]} */
    const identities = (await query("SELECT * FROM sales_orders WHERE tranid=ANY($1::text[]) ORDER BY netsuite_id", [checkedRefs])).rows;
    if (checkedRefs.some(orderRef => identities.filter(row => row.tranid === orderRef).length > 1)) {
      throw failure("DISPATCH_UNSPLIT_STALE", "A split has ambiguous native identities. Refresh Orders.");
    }
    await lockConsolidatedLoadOrders(identities.map(row => row.netsuite_id));
    /** @type {any[]} */
    const headers = (await query("SELECT * FROM sales_orders WHERE tranid=ANY($1::text[]) ORDER BY netsuite_id FOR UPDATE", [checkedRefs])).rows;
    /** @type {any[]} */
    const nativeFamily = (await query(`SELECT s.tranid FROM sales_orders s JOIN dispatch_scm_so_splits m ON m.split_so_id=s.netsuite_id
      WHERE m.source_so_ref=$1 AND m.status='active' AND s.netsuite_active=true`, [family.rootRef])).rows;
    await assertUnsplitOrdersUnstarted(family.safetyRefs, headers, definitions);
    if (nativeFamily.some(row => !definitions.some(definition => definition.split_ref === row.tranid
      && (definition.active || family.restoreRef !== family.rootRef)))) {
      throw failure("DISPATCH_UNSPLIT_STALE", "A sibling is missing its split definition. Refresh Orders before using Unsplit.");
    }
    if (input.assertEditable) { await input.assertEditable(checkedRefs); }
    const parentRows = (await query("SELECT * FROM sales_orders WHERE tranid=$1 AND netsuite_id>0 FOR UPDATE", [family.rootRef])).rows;
    if (parentRows.length !== 1) { throw failure("DISPATCH_UNSPLIT_STALE", "The original Sales Order is unavailable or ambiguous."); }
    const parent = parentRows[0];
    const source = family.source?.full_order || { ...(await getDispatchSplitPreview({ orderRef: family.rootRef, type: "SO" })) };
    assertUnsplitConserved(source, family.siblings.map(row => row.full_order));
    if (family.source) {
      const sourceHeader = headers.find(row => row.tranid === family.restoreRef);
      const sourceLines = sourceHeader ? (await query("SELECT * FROM sales_order_lines WHERE sales_order_id=$1 ORDER BY id FOR UPDATE", [sourceHeader.netsuite_id])).rows : [];
      await assertUnfinishedSource(family.restoreRef, sourceHeader, sourceLines);
      await assertUnplannedSource(family.restoreRef);
    } else {
      await assertUnsplitOrdersUnstarted([family.restoreRef], headers);
    }
    if (input.assertEditLease) { await input.assertEditLease(); }
    const result = await deactivateUnplannedDispatchSplitOrders({ originalOrderId: family.rootRef, orderType: "SO", splitOrderIds: refs });
    await deactivateDispatchGlobalOrderDefinitions(refs);
    const restored = await restoredSalesUnsplitOrder(family, parent, headers);
    const [restoredOrder] = await overlayFulfilledSalesDeliveryPlanning([{ ...restored, dispatchPlanned: false, dispatchPlanId: "", dispatchPlanDate: "", dispatchTruckPlate: "", dispatchLoadName: "",
      dispatchParkingSpot: "", localDispatchStatus: "open", operatorStatus: "open", localYardOrderStatus: "Open", netsuiteActive: true }]);
    const persisted = (await query(`SELECT p.id,p.plan_date,p.revision,p.status,p.note,s.saved_at,s.orders,s.trucks,s.summary
      FROM dispatch_plans p JOIN dispatch_plan_snapshots s ON s.plan_id=p.id WHERE p.id=$1`, [plan.id])).rows[0];
    const acknowledged = persistedDispatchPlan(persisted);
    if (!acknowledged) {
      throw failure("DISPATCH_UNSPLIT_STALE", "The saved plan snapshot is unavailable. Refresh Orders before using Unsplit.");
    }
    await writeDispatchAudit({ action: "order_unsplit", entityType: "order", entityId: family.restoreRef, orderId: family.restoreRef,
      planId: plan.id, planDate: plan.plan_date, operatorId: input.actor?.id, sessionId: input.sessionId,
      before: family.siblings.map(row => row.full_order), after: restoredOrder,
      details: { removedSplitOrderIds: refs, originalOrderId: family.rootRef } });
    return { ...result, deactivated: refs, restoredOrder, planRevision: acknowledged.revision, planDigest: acknowledged.digest,
      reactivatedGlobalOrderRefs: family.source ? [family.restoreRef] : [] };
  });
}
