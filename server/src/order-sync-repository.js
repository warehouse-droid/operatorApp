import { writeAudit } from "./auth-repository.js";
import { query } from "./db.js";
import { enrichPurchaseOrderDispatch, enrichSalesOrderDispatch, enrichTransferDispatch } from "./dispatch-enrichment.js";

function normalizeNetSuiteDate(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return value;
  const [, month, day, year] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number(String(value).replaceAll(",", ""));
}

function normalizeBigintId(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).replaceAll(",", "").trim();
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) {
    return Number(text.replace(".", ""));
  }
  return null;
}

function normalizeQuantity(value) {
  const number = normalizeNumber(value);
  return number === null ? null : Math.abs(number);
}

function comparable(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") return String(value);
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) return String(Number(value));
  return String(value);
}

function changedFields(before, after, fields) {
  const changed = {};
  for (const field of fields) {
    const beforeValue = before?.[field] ?? null;
    const afterValue = after?.[field] ?? null;
    if (comparable(beforeValue) !== comparable(afterValue)) {
      changed[field] = { before: beforeValue, after: afterValue };
    }
  }
  return changed;
}

function normalizeOutboundOrder(order, orderType) {
  return {
    netsuite_id: order.id,
    tranid: order.tranid,
    trandate: normalizeNetSuiteDate(order.trandate),
    customer_id: order.customer_id,
    customer: order.customer,
    status: order.status,
    status_text: order.status_text,
    expected_delivery_date: normalizeNetSuiteDate(order.expected_delivery_date),
    foreign_total: normalizeNumber(order.foreigntotal),
    order_location_id: order.order_location_id,
    order_location: order.order_location,
    outbound_location_id: order.outbound_location_id,
    outbound_location: order.outbound_location,
    delivery_method_id: order.delivery_method_id,
    delivery_method: order.delivery_method,
    memo: order.memo,
    order_type: orderType,
    source_location_id: order.source_location_id,
    source_location: order.source_location,
    destination_location_id: order.destination_location_id,
    destination_location: order.destination_location
  };
}

function normalizeReceivingOrder(order, orderType) {
  return {
    netsuite_id: order.id,
    order_type: orderType,
    tranid: order.tranid,
    trandate: normalizeNetSuiteDate(order.trandate),
    vendor_id: order.vendor_id,
    vendor: order.vendor,
    vendor_address: order.vendor_address || order.vendorAddress || "",
    status: order.status,
    status_text: order.status_text,
    foreign_total: normalizeNumber(order.foreigntotal),
    memo: order.memo,
    source_location_id: order.source_location_id,
    source_location: order.source_location,
    destination_location_id: order.destination_location_id,
    destination_location: order.destination_location
  };
}

function normalizeLine(line) {
  return {
    line_id: normalizeBigintId(line.uniquekey ?? line.line_unique_key ?? line.lineUniqueKey ?? line.line_id),
    item_id: normalizeBigintId(line.item_id),
    item_name: line.item_name,
    item_type: line.item_type,
    item_type_text: line.item_type_text,
    item_description: line.item_description,
    sku: line.sku || line.item_name,
    quantity: normalizeQuantity(line.quantity),
    netsuite_received_qty: normalizeQuantity(line.netsuite_received_qty),
    unit: line.unit,
    item_weight: normalizeNumber(line.item_weight),
    location_id: normalizeBigintId(line.location_id),
    location: line.location,
    pallet_qty: normalizeQuantity(line.pallet_qty),
    layer_qty: normalizeQuantity(line.layer_qty),
    piece_qty: normalizeQuantity(line.piece_qty),
    section_qty: normalizeQuantity(line.section_qty),
    to_plt: normalizeNumber(line.to_plt),
    to_lyr: normalizeNumber(line.to_lyr),
    to_sec: normalizeNumber(line.to_sec),
    to_pcs: normalizeNumber(line.to_pcs),
    raw: line.raw || line
  };
}

function normalizeOrderDates(order) {
  return {
    ...order,
    trandate: normalizeNetSuiteDate(order.trandate),
    expected_delivery_date: normalizeNetSuiteDate(order.expected_delivery_date)
  };
}

async function hydrateLineFromInventory(normalized) {
  if (!normalized?.item_id) return normalized;
  const needsInventoryFallback = [
    "item_weight",
    "to_plt",
    "to_lyr",
    "to_sec",
    "to_pcs"
  ].some((field) => normalized[field] === null || normalized[field] === undefined);
  if (!needsInventoryFallback) return normalized;

  const inventory = await query(
    `SELECT item_weight, to_plt, to_lyr, to_sec, to_pcs
       FROM inventory_items
      WHERE item_id = $1
      LIMIT 1`,
    [normalized.item_id]
  );
  const item = inventory.rows[0];
  if (!item) return normalized;
  return {
    ...normalized,
    item_weight: normalized.item_weight ?? normalizeNumber(item.item_weight),
    to_plt: normalized.to_plt ?? normalizeNumber(item.to_plt),
    to_lyr: normalized.to_lyr ?? normalizeNumber(item.to_lyr),
    to_sec: normalized.to_sec ?? normalizeNumber(item.to_sec),
    to_pcs: normalized.to_pcs ?? normalizeNumber(item.to_pcs)
  };
}

async function auditSyncChange({ action, orderId = null, lineId = null, existing, normalized, fields, detailsKey }) {
  const changes = existing ? changedFields(existing, normalized, fields) : {};
  if (existing && !Object.keys(changes).length) return;
  await writeAudit({
    actorType: "system",
    source: "netsuite",
    action: existing ? `${action}.update` : `${action}.discover`,
    orderId,
    lineId,
    details: existing ? { changes } : { [detailsKey]: normalized }
  });
}

async function rekeyLineIfSingleCandidate({ table, orderColumn, orderId, normalized, stage = null }) {
  if (!normalized.line_id || !normalized.item_id) return null;
  const params = [orderId, normalized.line_id, normalized.item_id, normalized.location_id ?? null];
  const stageClause = stage ? "AND line_stage = $5" : "";
  if (stage) params.push(stage);
  const candidates = await query(
    `SELECT *
       FROM ${table}
      WHERE ${orderColumn} = $1
        ${stageClause}
        AND line_id IS DISTINCT FROM $2
        AND item_id = $3
        AND ($4::bigint IS NULL OR location_id = $4)
        AND netsuite_active = true
      ORDER BY synced_at DESC NULLS LAST, id DESC
      LIMIT 2`,
    params
  );
  if (candidates.rows.length !== 1) return null;

  const previous = candidates.rows[0];
  const updated = await query(
    `UPDATE ${table}
        SET line_id = $2,
            synced_at = now()
      WHERE id = $1
      RETURNING *`,
    [previous.id, normalized.line_id]
  );
  const row = updated.rows[0] || null;
  if (row) {
    await writeAudit({
      actorType: "system",
      source: "netsuite",
      action: "netsuite.line.rekey",
      orderId,
      lineId: normalized.line_id,
      details: {
        table,
        previousLineId: previous.line_id,
        lineId: normalized.line_id,
        itemId: normalized.item_id,
        locationId: normalized.location_id
      }
    });
  }
  return row;
}

