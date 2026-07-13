import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import {
  getDeliveryOrdersBatch,
  markConsolidationDeliveryOrderPacked,
  releaseConsolidationDeliveryOrder,
  setConsolidationDeliveryLinePackedQuantity
} from "./delivery-repository.js";

const EPSILON = 0.000001;
const PICKABLE_TYPES = new Set(["InvtPart", "NonInvtPart"]);
const UNIT_META = {
  pallets: { label: "PLT", packed: "packed_pallet_qty", required: "pallet_qty", conversion: "to_plt" },
  layers: { label: "LYR", packed: "packed_layer_qty", required: "layer_qty", conversion: "to_lyr" },
  sections: { label: "SEC", packed: "packed_section_qty", required: "section_qty", conversion: "to_sec" },
  pieces: { label: "PCS", packed: "packed_piece_qty", required: "piece_qty", conversion: "to_pcs" }
};

function number(value) {
  const parsed = Number(String(value ?? 0).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function quantity(value) {
  return Math.max(0, number(value));
}

function rounded(value) {
  return Number(number(value).toFixed(6));
}

function pickableLine(line = {}) {
  const itemName = String(line.sku || line.item_name || "").trim().toUpperCase();
  return PICKABLE_TYPES.has(String(line.item_type || ""))
    && !itemName.startsWith("DELIVERY CHARGE")
    && !itemName.startsWith("SALES CREDIT")
    && line.netsuite_active !== false;
}

function hasConversion(line = {}) {
  return Object.values(UNIT_META).some((unit) => quantity(line[unit.conversion]) > 0);
}

function lineSalesQuantity(line, values) {
  if (!hasConversion(line)) return quantity(values?.pieces);
  return Object.entries(UNIT_META).reduce((total, [key, unit]) => {
    return total + (quantity(values?.[key]) * quantity(line[unit.conversion]));
  }, 0);
}

function requiredSalesQuantity(line = {}) {
  return quantity(line.quantity) || lineSalesQuantity(line, {
    pallets: line.pallet_qty,
    layers: line.layer_qty,
    sections: line.section_qty,
    pieces: line.piece_qty
  });
}

function packedValues(line = {}) {
  return Object.fromEntries(Object.entries(UNIT_META).map(([key, unit]) => [key, quantity(line[unit.packed])]));
}

function loadedUnitConsumption(line = {}) {
  let loadedSales = quantity(line.loaded_qty);
  const result = {};
  for (const key of ["pallets", "layers", "sections", "pieces"]) {
    const unit = UNIT_META[key];
    const required = quantity(line[unit.required]);
    const conversion = quantity(line[unit.conversion]);
    if (!required || !conversion || loadedSales <= 0) {
      result[key] = 0;
      continue;
    }
    const consumed = Math.min(required, Math.floor((loadedSales / conversion) + EPSILON));
    result[key] = consumed;
    loadedSales = Math.max(0, loadedSales - (consumed * conversion));
  }
  return result;
}

function derivedWholeUnits(salesQuantity, conversion) {
  if (!salesQuantity || !conversion) return 0;
  const raw = salesQuantity / conversion;
  const nearest = Math.round(raw);
  return Math.abs(raw - nearest) <= 0.01 ? nearest : Math.floor(raw + EPSILON);
}

function lineUnitCapacity(line = {}) {
  const loadedSales = quantity(line.loaded_qty);
  if (!hasConversion(line)) {
    return { pieces: rounded(Math.max(0, requiredSalesQuantity(line) - loadedSales)) };
  }
  const explicitKeys = Object.entries(UNIT_META)
    .filter(([, unit]) => quantity(line[unit.required]) > 0)
    .map(([key]) => key);
  if (explicitKeys.length) {
    const consumed = loadedUnitConsumption(line);
    return Object.fromEntries(explicitKeys.map((key) => [
      key,
      rounded(Math.max(0, quantity(line[UNIT_META[key].required]) - quantity(consumed[key])))
    ]));
  }

  const remainingSales = Math.max(0, requiredSalesQuantity(line) - loadedSales);
  for (const key of ["pallets", "sections", "layers", "pieces"]) {
    const conversion = quantity(line[UNIT_META[key].conversion]);
    const units = derivedWholeUnits(remainingSales, conversion);
    if (conversion && units > 0) return { [key]: rounded(units) };
  }
  return { pieces: rounded(remainingSales) };
}

function contributionValues(row = {}) {
  return {
    pallets: quantity(row.confirmed_pallet_qty),
    layers: quantity(row.confirmed_layer_qty),
    sections: quantity(row.confirmed_section_qty),
    pieces: quantity(row.confirmed_piece_qty)
  };
}

function desiredValues(values = {}) {
  return {
    pallets: rounded(quantity(values.pallets)),
    layers: rounded(quantity(values.layers)),
    sections: rounded(quantity(values.sections)),
    pieces: rounded(quantity(values.pieces))
  };
}

function orderCanonicalMembers(order = {}) {
  if (order.is_dispatch_group) {
    return (order.child_orders || []).map((child) => ({
      id: Number(child.netsuite_id),
      ref: String(child.tranid || child.netsuite_id)
    })).filter((child) => Number.isSafeInteger(child.id));
  }
  const id = Number(order.netsuite_id);
  return Number.isSafeInteger(id) ? [{ id, ref: String(order.tranid || id) }] : [];
}

function orderHasOpenQuantity(order = {}) {
  return (order.lines || []).filter(pickableLine).some((line) => {
    const capacities = lineUnitCapacity(line);
    const packed = packedValues(line);
    return Object.entries(capacities).some(([key, capacity]) => capacity > quantity(packed[key]) + EPSILON);
  });
}

function orderIsComplete(order = {}) {
  const yardStatus = String(order.local_yard_order_status || "").toLowerCase();
  const status = String(order.operator_status || "").toLowerCase();
  return !orderHasOpenQuantity(order) && ["packed", "loaded", "shipped", "fulfilled"].includes(yardStatus || status);
}

function orderAvailabilityIssue(order, locationId, activeClaims = new Map(), operatorId = "") {
  if (!order) return "Order details are no longer available.";
  if (String(order.outbound_location_id || "") !== String(locationId || "")) {
    return `Order moved to yard ${order.outbound_location || order.outbound_location_id || "unknown"}.`;
  }
  if (orderIsComplete(order) || !orderHasOpenQuantity(order)) return "Order has no remaining quantity to pick.";
  const members = orderCanonicalMembers(order);
  if (!members.length) return "Grouped order membership is invalid.";
  const preparingBy = members
    .map((member) => (order.child_orders || []).find((child) => Number(child.netsuite_id) === member.id) || order)
    .find((memberOrder) => memberOrder.preparing_operator_id && String(memberOrder.preparing_operator_id) !== String(operatorId));
  if (preparingBy) return "Order is preparing on another operator account.";
  const existingClaim = members.map((member) => activeClaims.get(member.id)).find(Boolean);
  if (existingClaim) return `Order is reserved by ${existingClaim.operator_name || "another operator"}.`;
  if (members.some((member) => {
    const memberOrder = (order.child_orders || []).find((child) => Number(child.netsuite_id) === member.id) || order;
    return memberOrder.preparing_operator_id && String(memberOrder.preparing_operator_id) === String(operatorId);
  })) return "Finish or release the current ordinary preparation before consolidation.";
  return "";
}

async function activeClaimsByCanonicalOrder() {
  const result = await query(
    `SELECT claim.canonical_order_id,
            b.operator_id,
            COALESCE(op.display_name, op.username, b.operator_id) AS operator_name,
            o.order_ref
       FROM operator_consolidation_claims claim
       JOIN operator_consolidation_orders o ON o.id = claim.batch_order_id
       JOIN operator_consolidation_batches b ON b.id = o.batch_id AND b.status = 'active'
       LEFT JOIN operators op ON op.id = b.operator_id
      WHERE claim.released_at IS NULL`
  );
  return new Map(result.rows.map((row) => [Number(row.canonical_order_id), row]));
}

async function savedSalesQueue(operatorId, locationId) {
  const savedResult = await query(
    `SELECT order_key, order_ref, order_type, created_at
       FROM operator_saved_delivery_orders
      WHERE operator_id = $1
        AND location_id = $2
        AND order_type IN ('sales_order', 'group_order')
      ORDER BY created_at, order_ref`,
    [operatorId, locationId]
  );
  const orders = await getDeliveryOrdersBatch(savedResult.rows.map((row) => row.order_key));
  const orderByKey = new Map(orders.map((order) => [String(order.netsuite_id), order]));
  return savedResult.rows.map((saved) => ({ saved, order: orderByKey.get(String(saved.order_key)) || null }));
}

export async function getSavedConsolidationQueue(operatorId, { locationId } = {}) {
  if (!operatorId) throw new Error("Operator login is required.");
  if (!locationId) throw new Error("Location is required.");
  const queue = await savedSalesQueue(operatorId, locationId);
  const claims = await activeClaimsByCanonicalOrder();
  const rows = queue.map(({ saved, order }) => {
    const issue = orderAvailabilityIssue(order, locationId, claims, operatorId);
    return {
      orderKey: saved.order_key,
      orderRef: order?.tranid || saved.order_ref,
      orderType: saved.order_type,
      savedAt: saved.created_at,
      eligible: !issue,
      issue,
      planDate: order?.dispatch_plan_date || null,
      truckPlate: order?.dispatch_truck_plate || "",
      loadName: order?.dispatch_load_name || "",
      customer: order?.customer || "",
      lineCount: (order?.lines || []).filter(pickableLine).length
    };
  });
  return {
    total: rows.length,
    eligible: rows.filter((row) => row.eligible).length,
    blocked: rows.filter((row) => !row.eligible).length,
    orders: rows
  };
}

async function activeBatchRow(operatorId, locationId) {
  const result = await query(
    `SELECT *
       FROM operator_consolidation_batches
      WHERE operator_id = $1
        AND location_id = $2
        AND status = 'active'
      ORDER BY started_at DESC
      LIMIT 1`,
    [operatorId, locationId]
  );
  return result.rows[0] || null;
}

async function loadBatchRows(batchId) {
  const orders = await query(`SELECT * FROM operator_consolidation_orders WHERE batch_id = $1 ORDER BY dispatch_plan_date, dispatch_truck_plate, dispatch_load_name, order_ref`, [batchId]);
  const claims = await query(`SELECT * FROM operator_consolidation_claims WHERE batch_order_id IN (SELECT id FROM operator_consolidation_orders WHERE batch_id = $1)`, [batchId]);
  const lines = await query(`SELECT * FROM operator_consolidation_lines WHERE batch_order_id IN (SELECT id FROM operator_consolidation_orders WHERE batch_id = $1)`, [batchId]);
  return { orders: orders.rows, claims: claims.rows, lines: lines.rows };
}

function lineContributionMap(rows = []) {
  return new Map(rows.map((row) => [`${row.batch_order_id}:${row.line_key}`, row]));
}

function lineView(line, batchOrder, contributionRow) {
  const capacity = lineUnitCapacity(line);
  const packed = packedValues(line);
  const contribution = contributionValues(contributionRow);
  const keys = Object.keys(capacity);
  const units = keys.map((key) => {
    const otherPacked = Math.max(0, quantity(packed[key]) - quantity(contribution[key]));
    const required = Math.max(0, quantity(capacity[key]) - otherPacked);
    const confirmed = quantity(contribution[key]);
    return {
      key,
      label: hasConversion(line) ? UNIT_META[key].label : (line.unit || "Qty"),
      required: rounded(required),
      confirmed: rounded(confirmed),
      remaining: rounded(Math.max(0, required - confirmed))
    };
  });
  const overConfirmed = units.some((unit) => unit.confirmed > unit.required + EPSILON);
  return {
    batchOrderId: batchOrder.id,
    orderKey: batchOrder.order_key,
    orderRef: batchOrder.order_ref,
    planDate: batchOrder.dispatch_plan_date,
    truckPlate: batchOrder.dispatch_truck_plate,
    loadName: batchOrder.dispatch_load_name,
    lineKey: String(line.id),
    itemId: String(line.item_id || ""),
    itemName: line.sku || line.item_name || "Item",
    description: line.item_description || "",
    salesUom: line.unit || "",
    syncException: line.sync_exception || (overConfirmed ? "Confirmed quantity exceeds the latest required quantity." : null),
    units
  };
}

function itemKey(line) {
  return [line.itemId, line.itemName, line.salesUom].join("|");
}

function buildBatchState(batch, stored, liveOrders) {
  const liveByKey = new Map(liveOrders.map((order) => [String(order.netsuite_id), order]));
  const contributions = lineContributionMap(stored.lines);
  const itemMap = new Map();
  const orderViews = [];

  for (const batchOrder of stored.orders) {
    const live = liveByKey.get(String(batchOrder.order_key));
    const lines = (live?.lines || []).filter(pickableLine).map((line) => {
      return lineView(line, batchOrder, contributions.get(`${batchOrder.id}:${line.id}`));
    });
    const attention = !live
      || String(live.outbound_location_id || "") !== String(batch.location_id)
      || lines.some((line) => line.syncException);
    const ready = !attention && lines.length > 0 && lines.every((line) => !line.syncException && line.units.every((unit) => unit.remaining <= EPSILON));
    const status = batchOrder.status === "packed" ? "packed" : attention ? "attention" : ready ? "ready" : "picking";
    const orderView = {
      id: batchOrder.id,
      orderKey: batchOrder.order_key,
      orderRef: live?.tranid || batchOrder.order_ref,
      orderType: batchOrder.order_type,
      status,
      planDate: live?.dispatch_plan_date || batchOrder.dispatch_plan_date,
      truckPlate: live?.dispatch_truck_plate || batchOrder.dispatch_truck_plate,
      loadName: live?.dispatch_load_name || batchOrder.dispatch_load_name,
      customer: live?.customer || "",
      lines
    };
    orderViews.push(orderView);
    for (const line of lines) {
      const key = itemKey(line);
      if (!itemMap.has(key)) {
        itemMap.set(key, {
          key,
          itemId: line.itemId,
          itemName: line.itemName,
          description: line.description,
          salesUom: line.salesUom,
          totals: {},
          allocations: []
        });
      }
      const item = itemMap.get(key);
      item.allocations.push(line);
      for (const unit of line.units) {
        const total = item.totals[unit.key] || { key: unit.key, label: unit.label, required: 0, confirmed: 0, remaining: 0 };
        total.required = rounded(total.required + unit.required);
        total.confirmed = rounded(total.confirmed + unit.confirmed);
        total.remaining = rounded(total.remaining + unit.remaining);
        item.totals[unit.key] = total;
      }
    }
  }

  return {
    batch: {
      id: batch.id,
      operatorId: batch.operator_id,
      locationId: batch.location_id,
      status: batch.status,
      startedAt: batch.started_at,
      updatedAt: batch.updated_at
    },
    summary: {
      orders: orderViews.length,
      picking: orderViews.filter((order) => order.status === "picking").length,
      ready: orderViews.filter((order) => order.status === "ready").length,
      packed: orderViews.filter((order) => order.status === "packed").length,
      attention: orderViews.filter((order) => order.status === "attention").length,
      items: itemMap.size
    },
    orders: orderViews,
    items: [...itemMap.values()].map((item) => ({ ...item, totals: Object.values(item.totals) }))
      .sort((left, right) => left.itemName.localeCompare(right.itemName, undefined, { numeric: true, sensitivity: "base" }))
  };
}

async function getBatchState(batch) {
  if (!batch) return null;
  const stored = await loadBatchRows(batch.id);
  const liveOrders = await getDeliveryOrdersBatch(stored.orders.map((order) => order.order_key));
  return buildBatchState(batch, stored, liveOrders);
}

export async function getActiveConsolidationBatch(operatorId, { locationId } = {}) {
  if (!operatorId || !locationId) return null;
  return getBatchState(await activeBatchRow(operatorId, locationId));
}

function conflictError(message, details = []) {
  const error = new Error(message);
  error.status = 409;
  error.code = "CONSOLIDATION_BATCH_BLOCKED";
  error.details = details;
  return error;
}

export async function startSavedConsolidationBatch(operatorId, { locationId } = {}) {
  if (!operatorId) throw new Error("Operator login is required.");
  if (!locationId) throw new Error("Location is required.");
  return withTransaction(async () => {
    const existing = await activeBatchRow(operatorId, locationId);
    if (existing) return getBatchState(existing);
    const queue = await savedSalesQueue(operatorId, locationId);
    const claims = await activeClaimsByCanonicalOrder();
    if (!queue.length) throw conflictError("Save at least one Sales Order before starting consolidation.");

    const staleKeys = queue
      .filter(({ order }) => !order || orderIsComplete(order))
      .map(({ saved }) => String(saved.order_key));
    if (staleKeys.length) {
      await query(
        `DELETE FROM operator_saved_delivery_orders
          WHERE operator_id = $1
            AND location_id = $2
            AND order_key = ANY($3::text[])`,
        [operatorId, locationId, staleKeys]
      );
    }
    const candidates = queue.filter(({ saved }) => !staleKeys.includes(String(saved.order_key)));
    if (!candidates.length) throw conflictError("Saved Sales Orders have no remaining quantity to consolidate.");
    const blockers = candidates.map(({ saved, order }) => ({
      orderKey: saved.order_key,
      orderRef: order?.tranid || saved.order_ref,
      issue: orderAvailabilityIssue(order, locationId, claims, operatorId)
    })).filter((item) => item.issue);
    if (blockers.length) throw conflictError("Consolidation cannot start until every saved Sales Order is available.", blockers);

    const batchResult = await query(
      `INSERT INTO operator_consolidation_batches (operator_id, location_id)
       VALUES ($1, $2)
       RETURNING *`,
      [operatorId, locationId]
    );
    const batch = batchResult.rows[0];
    const claimedIds = [];
    for (const { saved, order } of candidates) {
      const orderResult = await query(
        `INSERT INTO operator_consolidation_orders (
           batch_id, order_key, order_ref, order_type,
           dispatch_plan_date, dispatch_truck_plate, dispatch_load_name
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          batch.id,
          String(order.netsuite_id),
          order.tranid || saved.order_ref,
          order.is_dispatch_group ? "group_order" : "sales_order",
          order.dispatch_plan_date || null,
          order.dispatch_truck_plate || "",
          order.dispatch_load_name || ""
        ]
      );
      for (const member of orderCanonicalMembers(order)) {
        await query(
          `INSERT INTO operator_consolidation_claims (batch_order_id, canonical_order_id, canonical_order_ref)
           VALUES ($1, $2, $3)`,
          [orderResult.rows[0].id, member.id, member.ref]
        );
        claimedIds.push(member.id);
      }
    }
    await query(
      `UPDATE sales_orders
          SET operator_status = 'preparing',
              preparing_operator_id = $2,
              preparing_started_at = COALESCE(preparing_started_at, now()),
              status_updated_at = now()
        WHERE netsuite_id = ANY($1::bigint[])`,
      [[...new Set(claimedIds)], operatorId]
    );
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.consolidation.batch.started",
      details: { batchId: batch.id, locationId, orders: candidates.map(({ order }) => order.tranid) }
    });
    return getBatchState(batch);
  });
}

async function ownedBatchOrder(operatorId, batchOrderId) {
  const result = await query(
    `SELECT o.*, b.operator_id, b.location_id, b.status AS batch_status
       FROM operator_consolidation_orders o
       JOIN operator_consolidation_batches b ON b.id = o.batch_id
      WHERE o.id = $1
        AND b.operator_id = $2
        AND b.status = 'active'
      FOR UPDATE`,
    [batchOrderId, operatorId]
  );
  if (!result.rowCount) throw conflictError("Active consolidation order not found for this operator.");
  return result.rows[0];
}

async function applyConsolidationLineUpdate(operatorId, batchOrderId, lineKey, values = {}) {
  const storedOrder = await ownedBatchOrder(operatorId, batchOrderId);
  if (storedOrder.status === "packed") throw conflictError("Packed consolidation orders cannot be changed.");
  const [order] = await getDeliveryOrdersBatch([storedOrder.order_key]);
  if (!order) throw conflictError("The source Sales Order is no longer available.");
  const line = (order.lines || []).find((item) => String(item.id) === String(lineKey));
  if (!line || !pickableLine(line)) throw conflictError("Consolidation line is no longer available.");
  if (line.sync_exception) throw conflictError("NetSuite changed this line. Correct it before continuing.");
  const previousResult = await query(
    `SELECT * FROM operator_consolidation_lines WHERE batch_order_id = $1 AND line_key = $2 FOR UPDATE`,
    [batchOrderId, String(lineKey)]
  );
  const previous = contributionValues(previousResult.rows[0]);
  const desired = desiredValues(values);
  const capacity = lineUnitCapacity(line);
  const currentPacked = packedValues(line);
  const target = { pallets: 0, layers: 0, sections: 0, pieces: 0 };
  for (const key of Object.keys(target)) {
    const otherPacked = Math.max(0, quantity(currentPacked[key]) - quantity(previous[key]));
    const allowed = Math.max(0, quantity(capacity[key]) - otherPacked);
    if (quantity(desired[key]) > allowed + EPSILON) {
      throw conflictError(`${line.sku || line.item_name} exceeds the remaining ${UNIT_META[key].label} quantity.`);
    }
    target[key] = rounded(otherPacked + quantity(desired[key]));
  }
  await setConsolidationDeliveryLinePackedQuantity(storedOrder.order_key, lineKey, target, operatorId);
  await query(
    `INSERT INTO operator_consolidation_lines (
       batch_order_id, line_key, item_id, item_name, sales_uom,
       confirmed_pallet_qty, confirmed_layer_qty, confirmed_section_qty, confirmed_piece_qty
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (batch_order_id, line_key) DO UPDATE
       SET item_id = EXCLUDED.item_id,
           item_name = EXCLUDED.item_name,
           sales_uom = EXCLUDED.sales_uom,
           confirmed_pallet_qty = EXCLUDED.confirmed_pallet_qty,
           confirmed_layer_qty = EXCLUDED.confirmed_layer_qty,
           confirmed_section_qty = EXCLUDED.confirmed_section_qty,
           confirmed_piece_qty = EXCLUDED.confirmed_piece_qty,
           updated_at = now()`,
    [batchOrderId, String(lineKey), String(line.item_id || ""), line.sku || line.item_name || "Item", line.unit || "", desired.pallets, desired.layers, desired.sections, desired.pieces]
  );
  return { storedOrder, desired };
}

async function refreshConsolidationBatchState(batchId) {
  const batchResult = await query(`SELECT * FROM operator_consolidation_batches WHERE id = $1`, [batchId]);
  const state = await getBatchState(batchResult.rows[0]);
  const statuses = state.orders
    .filter((order) => order.status !== "packed")
    .map((order) => ({
      id: Number(order.id),
      status: order.status === "ready" ? "ready" : order.status === "attention" ? "attention" : "picking"
    }));
  if (statuses.length) {
    await query(
      `UPDATE operator_consolidation_orders target
          SET status = next.status,
              updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS next(id bigint, status text)
        WHERE target.id = next.id`,
      [JSON.stringify(statuses)]
    );
  }
  await query(`UPDATE operator_consolidation_batches SET updated_at = now() WHERE id = $1`, [batchId]);
  return getBatchState((await query(`SELECT * FROM operator_consolidation_batches WHERE id = $1`, [batchId])).rows[0]);
}

export async function updateConsolidationLine(operatorId, batchOrderId, lineKey, values = {}) {
  return withTransaction(async () => {
    const { storedOrder, desired } = await applyConsolidationLineUpdate(operatorId, batchOrderId, lineKey, values);
    const state = await refreshConsolidationBatchState(storedOrder.batch_id);
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.consolidation.line.updated",
      orderId: /^\d+$/.test(String(storedOrder.order_key)) ? storedOrder.order_key : null,
      details: { batchId: storedOrder.batch_id, orderRef: storedOrder.order_ref, lineKey, desired }
    });
    return state;
  });
}

export async function confirmConsolidationItem(operatorId, batchId, itemKey) {
  return withTransaction(async () => {
    const batchResult = await query(
      `SELECT *
         FROM operator_consolidation_batches
        WHERE id = $1
          AND operator_id = $2
          AND status = 'active'
        FOR UPDATE`,
      [batchId, operatorId]
    );
    if (!batchResult.rowCount) throw conflictError("Active consolidation batch not found for this operator.");
    const before = await getBatchState(batchResult.rows[0]);
    const item = before.items.find((candidate) => candidate.key === String(itemKey || ""));
    if (!item) throw conflictError("Consolidation SKU is no longer available.");
    const orderStatus = new Map(before.orders.map((order) => [Number(order.id), order.status]));
    const allocations = item.allocations.filter((allocation) => orderStatus.get(Number(allocation.batchOrderId)) !== "packed");
    if (!allocations.length) throw conflictError("All orders for this SKU are already packed.");
    if (allocations.some((allocation) => allocation.syncException)) {
      throw conflictError("Correct the changed order lines before confirming this SKU.");
    }
    for (const allocation of allocations) {
      const values = Object.fromEntries((allocation.units || []).map((unit) => [unit.key, unit.required]));
      await applyConsolidationLineUpdate(operatorId, allocation.batchOrderId, allocation.lineKey, values);
    }
    const state = await refreshConsolidationBatchState(batchResult.rows[0].id);
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.consolidation.item.confirmed",
      details: {
        batchId: batchResult.rows[0].id,
        itemKey: item.key,
        itemName: item.itemName,
        lineCount: allocations.length
      }
    });
    return state;
  });
}

export async function packConsolidationOrder(operatorId, batchOrderId) {
  return withTransaction(async () => {
    const storedOrder = await ownedBatchOrder(operatorId, batchOrderId);
    const batchResult = await query(`SELECT * FROM operator_consolidation_batches WHERE id = $1 FOR UPDATE`, [storedOrder.batch_id]);
    const before = await getBatchState(batchResult.rows[0]);
    const current = before.orders.find((order) => Number(order.id) === Number(batchOrderId));
    if (!current || current.status !== "ready") throw conflictError("Finish every remaining line before packing this order.");
    await markConsolidationDeliveryOrderPacked(storedOrder.order_key, operatorId);
    await query(
      `UPDATE operator_consolidation_orders SET status = 'packed', packed_at = now(), updated_at = now() WHERE id = $1`,
      [batchOrderId]
    );
    await query(`UPDATE operator_consolidation_claims SET released_at = now() WHERE batch_order_id = $1 AND released_at IS NULL`, [batchOrderId]);
    await query(
      `DELETE FROM operator_saved_delivery_orders
        WHERE operator_id = $1 AND location_id = $2 AND order_key = $3`,
      [operatorId, storedOrder.location_id, storedOrder.order_key]
    );
    const remaining = await query(
      `SELECT COUNT(*)::int AS count FROM operator_consolidation_orders WHERE batch_id = $1 AND status <> 'packed'`,
      [storedOrder.batch_id]
    );
    if (!Number(remaining.rows[0]?.count)) {
      await query(
        `UPDATE operator_consolidation_batches
            SET status = 'completed', completed_at = now(), updated_at = now()
          WHERE id = $1`,
        [storedOrder.batch_id]
      );
    }
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.consolidation.order.packed",
      orderId: /^\d+$/.test(String(storedOrder.order_key)) ? storedOrder.order_key : null,
      details: { batchId: storedOrder.batch_id, orderRef: storedOrder.order_ref }
    });
    const active = await activeBatchRow(operatorId, storedOrder.location_id);
    return active ? getBatchState(active) : { completed: true, batchId: storedOrder.batch_id };
  });
}

export async function releaseConsolidationBatch(operatorId, { locationId } = {}) {
  return withTransaction(async () => {
    const batch = await activeBatchRow(operatorId, locationId);
    if (!batch) return { released: false };
    const stored = await loadBatchRows(batch.id);
    const contributionMap = lineContributionMap(stored.lines);
    const releasableOrders = stored.orders.filter((order) => order.status !== "packed");
    const liveOrders = await getDeliveryOrdersBatch(releasableOrders.map((order) => order.order_key));
    const liveByKey = new Map(liveOrders.map((order) => [String(order.netsuite_id), order]));
    for (const batchOrder of releasableOrders) {
      const order = liveByKey.get(String(batchOrder.order_key));
      if (!order) continue;
      for (const line of (order.lines || []).filter(pickableLine)) {
        const contribution = contributionValues(contributionMap.get(`${batchOrder.id}:${line.id}`));
        const current = packedValues(line);
        const target = Object.fromEntries(Object.keys(current).map((key) => [key, rounded(Math.max(0, current[key] - contribution[key]))]));
        await setConsolidationDeliveryLinePackedQuantity(batchOrder.order_key, line.id, target, operatorId);
      }
      await releaseConsolidationDeliveryOrder(batchOrder.order_key, operatorId);
    }
    await query(
      `UPDATE operator_consolidation_claims
          SET released_at = now()
        WHERE batch_order_id IN (SELECT id FROM operator_consolidation_orders WHERE batch_id = $1)
          AND released_at IS NULL`,
      [batch.id]
    );
    await query(
      `UPDATE operator_consolidation_batches
          SET status = 'released', released_at = now(), updated_at = now()
        WHERE id = $1`,
      [batch.id]
    );
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.consolidation.batch.released",
      details: { batchId: batch.id, locationId }
    });
    return { released: true, batchId: batch.id };
  });
}

export async function hasActiveConsolidationClaim(orderId) {
  const numericId = Number(orderId);
  if (!Number.isSafeInteger(numericId)) return false;
  return Boolean(await activeConsolidationClaimForCanonicalOrder(numericId));
}

export async function assertNoActiveConsolidationClaimsByRefs(orderRefs = [], action = "change") {
  const refs = [...new Set((orderRefs || [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean))];
  if (!refs.length) return;
  const result = await query(
    `SELECT DISTINCT so.tranid,
            b.operator_id,
            COALESCE(op.display_name, op.username, b.operator_id) AS operator_name
       FROM operator_consolidation_claims claim
       JOIN operator_consolidation_orders bo ON bo.id = claim.batch_order_id
       JOIN operator_consolidation_batches b ON b.id = bo.batch_id AND b.status = 'active'
       JOIN sales_orders so ON so.netsuite_id = claim.canonical_order_id
       LEFT JOIN operators op ON op.id = b.operator_id
      WHERE claim.released_at IS NULL
        AND lower(so.tranid) = ANY($1::text[])
      ORDER BY so.tranid`,
    [refs]
  );
  if (!result.rowCount) return;
  const preview = result.rows.map((row) => `${row.tranid} (${row.operator_name})`).join(", ");
  const error = new Error(`Cannot ${action}. Release the active consolidation batch first: ${preview}`);
  error.status = 409;
  error.code = "CONSOLIDATION_ORDER_RESERVED";
  error.details = result.rows;
  throw error;
}

async function activeConsolidationClaimForCanonicalOrder(orderId) {
  const result = await query(
    `SELECT claim.id
       FROM operator_consolidation_claims claim
       JOIN operator_consolidation_orders o ON o.id = claim.batch_order_id
       JOIN operator_consolidation_batches b ON b.id = o.batch_id
      WHERE claim.canonical_order_id = $1
        AND claim.released_at IS NULL
        AND b.status = 'active'
      LIMIT 1`,
    [orderId]
  );
  return result.rows[0] || null;
}
