import crypto from "node:crypto";
import { isNetSuiteSandboxEnvironment } from "./config.js";
import { query } from "./db.js";

const EPSILON = 0.000001;

function text(value) {
  return String(value || "").trim();
}

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateOnly(value) {
  const valueText = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(valueText.slice(0, 10)) ? valueText.slice(0, 10) : "";
}

function splitParentRef(order = {}) {
  if (text(order?.type).toUpperCase() === "CUSTOM") return "";
  const explicit = text(order.originalOrderId);
  if (explicit) return explicit;
  const ref = text(order.id);
  return /-S\d+$/i.test(ref) ? ref.replace(/-S\d+$/i, "") : "";
}

function targetKind(order = {}, canonical = null) {
  if (Array.isArray(order.childOrders) && order.childOrders.length) return "group";
  if (splitParentRef(order) || /dispatch-split/i.test(text(canonical?.dispatch_parse_source))) return "split";
  return "normal";
}

function targetLineKey(targetRef, sourceOrderRef, sourceLineIdentity) {
  return `${text(targetRef)}::${text(sourceOrderRef)}::${text(sourceLineIdentity)}`;
}

function targetItemQuantity(item = {}, fallback = {}) {
  return {
    quantity: number(item.quantity ?? item.salesQty ?? item.splitQty ?? fallback.quantity),
    pallets: number(item.pallets ?? item.pallet_qty ?? fallback.pallet_qty),
    layers: number(item.layers ?? item.layer_qty ?? fallback.layer_qty),
    sections: number(item.sections ?? item.section_qty ?? fallback.section_qty),
    pieces: number(item.pieces ?? item.piece_qty ?? fallback.piece_qty)
  };
}

function flattenGroupMembers(order = {}) {
  const members = [];
  const visiting = new Set();
  const visit = (candidate) => {
    const id = text(candidate?.id);
    const childRefs = (Array.isArray(candidate?.childOrders) ? candidate.childOrders : []).map(text).filter(Boolean);
    if (!childRefs.length) {
      if (id) members.push(candidate);
      return;
    }
    if (id && visiting.has(id)) return;
    if (id) visiting.add(id);
    const detailById = new Map((candidate.childOrderDetails || []).filter((row) => row?.id).map((row) => [text(row.id), row]));
    for (const childRef of childRefs) {
      const detail = detailById.get(childRef) || { id: childRef, type: "SO" };
      if (Array.isArray(detail.childOrders) && detail.childOrders.length) visit(detail);
      else members.push(detail);
    }
    if (id) visiting.delete(id);
  };
  visit(order);
  return [...new Map(members.map((member) => [text(member.id), member])).values()];
}

async function findSnapshotTarget(targetRef, planDate = "") {
  const params = [text(targetRef)];
  const date = dateOnly(planDate);
  let dateClause = "";
  if (date) {
    params.push(date);
    dateClause = "AND p.plan_date = $2::date";
  }
  const result = await query(
    `SELECT p.id, p.plan_date::text AS plan_date, snapshot.orders,
            EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(snapshot.trucks, '[]'::jsonb)) truck(value)
                CROSS JOIN LATERAL jsonb_array_elements(COALESCE(truck.value -> 'loads', '[]'::jsonb)) load(value)
                CROSS JOIN LATERAL jsonb_array_elements(COALESCE(load.value -> 'stops', '[]'::jsonb)) stop(value)
               WHERE lower(btrim(COALESCE(
                 stop.value ->> 'orderId',
                 stop.value ->> 'order_id',
                 stop.value ->> 'orderRef',
                 stop.value ->> 'tranid',
                 stop.value ->> 'orderNumber',
                 ''
               ))) = lower(btrim($1))
                  OR EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements_text(
                        CASE WHEN jsonb_typeof(stop.value -> 'orderRefs') = 'array'
                          THEN stop.value -> 'orderRefs' ELSE '[]'::jsonb END
                      ) ref(value)
                     WHERE lower(btrim(ref.value)) = lower(btrim($1))
                  )
            ) AS planned
       FROM dispatch_plans p
       JOIN dispatch_plan_snapshots snapshot ON snapshot.plan_id = p.id
      WHERE p.status <> 'cancelled'
        ${dateClause}
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(snapshot.orders, '[]'::jsonb)) candidate
           WHERE candidate ->> 'id' = $1
        )
      ORDER BY p.updated_at DESC, p.id DESC
      LIMIT 1`,
    params
  );
  if (!result.rowCount) return null;
  const order = (result.rows[0].orders || []).find((candidate) => text(candidate?.id) === text(targetRef));
  return order ? {
    order,
    planId: result.rows[0].id,
    planDate: dateOnly(result.rows[0].plan_date),
    planned: result.rows[0].planned === true
  } : null;
}