async function upsertInventoryItemFromLine(normalized) {
  if (!normalized.item_id) return;
  await query(
    `INSERT INTO inventory_items (
       item_id, item_name, display_name, item_description, item_type,
       item_type_text, stock_unit, item_weight, to_plt, to_lyr, to_sec,
       to_pcs, raw, synced_at
     ) VALUES (
       $1, $2, null, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, now()
     )
     ON CONFLICT (item_id) DO UPDATE SET
       item_name = COALESCE(NULLIF(EXCLUDED.item_name, ''), inventory_items.item_name),
       item_description = COALESCE(NULLIF(EXCLUDED.item_description, ''), inventory_items.item_description),
       item_type = COALESCE(NULLIF(EXCLUDED.item_type, ''), inventory_items.item_type),
       item_type_text = COALESCE(NULLIF(EXCLUDED.item_type_text, ''), inventory_items.item_type_text),
       stock_unit = COALESCE(NULLIF(EXCLUDED.stock_unit, ''), inventory_items.stock_unit),
       item_weight = COALESCE(EXCLUDED.item_weight, inventory_items.item_weight),
       to_plt = COALESCE(EXCLUDED.to_plt, inventory_items.to_plt),
       to_lyr = COALESCE(EXCLUDED.to_lyr, inventory_items.to_lyr),
       to_sec = COALESCE(EXCLUDED.to_sec, inventory_items.to_sec),
       to_pcs = COALESCE(EXCLUDED.to_pcs, inventory_items.to_pcs),
       raw = inventory_items.raw || EXCLUDED.raw,
       synced_at = now()`,
    [
      normalized.item_id,
      normalized.item_name || normalized.sku || String(normalized.item_id),
      normalized.item_description,
      normalized.item_type,
      normalized.item_type_text,
      normalized.unit,
      normalized.item_weight,
      normalized.to_plt,
      normalized.to_lyr,
      normalized.to_sec,
      normalized.to_pcs,
      JSON.stringify({ orderLine: normalized.raw || normalized })
    ]
  );
}

export async function upsertSalesOrders(orders = []) {
  for (const order of orders || []) {
    const dispatch = await enrichSalesOrderDispatch(order);
    const outbound = normalizeOutboundOrder(order, "sales_order");
    const normalized = normalizeOrderDates({
      ...outbound,
      ...dispatch,
      expected_delivery_date: outbound.expected_delivery_date || dispatch.expected_delivery_date
    });
    const existing = await query(
      `SELECT tranid, trandate, customer_id, customer, status, status_text,
              expected_delivery_date, foreign_total, order_location_id, order_location,
              outbound_location_id, outbound_location, delivery_method_id,
              sales_order_type AS delivery_method, netsuite_sales_order_type,
              sales_order_type_override, memo, dispatch_address,
              dispatch_window_start, dispatch_window_end, dispatch_instructions,
              dispatch_parse_source, dispatch_note_hash
         FROM sales_orders
        WHERE netsuite_id = $1`,
      [normalized.netsuite_id]
    );
    const previous = existing.rows[0] || null;
    if (
      previous?.dispatch_parse_source === "manual-dispatch-details"
      && previous.dispatch_note_hash === normalized.dispatch_note_hash
    ) {
      normalized.dispatch_address = previous.dispatch_address;
      normalized.dispatch_window_start = previous.dispatch_window_start;
      normalized.dispatch_window_end = previous.dispatch_window_end;
      normalized.dispatch_instructions = previous.dispatch_instructions;
      normalized.dispatch_parse_source = previous.dispatch_parse_source;
    }

    await query(
      `INSERT INTO sales_orders (
         netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
         foreign_total, order_location_id, order_location, outbound_location_id,
         outbound_location, delivery_method_id, sales_order_type,
         netsuite_sales_order_type, memo,
         expected_delivery_date, dispatch_address, dispatch_window_start,
         dispatch_window_end, dispatch_instructions, dispatch_parse_source,
         dispatch_note_hash, dispatch_parsed_at, operator_status,
         local_yard_order_status, netsuite_active, netsuite_missing_at,
         synced_at, fulfillment_status, dispatch_planned, status_updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14, $14, $15,
         $16, $17, $18, $19, $20, $21, $22, now(),
         'open', 'Open', true, null, now(), 'not_fulfilled', false, now()
       )
       ON CONFLICT (netsuite_id) DO UPDATE SET
         tranid = EXCLUDED.tranid,
         trandate = EXCLUDED.trandate,
         customer_id = EXCLUDED.customer_id,
         customer = EXCLUDED.customer,
         status_updated_at = CASE
           WHEN sales_orders.status IS DISTINCT FROM EXCLUDED.status
             OR sales_orders.status_text IS DISTINCT FROM EXCLUDED.status_text
           THEN now()
           ELSE sales_orders.status_updated_at
         END,
         status = EXCLUDED.status,
         status_text = EXCLUDED.status_text,
         foreign_total = EXCLUDED.foreign_total,
         order_location_id = EXCLUDED.order_location_id,
         order_location = EXCLUDED.order_location,
         outbound_location_id = EXCLUDED.outbound_location_id,
         outbound_location = EXCLUDED.outbound_location,
         delivery_method_id = EXCLUDED.delivery_method_id,
         sales_order_type = CASE
           WHEN COALESCE(sales_orders.sales_order_type_override, false) THEN sales_orders.sales_order_type
           ELSE EXCLUDED.sales_order_type
         END,
         netsuite_sales_order_type = EXCLUDED.netsuite_sales_order_type,
         memo = EXCLUDED.memo,
         expected_delivery_date = EXCLUDED.expected_delivery_date,
         dispatch_address = EXCLUDED.dispatch_address,
         dispatch_window_start = EXCLUDED.dispatch_window_start,
         dispatch_window_end = EXCLUDED.dispatch_window_end,
         dispatch_instructions = EXCLUDED.dispatch_instructions,
         dispatch_parse_source = EXCLUDED.dispatch_parse_source,
         dispatch_note_hash = EXCLUDED.dispatch_note_hash,
         dispatch_parsed_at = CASE
           WHEN sales_orders.dispatch_note_hash IS DISTINCT FROM EXCLUDED.dispatch_note_hash THEN now()
           ELSE sales_orders.dispatch_parsed_at
         END,
         netsuite_active = true,
         netsuite_missing_at = null,
         synced_at = now()`,
      [
        normalized.netsuite_id,
        normalized.tranid,
        normalized.trandate,
        normalized.customer_id,
        normalized.customer,
        normalized.status,
        normalized.status_text,
        normalized.foreign_total,
        normalized.order_location_id,
        normalized.order_location,
        normalized.outbound_location_id,
        normalized.outbound_location,
        normalized.delivery_method_id,
        normalized.delivery_method,
        normalized.memo,
        normalized.expected_delivery_date,
        normalized.dispatch_address,
        normalized.dispatch_window_start,
        normalized.dispatch_window_end,
        normalized.dispatch_instructions,
        normalized.dispatch_parse_source,
        normalized.dispatch_note_hash
      ]
    );

    await auditSyncChange({
      action: "netsuite.order",
      orderId: normalized.netsuite_id,
      existing: previous,
      normalized,
      fields: [
        "tranid", "trandate", "customer_id", "customer", "status", "status_text",
        "expected_delivery_date", "foreign_total", "order_location_id", "order_location",
        "outbound_location_id", "outbound_location", "delivery_method_id", "delivery_method",
        "memo", "dispatch_address", "dispatch_window_start", "dispatch_window_end",
        "dispatch_instructions", "dispatch_parse_source", "dispatch_note_hash"
      ],
      detailsKey: "order"
    });
  }
}