async function projectedGroupTarget(targetRef, planDate = "") {
  const params = [text(targetRef)];
  const date = dateOnly(planDate);
  const dateClause = date ? "AND g.plan_date = $2::date" : "";
  if (date) params.push(date);
  const result = await query(
    `SELECT g.plan_id, g.plan_date::text AS plan_date,
            COALESCE(jsonb_agg(m.member_order_ref ORDER BY m.position)
              FILTER (WHERE m.member_order_ref IS NOT NULL), '[]'::jsonb) AS child_refs
       FROM dispatch_delivery_groups g
       LEFT JOIN dispatch_delivery_group_members m ON m.group_ref = g.group_ref
      WHERE g.group_ref = $1 AND g.active = true
        ${dateClause}
      GROUP BY g.group_ref
      LIMIT 1`,
    params
  );
  if (!result.rowCount) return null;
  return {
    order: {
      id: text(targetRef),
      type: "SO",
      childOrders: result.rows[0].child_refs || [],
      childOrderDetails: (result.rows[0].child_refs || []).map((id) => ({ id, type: "SO" }))
    },
    planId: result.rows[0].plan_id,
    planDate: dateOnly(result.rows[0].plan_date)
  };
}

async function loadCanonicalOrders(refs = []) {
  const cleaned = [...new Set(refs.map(text).filter(Boolean))];
  if (!cleaned.length) return { headers: new Map(), lines: new Map() };
  const sandboxFixtures = isNetSuiteSandboxEnvironment();
  const headersResult = await query(`SELECT * FROM sales_orders WHERE tranid = ANY($1::text[])`, [cleaned]);
  const linesResult = await query(
    `SELECT line.*, sales.tranid AS source_order_ref
      FROM sales_order_lines line
      JOIN sales_orders sales ON sales.netsuite_id = line.sales_order_id
     WHERE sales.tranid = ANY($1::text[])
        AND (
          COALESCE(line.netsuite_active, true)
          OR ($2::boolean AND COALESCE(sales.is_test_fixture, false))
        )
      ORDER BY sales.tranid, line.line_id NULLS LAST, line.id`,
    [cleaned, sandboxFixtures]
  );
  const headers = new Map(headersResult.rows.map((row) => [text(row.tranid), row]));
  const lines = new Map();
  for (const line of linesResult.rows) {
    const ref = text(line.source_order_ref);
    if (!lines.has(ref)) lines.set(ref, []);
    lines.get(ref).push(line);
  }
  return { headers, lines };
}

function lineMatchesItem(line = {}, item = {}, { allowRowId = true } = {}) {
  const rowId = Number(item.lineRowId || item.id || 0);
  if (allowRowId && rowId && Number(line.id) === rowId) return true;
  const lineId = text(item.lineId ?? item.line_id);
  if (lineId && text(line.line_id) === lineId) return true;
  const itemId = text(item.itemId ?? item.item_id);
  if (itemId && text(line.item_id) === itemId) return true;
  const sku = text(item.sku || item.itemName).toLowerCase();
  return Boolean(sku && [line.sku, line.item_name].map((value) => text(value).toLowerCase()).includes(sku));
}

function sourceLineIdentity(item = {}, line = {}) {
  return text(item.lineRowId || item.sourceLineId || item.lineId || item.line_id || line.id || line.line_id || item.itemId || item.sku);
}

function normalizedTargetLine({ targetRef, kind, sourceRef, item = null, line }) {
  const quantities = targetItemQuantity(item || {}, line);
  const shortage = number(line.netsuite_backordered_qty) > EPSILON
    ? Math.min(number(line.netsuite_backordered_qty), quantities.quantity || number(line.netsuite_backordered_qty))
    : quantities.quantity;
  return {
    targetLineKey: targetLineKey(targetRef, sourceRef, sourceLineIdentity(item || {}, line)),
    targetRef: text(targetRef),
    targetKind: kind,
    sourceOrderRef: text(sourceRef),
    sourceOrderId: Number(line.sales_order_id),
    salesLineId: Number(line.id),
    lineId: line.line_id,
    itemId: line.item_id,
    itemName: line.item_name || item?.itemName || "",
    sku: line.sku || item?.sku || line.item_name || "",
    description: line.item_description || item?.description || "",
    itemType: line.item_type || "",
    itemTypeText: line.item_type_text || "",
    unit: line.unit || item?.unit || "",
    quantity: quantities.quantity,
    shortageQuantity: Math.max(shortage, 0),
    pallets: quantities.pallets,
    layers: quantities.layers,
    sections: quantities.sections,
    pieces: quantities.pieces,
    toPlt: number(line.to_plt),
    toLyr: number(line.to_lyr),
    toSec: number(line.to_sec),
    toPcs: number(line.to_pcs),
    dependencyAllocatedQuantity: 0,
    poAllocatedPallets: 0,
    poAllocatedLayers: 0,
    poAllocatedSections: 0,
    poAllocatedPieces: 0,
    poAllocatedSalesQty: 0
  };
}

function linesForEntry({ targetRef, kind, entry, canonical }) {
  const entryRef = text(entry.id);
  const parentRef = splitParentRef(entry);
  const exactHeader = canonical.headers.get(entryRef);
  const sourceRef = exactHeader ? entryRef : parentRef || entryRef;
  const sourceLines = canonical.lines.get(sourceRef) || [];
  const parentLines = parentRef ? canonical.lines.get(parentRef) || [] : [];
  const items = Array.isArray(entry.items) ? entry.items.filter(Boolean) : [];
  const useCanonicalGroupLines = kind === "group" && exactHeader && !parentRef;
  if (!items.length || useCanonicalGroupLines) {
    return sourceLines.map((line) => normalizedTargetLine({ targetRef, kind, sourceRef, line }));
  }
  const rows = [];
  for (const item of items) {
    let line = sourceLines.find((candidate) => lineMatchesItem(candidate, item, { allowRowId: !exactHeader || kind !== "split" }));
    if (!line && exactHeader) line = sourceLines.find((candidate) => lineMatchesItem(candidate, item, { allowRowId: false }));
    if (!line && parentLines.length) line = parentLines.find((candidate) => lineMatchesItem(candidate, item));
    if (!line) continue;
    rows.push(normalizedTargetLine({ targetRef, kind, sourceRef: text(line.source_order_ref || sourceRef), item, line }));
  }
  return rows;
}

async function applyExistingAllocations(targetRef, lines) {
  if (!lines.length) return lines;
  const dependencies = await query(
    `SELECT line.dispatch_target_line_key, SUM(line.allocated_quantity) AS allocated_quantity
       FROM order_dependency_lines line
       JOIN order_dependencies dependency ON dependency.id = line.dependency_id
      WHERE dependency.dispatch_target_ref = $1
        AND dependency.status <> 'cancelled'
        AND line.line_role = 'sales_allocation'
      GROUP BY line.dispatch_target_line_key`,
    [text(targetRef)]
  );
  const poAllocations = await query(
    `SELECT dispatch_target_line_key,
            SUM(allocated_pallet_qty) AS pallets,
            SUM(allocated_layer_qty) AS layers,
            SUM(allocated_section_qty) AS sections,
            SUM(allocated_piece_qty) AS pieces,
            SUM(allocated_sales_qty) AS sales_qty
       FROM dispatch_so_po_allocations
      WHERE dispatch_target_ref = $1 AND status = 'active'
      GROUP BY dispatch_target_line_key`,
    [text(targetRef)]
  );
  const dependencyByKey = new Map(dependencies.rows.map((row) => [text(row.dispatch_target_line_key), number(row.allocated_quantity)]));
  const poByKey = new Map(poAllocations.rows.map((row) => [text(row.dispatch_target_line_key), row]));
  return lines.map((line) => {
    const po = poByKey.get(line.targetLineKey) || {};
    return {
      ...line,
      dependencyAllocatedQuantity: number(dependencyByKey.get(line.targetLineKey)),
      poAllocatedPallets: number(po.pallets),
      poAllocatedLayers: number(po.layers),
      poAllocatedSections: number(po.sections),
      poAllocatedPieces: number(po.pieces),
      poAllocatedSalesQty: number(po.sales_qty)
    };
  });
}