export async function upsertOutboundTransferOrders(orders = []) {
  for (const order of orders || []) {
    const dispatch = enrichTransferDispatch(order);
    const normalized = normalizeOrderDates({ ...normalizeOutboundOrder(order, "transfer_order"), ...dispatch });
    const existing = await query(
      `SELECT tranid, trandate, status, status_text, from_location_id AS source_location_id,
              from_location AS source_location, to_location_id AS destination_location_id,
              to_location AS destination_location, memo, dispatch_address,
              dispatch_window_start, dispatch_window_end, dispatch_instructions,
              dispatch_parse_source, dispatch_note_hash
         FROM transfer_orders
        WHERE netsuite_id = $1`,
      [normalized.netsuite_id]
    );
    const previous = existing.rows[0] || null;
    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, trandate, status, status_text,
         from_location_id, from_location, to_location_id, to_location,
         outbound_operator_status, local_yard_order_status, fulfillment_status,
         netsuite_active, netsuite_missing_at, synced_at, memo,
         expected_delivery_date, dispatch_address, dispatch_window_start,
         dispatch_window_end, dispatch_instructions, dispatch_parse_source,
         dispatch_note_hash, dispatch_parsed_at, dispatch_planned,
         status_updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         'open', 'Open', 'not_fulfilled', true, null, now(), $10,
         $11, $12, $13, $14, $15, $16, $17, now(), false, now()
       )
       ON CONFLICT (netsuite_id) DO UPDATE SET
         tranid = EXCLUDED.tranid,
         trandate = EXCLUDED.trandate,
         status_updated_at = CASE
           WHEN transfer_orders.status IS DISTINCT FROM EXCLUDED.status
             OR transfer_orders.status_text IS DISTINCT FROM EXCLUDED.status_text
           THEN now()
           ELSE transfer_orders.status_updated_at
         END,
         status = EXCLUDED.status,
         status_text = EXCLUDED.status_text,
         from_location_id = EXCLUDED.from_location_id,
         from_location = EXCLUDED.from_location,
         to_location_id = EXCLUDED.to_location_id,
         to_location = EXCLUDED.to_location,
         memo = EXCLUDED.memo,
         expected_delivery_date = EXCLUDED.expected_delivery_date,
         dispatch_address = EXCLUDED.dispatch_address,
         dispatch_window_start = EXCLUDED.dispatch_window_start,
         dispatch_window_end = EXCLUDED.dispatch_window_end,
         dispatch_instructions = EXCLUDED.dispatch_instructions,
         dispatch_parse_source = EXCLUDED.dispatch_parse_source,
         dispatch_note_hash = EXCLUDED.dispatch_note_hash,
         dispatch_parsed_at = CASE
           WHEN transfer_orders.dispatch_note_hash IS DISTINCT FROM EXCLUDED.dispatch_note_hash THEN now()
           ELSE transfer_orders.dispatch_parsed_at
         END,
         netsuite_active = true,
         netsuite_missing_at = null,
         synced_at = now()`,
      [
        normalized.netsuite_id,
        normalized.tranid,
        normalized.trandate,
        normalized.status,
        normalized.status_text,
        normalized.source_location_id || normalized.outbound_location_id,
        normalized.source_location || normalized.outbound_location,
        normalized.destination_location_id,
        normalized.destination_location,
        normalized.memo,
        normalized.expected_delivery_date,
        normalized.dispatch_address,
        normalized.dispatch_window_start,
        normalized.dispatch_window_end,
        normalized.dispatch_instructions,
        normalized.dispatch_parse_source,
        normalized.dispatch_note_hash
      ]
    );
    await auditSyncChange({
      action: "netsuite.order",
      orderId: normalized.netsuite_id,
      existing: previous,
      normalized,
      fields: [
        "tranid", "trandate", "status", "status_text", "source_location_id",
        "source_location", "destination_location_id", "destination_location",
        "memo", "dispatch_address", "dispatch_window_start", "dispatch_window_end",
        "dispatch_instructions", "dispatch_parse_source", "dispatch_note_hash"
      ],
      detailsKey: "order"
    });
  }
}

export async function upsertSalesOrderLines(orderId, lines = []) {
  for (const line of lines || []) {
    const normalized = await hydrateLineFromInventory(normalizeLine(line));
    let existing = await query(
      `SELECT *
         FROM sales_order_lines
        WHERE sales_order_id = $1
          AND line_id = $2`,
      [orderId, normalized.line_id]
    );
    if (!existing.rows[0]) {
      const rekeyed = await rekeyLineIfSingleCandidate({
        table: "sales_order_lines",
        orderColumn: "sales_order_id",
        orderId,
        normalized
      });
      if (rekeyed) existing = { rows: [rekeyed] };
    }
    await query(
      `INSERT INTO sales_order_lines (
         sales_order_id, line_id, item_id, item_name, item_type, item_type_text,
         item_description, sku, quantity, unit, item_weight, location_id,
         location, pallet_qty, layer_qty, piece_qty, section_qty, to_plt,
         to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom, netsuite_active, sync_exception,
         sync_exception_at, synced_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19,
         $20, $21, COALESCE($22::numeric, 0), $23, true, null, null, now()
       )
       ON CONFLICT (sales_order_id, line_id) DO UPDATE SET
         item_id = EXCLUDED.item_id,
         item_name = EXCLUDED.item_name,
         item_type = EXCLUDED.item_type,
         item_type_text = EXCLUDED.item_type_text,
         item_description = EXCLUDED.item_description,
         sku = EXCLUDED.sku,
         quantity = EXCLUDED.quantity,
         unit = EXCLUDED.unit,
         item_weight = EXCLUDED.item_weight,
         location_id = EXCLUDED.location_id,
         location = EXCLUDED.location,
         loaded_qty = GREATEST(COALESCE(sales_order_lines.loaded_qty, 0), COALESCE(EXCLUDED.loaded_qty, 0)),
         loaded_uom = CASE
           WHEN GREATEST(COALESCE(sales_order_lines.loaded_qty, 0), COALESCE(EXCLUDED.loaded_qty, 0)) > 0
           THEN COALESCE(NULLIF(sales_order_lines.loaded_uom, ''), EXCLUDED.unit)
           ELSE sales_order_lines.loaded_uom
         END,
         sync_exception = CASE
           WHEN (
             COALESCE(sales_order_lines.packed_pallet_qty, 0) > COALESCE(EXCLUDED.pallet_qty, 0)
             OR COALESCE(sales_order_lines.packed_layer_qty, 0) > COALESCE(EXCLUDED.layer_qty, 0)
             OR COALESCE(sales_order_lines.packed_piece_qty, 0) > COALESCE(EXCLUDED.piece_qty, EXCLUDED.quantity, 0)
             OR COALESCE(sales_order_lines.packed_section_qty, 0) > COALESCE(EXCLUDED.section_qty, 0)
           ) THEN 'qty_reduced'
           ELSE null
         END,
         sync_exception_at = CASE
           WHEN (
             COALESCE(sales_order_lines.packed_pallet_qty, 0) > COALESCE(EXCLUDED.pallet_qty, 0)
             OR COALESCE(sales_order_lines.packed_layer_qty, 0) > COALESCE(EXCLUDED.layer_qty, 0)
             OR COALESCE(sales_order_lines.packed_piece_qty, 0) > COALESCE(EXCLUDED.piece_qty, EXCLUDED.quantity, 0)
             OR COALESCE(sales_order_lines.packed_section_qty, 0) > COALESCE(EXCLUDED.section_qty, 0)
           ) THEN now()
           ELSE null
         END,
         pallet_qty = EXCLUDED.pallet_qty,
         layer_qty = EXCLUDED.layer_qty,
         piece_qty = EXCLUDED.piece_qty,
         section_qty = EXCLUDED.section_qty,
         to_plt = EXCLUDED.to_plt,
         to_lyr = EXCLUDED.to_lyr,
         to_sec = EXCLUDED.to_sec,
         to_pcs = EXCLUDED.to_pcs,
         netsuite_active = true,
         synced_at = now()`,
      [
        orderId,
        normalized.line_id,
        normalized.item_id,
        normalized.item_name,
        normalized.item_type,
        normalized.item_type_text,
        normalized.item_description,
        normalized.sku,
        normalized.quantity,
        normalized.unit,
        normalized.item_weight,
        normalized.location_id,
        normalized.location,
        normalized.pallet_qty,
        normalized.layer_qty,
        normalized.piece_qty,
        normalized.section_qty,
        normalized.to_plt,
        normalized.to_lyr,
        normalized.to_sec,
        normalized.to_pcs,
        normalized.netsuite_received_qty,
        normalized.unit
      ]
    );
    await upsertInventoryItemFromLine(normalized);
    await auditSyncChange({
      action: "netsuite.line",
      orderId,
      lineId: normalized.line_id,
      existing: existing.rows[0] || null,
      normalized,
      fields: [
        "line_id", "item_id", "item_name", "item_type", "item_type_text",
        "item_description", "sku", "quantity", "unit", "item_weight",
        "location_id", "location", "pallet_qty", "layer_qty", "piece_qty",
        "section_qty", "to_plt", "to_lyr", "to_sec", "to_pcs"
      ],
      detailsKey: "line"
    });
  }
}

export async function upsertOutboundTransferOrderLines(orderId, lines = []) {
  await upsertTransferOrderLines(orderId, lines, "outbound");
}

async function upsertTransferOrderLines(orderId, lines = [], stage) {
  for (const line of lines || []) {
    const normalized = await hydrateLineFromInventory(normalizeLine(line));
    let existing = await query(
      `SELECT *
         FROM transfer_order_lines
        WHERE transfer_order_id = $1
          AND line_stage = $2
          AND line_id = $3`,
      [orderId, stage, normalized.line_id]
    );
    if (!existing.rows[0]) {
      const rekeyed = await rekeyLineIfSingleCandidate({
        table: "transfer_order_lines",
        orderColumn: "transfer_order_id",
        orderId,
        normalized,
        stage
      });
      if (rekeyed) existing = { rows: [rekeyed] };
    }
    const existingId = existing.rows[0]?.id || null;
    await query(
      `INSERT INTO transfer_order_lines (
         line_stage, id, transfer_order_id, line_id, item_id, item_name,
         sku, item_description, quantity, unit, item_weight, location_id,
         location, pallet_qty, layer_qty, piece_qty, section_qty, to_plt,
         to_lyr, to_sec, to_pcs, loaded_qty, loaded_uom, netsuite_active,
         sync_exception, sync_exception_at, raw, synced_at, item_type,
         item_type_text, netsuite_received_qty
       ) VALUES (
         $1, COALESCE($2::bigint, nextval('canonical_order_line_id_seq')),
         $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18,
         $19, $20, $21, COALESCE($22::numeric, 0), $23, true,
         null, null, $24::jsonb, now(), $25, $26, COALESCE($27::numeric, 0)
       )
       ON CONFLICT (line_stage, id) DO UPDATE SET
         transfer_order_id = EXCLUDED.transfer_order_id,
         line_id = EXCLUDED.line_id,
         item_id = EXCLUDED.item_id,
         item_name = EXCLUDED.item_name,
         sku = EXCLUDED.sku,
         item_description = EXCLUDED.item_description,
         quantity = EXCLUDED.quantity,
         unit = EXCLUDED.unit,
         item_weight = EXCLUDED.item_weight,
         location_id = EXCLUDED.location_id,
         location = EXCLUDED.location,
         pallet_qty = EXCLUDED.pallet_qty,
         layer_qty = EXCLUDED.layer_qty,
         piece_qty = EXCLUDED.piece_qty,
         section_qty = EXCLUDED.section_qty,
         to_plt = EXCLUDED.to_plt,
         to_lyr = EXCLUDED.to_lyr,
         to_sec = EXCLUDED.to_sec,
         to_pcs = EXCLUDED.to_pcs,
         loaded_qty = CASE
           WHEN EXCLUDED.line_stage = 'outbound'
           THEN GREATEST(COALESCE(transfer_order_lines.loaded_qty, 0), COALESCE(EXCLUDED.loaded_qty, 0))
           ELSE transfer_order_lines.loaded_qty
         END,
         loaded_uom = CASE
           WHEN GREATEST(COALESCE(transfer_order_lines.loaded_qty, 0), COALESCE(EXCLUDED.loaded_qty, 0)) > 0
           THEN COALESCE(NULLIF(transfer_order_lines.loaded_uom, ''), EXCLUDED.unit)
           ELSE transfer_order_lines.loaded_uom
         END,
         netsuite_active = true,
         sync_exception = CASE
           WHEN transfer_order_lines.line_stage = 'outbound' AND (
             COALESCE(transfer_order_lines.packed_pallet_qty, 0) > COALESCE(EXCLUDED.pallet_qty, 0)
             OR COALESCE(transfer_order_lines.packed_layer_qty, 0) > COALESCE(EXCLUDED.layer_qty, 0)
             OR COALESCE(transfer_order_lines.packed_piece_qty, 0) > COALESCE(EXCLUDED.piece_qty, EXCLUDED.quantity, 0)
             OR COALESCE(transfer_order_lines.packed_section_qty, 0) > COALESCE(EXCLUDED.section_qty, 0)
           ) THEN 'qty_reduced'
           ELSE null
         END,
         sync_exception_at = CASE
           WHEN transfer_order_lines.line_stage = 'outbound' AND (
             COALESCE(transfer_order_lines.packed_pallet_qty, 0) > COALESCE(EXCLUDED.pallet_qty, 0)
             OR COALESCE(transfer_order_lines.packed_layer_qty, 0) > COALESCE(EXCLUDED.layer_qty, 0)
             OR COALESCE(transfer_order_lines.packed_piece_qty, 0) > COALESCE(EXCLUDED.piece_qty, EXCLUDED.quantity, 0)
             OR COALESCE(transfer_order_lines.packed_section_qty, 0) > COALESCE(EXCLUDED.section_qty, 0)
           ) THEN now()
           ELSE null
         END,
         raw = EXCLUDED.raw,
         synced_at = now(),
         item_type = EXCLUDED.item_type,
         item_type_text = EXCLUDED.item_type_text,
         netsuite_received_qty = CASE WHEN EXCLUDED.line_stage = 'receiving' THEN EXCLUDED.netsuite_received_qty ELSE transfer_order_lines.netsuite_received_qty END`,
      [
        stage,
        existingId,
        orderId,
        normalized.line_id,
        normalized.item_id,
        normalized.item_name,
        normalized.sku,
        normalized.item_description,
        normalized.quantity,
        normalized.unit,
        normalized.item_weight,
        normalized.location_id,
        normalized.location,
        normalized.pallet_qty,
        normalized.layer_qty,
        normalized.piece_qty,
        normalized.section_qty,
        normalized.to_plt,
        normalized.to_lyr,
        normalized.to_sec,
        normalized.to_pcs,
        stage === "outbound" ? normalized.netsuite_received_qty : 0,
        normalized.unit,
        JSON.stringify(normalized.raw || {}),
        normalized.item_type,
        normalized.item_type_text,
        normalized.netsuite_received_qty
      ]
    );
    await upsertInventoryItemFromLine(normalized);
    await auditSyncChange({
      action: stage === "receiving" ? "netsuite.receiving_line" : "netsuite.line",
      orderId,
      lineId: normalized.line_id,
      existing: existing.rows[0] || null,
      normalized,
      fields: [
        "line_id", "item_id", "item_name", "item_type", "item_type_text",
        "item_description", "sku", "quantity", "netsuite_received_qty", "unit",
        "item_weight", "location_id", "location", "pallet_qty", "layer_qty",
        "piece_qty", "section_qty", "to_plt", "to_lyr", "to_sec", "to_pcs"
      ],
      detailsKey: "line"
    });
  }
}

export async function listExistingOutboundOrderIds({ locationId = null, orderFamily = "sales_order" } = {}) {
  const isTransfer = orderFamily === "transfer_order";
  const params = [];
  const clauses = [];
  if (locationId) {
    params.push(locationId);
    clauses.push(`${isTransfer ? "from_location_id" : "outbound_location_id"} = $${params.length}`);
  }
  const result = await query(
    `SELECT netsuite_id
       FROM ${isTransfer ? "transfer_orders" : "sales_orders"}
      WHERE netsuite_id > 0
      ${clauses.length ? `AND ${clauses.join(" AND ")}` : ""}
      ORDER BY synced_at ASC, netsuite_id`,
    params
  );
  return result.rows.map((row) => row.netsuite_id);
}

export async function markOutboundOrderMissing(orderId, { orderFamily = "sales_order" } = {}) {
  if (orderFamily === "transfer_order") {
    await query(
      `UPDATE transfer_order_lines
          SET netsuite_active = false,
              sync_exception = CASE WHEN (
                COALESCE(packed_pallet_qty, 0)
                + COALESCE(packed_layer_qty, 0)
                + COALESCE(packed_section_qty, 0)
                + COALESCE(packed_piece_qty, 0)
              ) > 0 THEN 'line_deleted' ELSE sync_exception END,
              sync_exception_at = CASE WHEN (
                COALESCE(packed_pallet_qty, 0)
                + COALESCE(packed_layer_qty, 0)
                + COALESCE(packed_section_qty, 0)
                + COALESCE(packed_piece_qty, 0)
              ) > 0 THEN now() ELSE sync_exception_at END,
              synced_at = now()
        WHERE transfer_order_id = $1
          AND line_stage = 'outbound'
          AND netsuite_active = true`,
      [orderId]
    );
    await query(
      `UPDATE transfer_orders
          SET netsuite_active = false,
              netsuite_missing_at = now(),
              synced_at = now()
        WHERE netsuite_id = $1
          AND NOT EXISTS (
            SELECT 1
              FROM transfer_order_lines l
             WHERE l.transfer_order_id = transfer_orders.netsuite_id
               AND l.netsuite_active = true
          )`,
      [orderId]
    );
    return;
  }
  await query(
    `UPDATE sales_orders
        SET netsuite_active = false,
            netsuite_missing_at = now(),
            synced_at = now()
      WHERE netsuite_id = $1`,
    [orderId]
  );
}

export async function markMissingOutboundOrderLines(orderId, activeLineIds = []) {
  const ids = activeLineIds.map((id) => Number(id)).filter((id) => Number.isInteger(id));
  const order = await query(
    `SELECT 'sales_order' AS order_type FROM sales_orders WHERE netsuite_id = $1
     UNION ALL
     SELECT 'transfer_order' AS order_type FROM transfer_orders WHERE netsuite_id = $1 AND outbound_operator_status IS NOT NULL
     LIMIT 1`,
    [orderId]
  );
  const orderType = order.rows[0]?.order_type;
  if (!orderType) return;
  const table = orderType === "transfer_order" ? "transfer_order_lines" : "sales_order_lines";
  const orderColumn = orderType === "transfer_order" ? "transfer_order_id" : "sales_order_id";
  const stageClause = orderType === "transfer_order" ? "AND line_stage = 'outbound'" : "";
  const result = await query(
    `UPDATE ${table}
        SET netsuite_active = false,
            sync_exception = CASE WHEN (
              COALESCE(packed_pallet_qty, 0)
              + COALESCE(packed_layer_qty, 0)
              + COALESCE(packed_section_qty, 0)
              + COALESCE(packed_piece_qty, 0)
            ) > 0 THEN 'line_deleted' ELSE sync_exception END,
            sync_exception_at = CASE WHEN (
              COALESCE(packed_pallet_qty, 0)
              + COALESCE(packed_layer_qty, 0)
              + COALESCE(packed_section_qty, 0)
              + COALESCE(packed_piece_qty, 0)
            ) > 0 THEN now() ELSE sync_exception_at END,
            synced_at = now()
      WHERE ${orderColumn} = $1
        ${stageClause}
        AND NOT (line_id = ANY($2::bigint[]))
        AND netsuite_active = true
      RETURNING line_id, item_name, sync_exception`,
    [orderId, ids]
  );
  for (const row of result.rows) {
    await writeAudit({
      actorType: "system",
      source: "netsuite",
      action: "netsuite.line.missing",
      orderId,
      lineId: row.line_id,
      details: row
    });
  }
}

export async function updateSalesOrderNetSuiteStatus(orderId, patch = {}) {
  const expectedDeliveryDate = normalizeNetSuiteDate(patch.expectedDeliveryDate || patch.expected_delivery_date);
  const result = await query(
    `UPDATE sales_orders
        SET status = COALESCE($2, status),
            status_text = COALESCE($3, status_text),
            expected_delivery_date = COALESCE($4::date, expected_delivery_date),
            status_updated_at = CASE
              WHEN status IS DISTINCT FROM COALESCE($2, status)
                OR status_text IS DISTINCT FROM COALESCE($3, status_text)
              THEN now()
              ELSE status_updated_at
            END,
            synced_at = now()
      WHERE netsuite_id = $1
      RETURNING netsuite_id, tranid, status, status_text, expected_delivery_date`,
    [orderId, patch.status || null, patch.statusText || patch.status_text || null, expectedDeliveryDate]
  );
  return result.rows[0] || null;
}

export async function updatePurchaseOrderNetSuiteStatus(orderId, patch = {}) {
  const result = await query(
    `UPDATE purchase_orders
        SET status = COALESCE($2, status),
            status_text = COALESCE($3, status_text),
            status_updated_at = CASE
              WHEN status IS DISTINCT FROM COALESCE($2, status)
                OR status_text IS DISTINCT FROM COALESCE($3, status_text)
              THEN now()
              ELSE status_updated_at
            END,
            synced_at = now()
      WHERE netsuite_id = $1
      RETURNING netsuite_id, tranid, status, status_text`,
    [orderId, patch.status || null, patch.statusText || patch.status_text || null]
  );
  return result.rows[0] || null;
}

export async function upsertPurchaseOrders(orders = []) {
  for (const order of orders || []) {
    const dispatch = await enrichPurchaseOrderDispatch(order);
    const normalized = normalizeOrderDates({ ...normalizeReceivingOrder(order, "purchase_order"), ...dispatch });
    const existing = await query(
      `SELECT tranid, trandate, vendor_id, vendor, status, status_text,
              foreign_total, source_location_id, source_location, destination_location_id,
              destination_location, memo, vendor_address, dispatch_address, dispatch_window_start,
              dispatch_window_end, dispatch_instructions, dispatch_vendor_yard,
              dispatch_parse_source, dispatch_note_hash
         FROM purchase_orders
        WHERE netsuite_id = $1`,
      [normalized.netsuite_id]
    );
    await query(
      `INSERT INTO purchase_orders (
         netsuite_id, tranid, trandate, vendor_id, vendor, status, status_text,
         foreign_total, destination_location_id, destination_location, memo, vendor_address,
         dispatch_vendor_yard, dispatch_address, dispatch_window_start,
         dispatch_window_end, dispatch_instructions, receipt_status,
         netsuite_active, netsuite_missing_at, synced_at, source_location_id,
         source_location, expected_delivery_date, dispatch_parse_source,
         dispatch_note_hash, dispatch_parsed_at, status_updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14, $15, $16,
         $17, 'not_received', true, null, now(), $18, $19, $20,
         $21, $22, now(), now()
       )
       ON CONFLICT (netsuite_id) DO UPDATE SET
         tranid = EXCLUDED.tranid,
         trandate = EXCLUDED.trandate,
         vendor_id = EXCLUDED.vendor_id,
         vendor = EXCLUDED.vendor,
         status_updated_at = CASE
           WHEN purchase_orders.status IS DISTINCT FROM EXCLUDED.status
             OR purchase_orders.status_text IS DISTINCT FROM EXCLUDED.status_text
           THEN now()
           ELSE purchase_orders.status_updated_at
         END,
         status = EXCLUDED.status,
         status_text = EXCLUDED.status_text,
         foreign_total = EXCLUDED.foreign_total,
         destination_location_id = EXCLUDED.destination_location_id,
         destination_location = EXCLUDED.destination_location,
         memo = EXCLUDED.memo,
         vendor_address = EXCLUDED.vendor_address,
         dispatch_vendor_yard = EXCLUDED.dispatch_vendor_yard,
         dispatch_address = EXCLUDED.dispatch_address,
         dispatch_window_start = EXCLUDED.dispatch_window_start,
         dispatch_window_end = EXCLUDED.dispatch_window_end,
         dispatch_instructions = EXCLUDED.dispatch_instructions,
         source_location_id = EXCLUDED.source_location_id,
         source_location = EXCLUDED.source_location,
         expected_delivery_date = EXCLUDED.expected_delivery_date,
         dispatch_parse_source = EXCLUDED.dispatch_parse_source,
         dispatch_note_hash = EXCLUDED.dispatch_note_hash,
         dispatch_parsed_at = CASE
           WHEN purchase_orders.dispatch_note_hash IS DISTINCT FROM EXCLUDED.dispatch_note_hash THEN now()
           ELSE purchase_orders.dispatch_parsed_at
         END,
         netsuite_active = true,
         netsuite_missing_at = null,
         synced_at = now()`,
      [
        normalized.netsuite_id,
        normalized.tranid,
        normalized.trandate,
        normalized.vendor_id,
        normalized.vendor,
        normalized.status,
        normalized.status_text,
        normalized.foreign_total,
        normalized.destination_location_id,
        normalized.destination_location,
        normalized.memo,
        normalized.vendor_address,
        normalized.dispatch_vendor_yard,
        normalized.dispatch_address,
        normalized.dispatch_window_start,
        normalized.dispatch_window_end,
        normalized.dispatch_instructions,
        normalized.source_location_id,
        normalized.source_location,
        normalized.expected_delivery_date,
        normalized.dispatch_parse_source,
        normalized.dispatch_note_hash
      ]
    );
    await auditSyncChange({
      action: "netsuite.receiving_order",
      existing: existing.rows[0] || null,
      normalized,
      fields: [
        "tranid", "trandate", "vendor_id", "vendor", "status",
        "status_text", "foreign_total", "source_location_id", "source_location",
        "destination_location_id", "destination_location", "memo",
        "vendor_address", "dispatch_address", "dispatch_window_start", "dispatch_window_end",
        "dispatch_instructions", "dispatch_vendor_yard", "dispatch_parse_source",
        "dispatch_note_hash"
      ],
      detailsKey: "order"
    });
  }
}

export async function upsertPurchaseOrderLines(orderId, lines = []) {
  for (const line of lines || []) {
    const normalized = await hydrateLineFromInventory(normalizeLine(line));
    let existing = await query(
      `SELECT *
         FROM purchase_order_lines
        WHERE purchase_order_id = $1
          AND line_id = $2`,
      [orderId, normalized.line_id]
    );
    if (!existing.rows[0]) {
      const rekeyed = await rekeyLineIfSingleCandidate({
        table: "purchase_order_lines",
        orderColumn: "purchase_order_id",
        orderId,
        normalized
      });
      if (rekeyed) existing = { rows: [rekeyed] };
    }
    await query(
      `INSERT INTO purchase_order_lines (
         purchase_order_id, line_id, item_id, item_name, item_type,
         item_type_text, item_description, sku, quantity,
         netsuite_received_qty, unit, item_weight, location_id, location,
         pallet_qty, layer_qty, piece_qty, section_qty, to_plt, to_lyr,
         to_sec, to_pcs, netsuite_active, sync_exception,
         sync_exception_at, raw, synced_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, COALESCE($10::numeric, 0), $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20, $21, $22, true, null,
         null, $23::jsonb, now()
       )
       ON CONFLICT (purchase_order_id, line_id) WHERE line_id IS NOT NULL DO UPDATE SET
         item_id = EXCLUDED.item_id,
         item_name = EXCLUDED.item_name,
         item_type = EXCLUDED.item_type,
         item_type_text = EXCLUDED.item_type_text,
         item_description = EXCLUDED.item_description,
         sku = EXCLUDED.sku,
         quantity = EXCLUDED.quantity,
         netsuite_received_qty = EXCLUDED.netsuite_received_qty,
         unit = EXCLUDED.unit,
         item_weight = EXCLUDED.item_weight,
         location_id = EXCLUDED.location_id,
         location = EXCLUDED.location,
         pallet_qty = EXCLUDED.pallet_qty,
         layer_qty = EXCLUDED.layer_qty,
         piece_qty = EXCLUDED.piece_qty,
         section_qty = EXCLUDED.section_qty,
         to_plt = EXCLUDED.to_plt,
         to_lyr = EXCLUDED.to_lyr,
         to_sec = EXCLUDED.to_sec,
         to_pcs = EXCLUDED.to_pcs,
         netsuite_active = true,
         sync_exception = null,
         sync_exception_at = null,
         raw = EXCLUDED.raw,
         synced_at = now()`,
      [
        orderId,
        normalized.line_id,
        normalized.item_id,
        normalized.item_name,
        normalized.item_type,
        normalized.item_type_text,
        normalized.item_description,
        normalized.sku,
        normalized.quantity,
        normalized.netsuite_received_qty,
        normalized.unit,
        normalized.item_weight,
        normalized.location_id,
        normalized.location,
        normalized.pallet_qty,
        normalized.layer_qty,
        normalized.piece_qty,
        normalized.section_qty,
        normalized.to_plt,
        normalized.to_lyr,
        normalized.to_sec,
        normalized.to_pcs,
        JSON.stringify(normalized.raw || {})
      ]
    );
    await upsertInventoryItemFromLine(normalized);
    await auditSyncChange({
      action: "netsuite.receiving_line",
      existing: existing.rows[0] || null,
      normalized,
      fields: [
        "line_id", "item_id", "item_name", "item_type", "item_type_text",
        "item_description", "sku", "quantity", "netsuite_received_qty", "unit",
        "item_weight", "location_id", "location", "pallet_qty", "layer_qty",
        "piece_qty", "section_qty", "to_plt", "to_lyr", "to_sec", "to_pcs"
      ],
      detailsKey: "line"
    });
  }
}

export async function upsertInboundTransferOrders(orders = []) {
  for (const order of orders || []) {
    const dispatch = enrichTransferDispatch(order);
    const normalized = normalizeOrderDates({ ...normalizeReceivingOrder(order, "transfer_order"), ...dispatch });
    const existing = await query(
      `SELECT tranid, trandate, status, status_text, from_location_id AS source_location_id,
              from_location AS source_location, to_location_id AS destination_location_id,
              to_location AS destination_location, memo, dispatch_address,
              dispatch_window_start, dispatch_window_end, dispatch_instructions,
              dispatch_parse_source, dispatch_note_hash
         FROM transfer_orders
        WHERE netsuite_id = $1`,
      [normalized.netsuite_id]
    );
    await query(
      `INSERT INTO transfer_orders (
         netsuite_id, tranid, trandate, status, status_text,
         from_location_id, from_location, to_location_id, to_location,
         receiving_status, netsuite_active, netsuite_missing_at, synced_at,
         memo, expected_delivery_date, dispatch_address, dispatch_window_start,
         dispatch_window_end, dispatch_instructions, dispatch_parse_source,
         dispatch_note_hash, dispatch_parsed_at, status_updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         'not_received', true, null, now(), $10, $11, $12,
         $13, $14, $15, $16, $17, now(), now()
       )
       ON CONFLICT (netsuite_id) DO UPDATE SET
         tranid = EXCLUDED.tranid,
         trandate = EXCLUDED.trandate,
         status_updated_at = CASE
           WHEN transfer_orders.status IS DISTINCT FROM EXCLUDED.status
             OR transfer_orders.status_text IS DISTINCT FROM EXCLUDED.status_text
           THEN now()
           ELSE transfer_orders.status_updated_at
         END,
         status = EXCLUDED.status,
         status_text = EXCLUDED.status_text,
         from_location_id = EXCLUDED.from_location_id,
         from_location = EXCLUDED.from_location,
         to_location_id = EXCLUDED.to_location_id,
         to_location = EXCLUDED.to_location,
         memo = EXCLUDED.memo,
         expected_delivery_date = EXCLUDED.expected_delivery_date,
         dispatch_address = EXCLUDED.dispatch_address,
         dispatch_window_start = EXCLUDED.dispatch_window_start,
         dispatch_window_end = EXCLUDED.dispatch_window_end,
         dispatch_instructions = EXCLUDED.dispatch_instructions,
         dispatch_parse_source = EXCLUDED.dispatch_parse_source,
         dispatch_note_hash = EXCLUDED.dispatch_note_hash,
         dispatch_parsed_at = CASE
           WHEN transfer_orders.dispatch_note_hash IS DISTINCT FROM EXCLUDED.dispatch_note_hash THEN now()
           ELSE transfer_orders.dispatch_parsed_at
         END,
         receiving_status = COALESCE(transfer_orders.receiving_status, EXCLUDED.receiving_status),
         netsuite_active = true,
         netsuite_missing_at = null,
         synced_at = now()`,
      [
        normalized.netsuite_id,
        normalized.tranid,
        normalized.trandate,
        normalized.status,
        normalized.status_text,
        normalized.source_location_id,
        normalized.source_location,
        normalized.destination_location_id,
        normalized.destination_location,
        normalized.memo,
        normalized.expected_delivery_date,
        normalized.dispatch_address,
        normalized.dispatch_window_start,
        normalized.dispatch_window_end,
        normalized.dispatch_instructions,
        normalized.dispatch_parse_source,
        normalized.dispatch_note_hash
      ]
    );
    await auditSyncChange({
      action: "netsuite.receiving_order",
      existing: existing.rows[0] || null,
      normalized,
      fields: [
        "tranid", "trandate", "status", "status_text", "source_location_id",
        "source_location", "destination_location_id", "destination_location",
        "memo", "dispatch_address", "dispatch_window_start", "dispatch_window_end",
        "dispatch_instructions", "dispatch_parse_source", "dispatch_note_hash"
      ],
      detailsKey: "order"
    });
  }
}

export async function upsertInboundTransferOrderLines(orderId, lines = []) {
  return upsertTransferOrderLines(orderId, lines, "receiving");
}

export async function listExistingInboundOrderIds({ orderFamily, sourceLocationId = null, destinationLocationId = null } = {}) {
  const isTransfer = orderFamily === "transfer_order";
  const params = [];
  const clauses = [];
  if (isTransfer) {
    clauses.push("receiving_status IS NOT NULL");
    if (sourceLocationId) {
      params.push(sourceLocationId);
      clauses.push(`from_location_id = $${params.length}`);
    }
    if (destinationLocationId) {
      params.push(destinationLocationId);
      clauses.push(`to_location_id = $${params.length}`);
    }
  } else {
    if (destinationLocationId) {
      params.push(destinationLocationId);
      clauses.push(`destination_location_id = $${params.length}`);
    }
  }
  const result = await query(
    `SELECT netsuite_id
       FROM ${isTransfer ? "transfer_orders" : "purchase_orders"}
      WHERE netsuite_id > 0
      ${clauses.length ? `AND ${clauses.join(" AND ")}` : ""}
      ORDER BY synced_at ASC, netsuite_id`,
    params
  );
  return result.rows.map((row) => row.netsuite_id);
}

export async function markMissingInboundOrders({ orderFamily, activeOrderIds = [], sourceLocationId = null, destinationLocationId = null } = {}) {
  const ids = activeOrderIds.map((id) => Number(id)).filter((id) => Number.isInteger(id));
  const isTransfer = orderFamily === "transfer_order";
  const params = [ids];
  const clauses = ["netsuite_id > 0", "NOT (netsuite_id = ANY($1::bigint[]))"];
  if (isTransfer) {
    clauses.push("receiving_status IS NOT NULL");
    if (sourceLocationId) {
      params.push(sourceLocationId);
      clauses.push(`from_location_id = $${params.length}`);
    }
    if (destinationLocationId) {
      params.push(destinationLocationId);
      clauses.push(`to_location_id = $${params.length}`);
    }
  } else if (destinationLocationId) {
    params.push(destinationLocationId);
    clauses.push(`destination_location_id = $${params.length}`);
  }
  if (!isTransfer) {
    await query(
      `UPDATE purchase_orders
          SET netsuite_active = false,
              netsuite_missing_at = now(),
              synced_at = now()
        WHERE ${clauses.join(" AND ")}`,
      params
    );
    return;
  }

  await query(
    `UPDATE transfer_order_lines
        SET netsuite_active = false,
            sync_exception = CASE WHEN (
              COALESCE(received_pallet_qty, 0)
              + COALESCE(received_layer_qty, 0)
              + COALESCE(received_section_qty, 0)
              + COALESCE(received_piece_qty, 0)
            ) > 0 THEN 'line_deleted' ELSE sync_exception END,
            sync_exception_at = CASE WHEN (
              COALESCE(received_pallet_qty, 0)
              + COALESCE(received_layer_qty, 0)
              + COALESCE(received_section_qty, 0)
              + COALESCE(received_piece_qty, 0)
            ) > 0 THEN now() ELSE sync_exception_at END,
            synced_at = now()
      WHERE line_stage = 'receiving'
        AND transfer_order_id IN (
          SELECT netsuite_id
            FROM transfer_orders
           WHERE ${clauses.join(" AND ")}
        )
        AND netsuite_active = true`,
    params
  );

  await query(
    `UPDATE transfer_orders
        SET netsuite_active = false,
            netsuite_missing_at = now(),
            synced_at = now()
      WHERE ${clauses.join(" AND ")}
        AND NOT EXISTS (
          SELECT 1
            FROM transfer_order_lines l
           WHERE l.transfer_order_id = transfer_orders.netsuite_id
             AND l.netsuite_active = true
        )`,
    params
  );
}

export async function markMissingInboundOrderLines(orderId, activeLineIds = []) {
  const ids = activeLineIds.map((id) => Number(id)).filter((id) => Number.isInteger(id));
  const order = await query(
    `SELECT 'purchase_order' AS order_type FROM purchase_orders WHERE netsuite_id = $1
     UNION ALL
     SELECT 'transfer_order' AS order_type FROM transfer_orders WHERE netsuite_id = $1 AND receiving_status IS NOT NULL
     LIMIT 1`,
    [orderId]
  );
  const orderType = order.rows[0]?.order_type;
  if (!orderType) return;
  const table = orderType === "transfer_order" ? "transfer_order_lines" : "purchase_order_lines";
  const orderColumn = orderType === "transfer_order" ? "transfer_order_id" : "purchase_order_id";
  const stageClause = orderType === "transfer_order" ? "AND line_stage = 'receiving'" : "";
  const result = await query(
    `UPDATE ${table}
        SET netsuite_active = false,
            sync_exception = 'line_deleted',
            sync_exception_at = now(),
            synced_at = now()
      WHERE ${orderColumn} = $1
        ${stageClause}
        AND NOT (line_id = ANY($2::bigint[]))
        AND netsuite_active = true
      RETURNING line_id`,
    [orderId, ids]
  );
  for (const row of result.rows) {
    await writeAudit({
      actorType: "system",
      source: "netsuite",
      action: "netsuite.receiving_line.deleted",
      details: { receivingOrderId: orderId, lineId: row.line_id, reason: "missing_from_netsuite" }
    });
  }
}