export async function resolveDispatchSalesTarget({ dispatchTargetRef = "", planDate = "" } = {}) {
  const ref = text(dispatchTargetRef);
  if (!ref) throw new Error("Dispatch Sales Order target is required.");
  const snapshot = await findSnapshotTarget(ref, planDate) || await projectedGroupTarget(ref, planDate);
  const initialRefs = [ref, splitParentRef(snapshot?.order || { id: ref })];
  let canonical = await loadCanonicalOrders(initialRefs);
  const exactCanonical = canonical.headers.get(ref) || null;
  if (!snapshot && !exactCanonical) throw new Error(`${ref} was not found in the selected dispatch plan or Sales Order table.`);
  const order = snapshot?.order || { id: ref, type: "SO", items: [] };
  const kind = targetKind(order, exactCanonical);
  const entries = kind === "group"
    ? flattenGroupMembers(order)
    : [{ ...order, id: ref, items: kind === "normal" && exactCanonical ? [] : order.items }];
  const requiredRefs = entries.flatMap((entry) => [text(entry.id), splitParentRef(entry)]).filter(Boolean);
  canonical = await loadCanonicalOrders([...initialRefs, ...requiredRefs]);
  let lines = entries.flatMap((entry) => linesForEntry({ targetRef: ref, kind, entry, canonical }));
  lines = [...new Map(lines.map((line) => [line.targetLineKey, line])).values()]
    .filter((line) => line.itemId && line.quantity > EPSILON);
  if (!lines.length) throw new Error(`${ref} has no available Sales Order item lines.`);
  lines = await applyExistingAllocations(ref, lines);
  const memberRefs = [...new Set(entries.map((entry) => text(entry.id)).filter(Boolean))];
  const signature = crypto.createHash("sha256").update(JSON.stringify({
    ref,
    kind,
    memberRefs,
    lines: lines.map((line) => [line.targetLineKey, line.itemId, Number(line.quantity.toFixed(6))])
  })).digest("hex");
  return {
    target: {
      ref,
      kind,
      planId: snapshot?.planned ? snapshot.planId : null,
      planDate: snapshot?.planDate || dateOnly(planDate),
      memberRefs,
      customer: exactCanonical?.customer || order.customer || "",
      outboundLocation: exactCanonical?.outbound_location || order.sourceYard || order.pickupLocations?.[0] || ""
    },
    signature,
    lines
  };
}

export async function remapDispatchLinksToMaterializedSplit(order = {}, splitOrderId) {
  const targetRef = text(order.id);
  const parentRef = splitParentRef(order);
  if (!targetRef || !parentRef || !Number.isInteger(Number(splitOrderId))) return { dependencies: 0, poAllocations: 0 };
  const canonical = await loadCanonicalOrders([targetRef, parentRef]);
  const splitLines = canonical.lines.get(targetRef) || [];
  const parentLines = canonical.lines.get(parentRef) || [];
  let dependencyCount = 0;
  let poAllocationCount = 0;
  for (const item of order.items || []) {
    const parentLine = parentLines.find((line) => lineMatchesItem(line, item));
    const splitLine = splitLines.find((line) => lineMatchesItem(line, item, { allowRowId: false }));
    if (!parentLine || !splitLine) continue;
    const sourceIdentity = sourceLineIdentity(item, parentLine);
    const previousKey = targetLineKey(targetRef, parentRef, sourceIdentity);
    const materializedKey = targetLineKey(targetRef, targetRef, sourceIdentity);
    const dependencyUpdate = await query(
      `UPDATE order_dependency_lines line
          SET sales_line_id = $2,
              dispatch_target_line_key = $4,
              updated_at = now()
         FROM order_dependencies dependency
        WHERE dependency.id = line.dependency_id
          AND dependency.dispatch_target_ref = $1
          AND line.dispatch_target_line_key = $3
          AND line.line_role = 'sales_allocation'`,
      [targetRef, splitLine.id, previousKey, materializedKey]
    );
    dependencyCount += dependencyUpdate.rowCount;
    const poUpdate = await query(
      `UPDATE dispatch_so_po_allocations
          SET sales_order_id = $2,
              sales_order_ref = $3,
              sales_line_id = $4,
              dispatch_target_line_key = $6,
              updated_at = now()
        WHERE dispatch_target_ref = $1
          AND dispatch_target_line_key = $5
          AND status = 'active'`,
      [targetRef, Number(splitOrderId), targetRef, splitLine.id, previousKey, materializedKey]
    );
    poAllocationCount += poUpdate.rowCount;
  }
  await query(
    `UPDATE order_dependencies
        SET sales_order_id = $2, sales_order_ref = $1, updated_at = now()
      WHERE dispatch_target_ref = $1 AND dispatch_target_kind = 'split' AND status <> 'cancelled'`,
    [targetRef, Number(splitOrderId)]
  );
  return { dependencies: dependencyCount, poAllocations: poAllocationCount };
}

export function dispatchTargetLineKey(targetRef, sourceOrderRef, sourceLineIdentityValue) {
  return targetLineKey(targetRef, sourceOrderRef, sourceLineIdentityValue);
}
