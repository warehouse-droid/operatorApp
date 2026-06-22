import { query } from "./db.js";
import { writeAudit } from "./auth-repository.js";

function normalizeNetSuiteDate(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return value;
  const [, month, day, year] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number(String(value).replaceAll(",", ""));
}

function normalizeQuantity(value) {
  const number = normalizeNumber(value);
  return number === null ? null : Math.abs(number);
}

function positiveQuantity(value) {
  const number = normalizeNumber(value);
  return number === null ? 0 : Math.max(number, 0);
}

function roundQuantity(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function hasConversion(line) {
  return positiveQuantity(line.to_plt) > 0
    || positiveQuantity(line.to_lyr) > 0
    || positiveQuantity(line.to_sec) > 0
    || positiveQuantity(line.to_pcs) > 0;
}

function hasRequiredCustomQuantity(line) {
  return positiveQuantity(line.pallet_qty) > 0
    || positiveQuantity(line.layer_qty) > 0
    || positiveQuantity(line.section_qty) > 0
    || positiveQuantity(line.piece_qty) > 0;
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

export async function upsertReceivingOrders(orders) {
  for (const order of orders) {
    const normalized = {
      netsuite_id: order.id,
      order_type: order.order_type,
      tranid: order.tranid,
      trandate: normalizeNetSuiteDate(order.trandate),
      vendor_id: order.vendor_id,
      vendor: order.vendor,
      status: order.status,
      status_text: order.status_text,
      foreign_total: normalizeNumber(order.foreigntotal),
      source_location_id: order.source_location_id,
      source_location: order.source_location,
      destination_location_id: order.destination_location_id,
      destination_location: order.destination_location
    };
    const existing = await query(
      `SELECT order_type, tranid, trandate, vendor_id, vendor, status, status_text,
              foreign_total, source_location_id, source_location, destination_location_id, destination_location
       FROM receiving_orders
       WHERE netsuite_id = $1`,
      [normalized.netsuite_id]
    );

    await query(
      `INSERT INTO receiving_orders (
         netsuite_id, order_type, tranid, trandate, vendor_id, vendor, status, status_text,
         foreign_total, source_location_id, source_location, destination_location_id, destination_location,
         netsuite_active, netsuite_missing_at, synced_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, true, null, now()
       )
       ON CONFLICT (netsuite_id) DO UPDATE SET
         order_type = EXCLUDED.order_type,
         tranid = EXCLUDED.tranid,
         trandate = EXCLUDED.trandate,
         vendor_id = EXCLUDED.vendor_id,
         vendor = EXCLUDED.vendor,
         status = EXCLUDED.status,
         status_text = EXCLUDED.status_text,
         foreign_total = EXCLUDED.foreign_total,
         source_location_id = EXCLUDED.source_location_id,
         source_location = EXCLUDED.source_location,
         destination_location_id = EXCLUDED.destination_location_id,
         destination_location = EXCLUDED.destination_location,
         netsuite_active = true,
         netsuite_missing_at = null,
         synced_at = now()`,
      [
        normalized.netsuite_id,
        normalized.order_type,
        normalized.tranid,
        normalized.trandate,
        normalized.vendor_id,
        normalized.vendor,
        normalized.status,
        normalized.status_text,
        normalized.foreign_total,
        normalized.source_location_id,
        normalized.source_location,
        normalized.destination_location_id,
        normalized.destination_location
      ]
    );

    const fields = [
      "order_type", "tranid", "trandate", "vendor_id", "vendor", "status", "status_text",
      "foreign_total", "source_location_id", "source_location", "destination_location_id", "destination_location"
    ];
    const changes = existing.rowCount ? changedFields(existing.rows[0], normalized, fields) : {};
    if (!existing.rowCount || Object.keys(changes).length) {
      await writeAudit({
        actorType: "system",
        source: "netsuite",
        action: existing.rowCount ? "netsuite.receiving_order.update" : "netsuite.receiving_order.discover",
        details: existing.rowCount
          ? { receivingOrderId: normalized.netsuite_id, changes }
          : { receivingOrderId: normalized.netsuite_id, order: normalized }
      });
    }
  }
}

export async function upsertReceivingOrderLines(orderId, lines) {
  for (const line of lines) {
    const normalized = {
      line_id: line.line_id,
      item_id: line.item_id,
      item_name: line.item_name,
      item_type: line.item_type,
      item_type_text: line.item_type_text,
      item_description: line.item_description,
      sku: line.item_name,
      quantity: normalizeQuantity(line.quantity),
      netsuite_received_qty: normalizeQuantity(line.netsuite_received_qty),
      unit: line.unit,
      location_id: line.location_id,
      location: line.location,
      pallet_qty: normalizeQuantity(line.pallet_qty),
      layer_qty: normalizeQuantity(line.layer_qty),
      piece_qty: normalizeQuantity(line.piece_qty),
      section_qty: normalizeQuantity(line.section_qty),
      to_plt: normalizeNumber(line.to_plt),
      to_lyr: normalizeNumber(line.to_lyr),
      to_sec: normalizeNumber(line.to_sec),
      to_pcs: normalizeNumber(line.to_pcs)
    };
    const existing = await query(
      `SELECT line_id, item_id, item_name, item_type, item_type_text, item_description, sku,
              quantity, netsuite_received_qty, unit, location_id, location, pallet_qty, layer_qty, piece_qty, section_qty,
              to_plt, to_lyr, to_sec, to_pcs
       FROM receiving_order_lines
       WHERE order_id = $1 AND line_id = $2`,
      [orderId, normalized.line_id]
    );

    await query(
      `INSERT INTO receiving_order_lines (
         order_id, line_id, item_id, item_name, item_type, item_type_text, item_description, sku,
         quantity, netsuite_received_qty, unit, location_id, location, pallet_qty, layer_qty, piece_qty, section_qty,
         to_plt, to_lyr, to_sec, to_pcs, netsuite_active, sync_exception, sync_exception_at, raw, synced_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14, $15, $16, $17,
         $18, $19, $20, $21, true, null, null, $22, now()
       )
       ON CONFLICT (order_id, line_id) DO UPDATE SET
         item_id = EXCLUDED.item_id,
         item_name = EXCLUDED.item_name,
         item_type = EXCLUDED.item_type,
         item_type_text = EXCLUDED.item_type_text,
         item_description = EXCLUDED.item_description,
         sku = EXCLUDED.sku,
         quantity = EXCLUDED.quantity,
         netsuite_received_qty = EXCLUDED.netsuite_received_qty,
         unit = EXCLUDED.unit,
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
        JSON.stringify(line)
      ]
    );

    const fields = [
      "line_id", "item_id", "item_name", "item_type", "item_type_text", "item_description", "sku",
      "quantity", "netsuite_received_qty", "unit", "location_id", "location", "pallet_qty", "layer_qty", "piece_qty", "section_qty",
      "to_plt", "to_lyr", "to_sec", "to_pcs"
    ];
    const changes = existing.rowCount ? changedFields(existing.rows[0], normalized, fields) : {};
    if (!existing.rowCount || Object.keys(changes).length) {
      await writeAudit({
        actorType: "system",
        source: "netsuite",
        action: existing.rowCount ? "netsuite.receiving_line.update" : "netsuite.receiving_line.discover",
        details: existing.rowCount
          ? { receivingOrderId: orderId, lineId: normalized.line_id, changes }
          : { receivingOrderId: orderId, lineId: normalized.line_id, line: normalized }
      });
    }
  }
}

export async function markMissingReceivingOrders({ orderType, activeOrderIds, sourceLocationId = null, destinationLocationId = null }) {
  const params = [orderType, activeOrderIds.map((id) => Number(id)).filter((id) => Number.isInteger(id))];
  const clauses = ["order_type = $1", "NOT (netsuite_id = ANY($2::bigint[]))"];
  if (sourceLocationId) {
    params.push(sourceLocationId);
    clauses.push(`source_location_id = $${params.length}`);
  }
  if (destinationLocationId) {
    params.push(destinationLocationId);
    clauses.push(`destination_location_id = $${params.length}`);
  }
  await query(
    `UPDATE receiving_orders
     SET netsuite_active = false,
         netsuite_missing_at = now(),
         synced_at = now()
     WHERE ${clauses.join(" AND ")}`,
    params
  );
}

export async function markMissingReceivingOrderLines(orderId, activeLineIds) {
  const ids = activeLineIds.map((id) => Number(id)).filter((id) => Number.isInteger(id));
  const result = await query(
    `UPDATE receiving_order_lines
     SET netsuite_active = false,
         sync_exception = 'line_deleted',
         sync_exception_at = now(),
         synced_at = now()
     WHERE order_id = $1
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

export async function listExistingReceivingOrderIds({ orderType, sourceLocationId = null, destinationLocationId = null } = {}) {
  const params = [orderType];
  const clauses = ["order_type = $1"];
  if (sourceLocationId) {
    params.push(sourceLocationId);
    clauses.push(`source_location_id = $${params.length}`);
  }
  if (destinationLocationId) {
    params.push(destinationLocationId);
    clauses.push(`destination_location_id = $${params.length}`);
  }
  const result = await query(
    `SELECT netsuite_id
     FROM receiving_orders
     WHERE ${clauses.join(" AND ")}
     ORDER BY synced_at ASC, netsuite_id`,
    params
  );
  return result.rows.map((row) => row.netsuite_id);
}

export async function listReceivingVendors({ destinationLocationId = null } = {}) {
  const params = [];
  let destinationClause = "";
  if (destinationLocationId) {
    params.push(destinationLocationId);
    destinationClause = `AND destination_location_id = $${params.length}`;
  }
  const result = await query(
    `SELECT vendor_id, vendor, COUNT(*)::int AS order_count
     FROM receiving_orders
     WHERE order_type = 'purchase_order'
       AND netsuite_active = true
       AND status_text ILIKE '%Pending Receipt%'
       ${destinationClause}
     GROUP BY vendor_id, vendor
     ORDER BY vendor`,
    params
  );
  return result.rows;
}

export async function listReceivingSources({ destinationLocationId = null } = {}) {
  const params = [];
  let destinationClause = "";
  if (destinationLocationId) {
    params.push(destinationLocationId);
    destinationClause = `AND destination_location_id = $${params.length}
       AND source_location_id <> $${params.length}`;
  }
  const result = await query(
    `SELECT source_location_id, source_location, COUNT(*)::int AS order_count
     FROM receiving_orders
     WHERE order_type = 'transfer_order'
       AND netsuite_active = true
       AND status_text ILIKE '%Pending Receipt%'
       ${destinationClause}
     GROUP BY source_location_id, source_location
     ORDER BY source_location`,
    params
  );
  return result.rows;
}

export async function listReceivingOrders({ orderType, vendor = null, sourceLocationId = null, destinationLocationId = null, search = null, itemSearch = null } = {}) {
  const params = [orderType];
  const clauses = ["ro.order_type = $1", "ro.netsuite_active = true", "ro.status_text ILIKE '%Pending Receipt%'"];
  if (vendor) {
    params.push(vendor);
    clauses.push(`ro.vendor = $${params.length}`);
  }
  if (sourceLocationId) {
    params.push(sourceLocationId);
    clauses.push(`ro.source_location_id = $${params.length}`);
  }
  if (destinationLocationId) {
    params.push(destinationLocationId);
    clauses.push(`ro.destination_location_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${String(search).trim()}%`);
    clauses.push(`ro.tranid ILIKE $${params.length}`);
  }
  if (itemSearch) {
    params.push(`%${String(itemSearch).trim()}%`);
    clauses.push(`EXISTS (
      SELECT 1 FROM receiving_order_lines rol
      WHERE rol.order_id = ro.netsuite_id
        AND rol.netsuite_active = true
        AND (rol.item_name ILIKE $${params.length} OR rol.item_description ILIKE $${params.length})
    )`);
  }
  const result = await query(
    `SELECT ro.*,
            (SELECT COUNT(*)::int FROM receiving_order_lines rol WHERE rol.order_id = ro.netsuite_id AND rol.netsuite_active = true) AS line_count
     FROM receiving_orders ro
     WHERE ${clauses.join(" AND ")}
     ORDER BY ro.trandate DESC, ro.tranid DESC
     LIMIT 200`,
    params
  );
  return result.rows;
}

export async function getReceivingOrder(orderId) {
  const order = await query("SELECT * FROM receiving_orders WHERE netsuite_id = $1", [orderId]);
  if (!order.rowCount) return null;
  const lines = await query(
    `SELECT *
     FROM receiving_order_lines
     WHERE order_id = $1
       AND (netsuite_active = true OR sync_exception IS NOT NULL)
     ORDER BY line_id NULLS LAST, id`,
    [orderId]
  );
  return { ...order.rows[0], lines: lines.rows };
}

export async function confirmReceivingLine(orderId, lineRowId, values, operatorId) {
  const line = await query(
    `SELECT *
     FROM receiving_order_lines
     WHERE id = $1
       AND order_id = $2
       AND netsuite_active = true`,
    [lineRowId, orderId]
  );
  if (!line.rowCount) throw new Error("Receiving line not found.");
  const current = line.rows[0];
  const pallets = Math.min(positiveQuantity(values.pallets), positiveQuantity(current.pallet_qty));
  const layers = Math.min(positiveQuantity(values.layers), positiveQuantity(current.layer_qty));
  const sections = Math.min(positiveQuantity(values.sections), positiveQuantity(current.section_qty));
  const pieces = Math.min(
    positiveQuantity(values.pieces),
    positiveQuantity(current.piece_qty) || (!hasRequiredCustomQuantity(current) ? positiveQuantity(current.quantity) : 0)
  );
  await query(
    `UPDATE receiving_order_lines
     SET received_pallet_qty = $3,
         received_layer_qty = $4,
         received_section_qty = $5,
         received_piece_qty = $6,
         confirmed_at = now(),
         confirmed_by = $7
     WHERE id = $1
       AND order_id = $2`,
    [lineRowId, orderId, pallets, layers, sections, pieces, operatorId || null]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    source: "receiving",
    action: "receiving.line.confirm",
    lineId: current.line_id,
    details: { receivingOrderId: orderId, pallets, layers, sections, pieces }
  });
  return getReceivingOrder(orderId);
}

export async function getReceivableReceivingOrder(orderId) {
  const order = await getReceivingOrder(orderId);
  if (!order) throw new Error("Receiving order not found.");
  const receivableLines = (order.lines || []).filter((line) => {
    if (remainingSalesQuantity(line) <= 0) return false;
    const total = positiveQuantity(line.received_pallet_qty)
      + positiveQuantity(line.received_layer_qty)
      + positiveQuantity(line.received_section_qty)
      + positiveQuantity(line.received_piece_qty);
    return line.netsuite_active && !line.sync_exception && ["InvtPart", "NonInvtPart"].includes(line.item_type || "") && total > 0;
  });
  if (!receivableLines.length) throw new Error("No confirmed lines to receive.");
  return { ...order, receivableLines };
}

export function buildItemReceiptPayload(order, lines) {
  const isTransferOrder = order.order_type === "transfer_order";
  const items = lines.map((line) => {
    const item = {
      orderLine: Number(line.line_id),
      quantity: receiptLineQuantity(line),
      itemReceive: true
    };
    if (!isTransferOrder) {
      item.location = Number(line.location_id || order.destination_location_id);
    }
    return item;
  });

  const receivedLineIds = new Set(lines.map((line) => Number(line.line_id)));
  for (const line of order.lines || []) {
    if (!line.netsuite_active || !["InvtPart", "NonInvtPart"].includes(line.item_type || "")) continue;
    if (remainingSalesQuantity(line) <= 0) continue;
    if (receivedLineIds.has(Number(line.line_id))) continue;
    const item = {
      orderLine: Number(line.line_id),
      itemReceive: false
    };
    if (!isTransferOrder) item.location = Number(line.location_id || order.destination_location_id);
    items.push(item);
  }

  return { item: { items } };
}

function receiptLineQuantity(line) {
  const baseQuantity = positiveQuantity(line.received_piece_qty)
    || positiveQuantity(line.received_section_qty)
    || positiveQuantity(line.received_layer_qty)
    || positiveQuantity(line.received_pallet_qty);
  const remaining = remainingSalesQuantity(line);
  if (!hasConversion(line)) {
    const quantity = hasRequiredCustomQuantity(line) ? (positiveQuantity(line.quantity) || baseQuantity) : baseQuantity;
    return roundQuantity(Math.min(quantity, remaining || quantity));
  }
  const convertedQuantity = (positiveQuantity(line.received_pallet_qty) * positiveQuantity(line.to_plt))
    + (positiveQuantity(line.received_layer_qty) * positiveQuantity(line.to_lyr))
    + (positiveQuantity(line.received_section_qty) * positiveQuantity(line.to_sec))
    + (positiveQuantity(line.received_piece_qty) * positiveQuantity(line.to_pcs));
  const quantity = convertedQuantity || baseQuantity;
  return roundQuantity(Math.min(quantity, remaining || quantity));
}

function remainingSalesQuantity(line) {
  return Math.max(positiveQuantity(line.quantity) - positiveQuantity(line.netsuite_received_qty), 0);
}

export async function recordReceivingReceipt(orderId, operatorId, { photoDataUrls, payload, response, itemReceiptId, itemReceiptTranid }) {
  const photos = Array.isArray(photoDataUrls) ? photoDataUrls.filter((item) => String(item || "").startsWith("data:image/")) : [];
  if (photos.length < 2) throw new Error("Two receiving photos are required.");
  const order = await getReceivingOrder(orderId);
  if (!order) throw new Error("Receiving order not found.");
  const receivedIds = (payload?.item?.items || [])
    .filter((item) => item.itemReceive !== false && positiveQuantity(item.quantity) > 0)
    .map((item) => Number(item.orderLine))
    .filter((id) => Number.isInteger(id));

  const remainingLines = (order.lines || []).filter((line) => {
    if (!line.netsuite_active || !["InvtPart", "NonInvtPart"].includes(line.item_type || "")) return false;
    if (!receivedIds.includes(Number(line.line_id))) return true;
    if (positiveQuantity(line.pallet_qty) > positiveQuantity(line.received_pallet_qty)) return true;
    if (positiveQuantity(line.layer_qty) > positiveQuantity(line.received_layer_qty)) return true;
    if (positiveQuantity(line.section_qty) > positiveQuantity(line.received_section_qty)) return true;
    if (positiveQuantity(line.piece_qty) > positiveQuantity(line.received_piece_qty)) return true;
    if (!hasRequiredCustomQuantity(line) && positiveQuantity(line.quantity) > positiveQuantity(line.received_piece_qty)) return true;
    return false;
  });
  const receiptStatus = remainingLines.length ? "partial_received" : "received";

  await query(
    `INSERT INTO receiving_receipt_records (
       order_id, operator_id, item_receipt_id, item_receipt_tranid,
       receipt_status, photo_data_urls, payload, response
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      orderId,
      operatorId || null,
      itemReceiptId || null,
      itemReceiptTranid || null,
      receiptStatus,
      JSON.stringify(photos),
      JSON.stringify(payload || {}),
      JSON.stringify(response || {})
    ]
  );

  await query(
    `UPDATE receiving_orders
     SET receipt_status = $2,
         last_item_receipt_id = $3,
         last_item_receipt_tranid = $4,
         received_at = now()
     WHERE netsuite_id = $1`,
    [orderId, receiptStatus, itemReceiptId || null, itemReceiptTranid || null]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    source: "receiving",
    action: "receiving.order.receive",
    details: { receivingOrderId: orderId, receiptStatus, itemReceiptId, itemReceiptTranid, payload, response }
  });
  return { receiptStatus, itemReceiptId, itemReceiptTranid };
}

export async function recordReceivingReceiptFailure(orderId, operatorId, { photoDataUrls, payload, error, stage }) {
  const message = error?.message || String(error || "Unknown receiving error");
  try {
    await query(
      `INSERT INTO receiving_receipt_records (
         order_id, operator_id, receipt_status, photo_data_urls, payload, response
       ) VALUES ($1, $2, 'failed', $3, $4, $5)`,
      [
        orderId,
        operatorId || null,
        JSON.stringify(Array.isArray(photoDataUrls) ? photoDataUrls : []),
        JSON.stringify(payload || {}),
        JSON.stringify({ error: message, stage: stage || null })
      ]
    );
    await writeAudit({
      actorOperatorId: operatorId,
      source: "receiving",
      action: "receiving.order.receive_failed",
      details: { receivingOrderId: orderId, error: message, stage, payload }
    });
  } catch (recordError) {
    console.error("Receiving receipt failure record failed:", recordError.message);
  }
}

export async function listReceivingReceipts({ limit = 100, operatorId = null } = {}) {
  const params = [];
  const clauses = [];
  if (operatorId) {
    params.push(operatorId);
    clauses.push(`r.operator_id = $${params.length}`);
  }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
  const result = await query(
    `SELECT r.id,
            r.order_id,
            o.tranid,
            o.order_type,
            r.item_receipt_id,
            r.item_receipt_tranid,
            r.receipt_status,
            r.created_at,
            op.display_name AS operator_name,
            r.payload,
            r.response
     FROM receiving_receipt_records r
     LEFT JOIN receiving_orders o ON o.netsuite_id = r.order_id
     LEFT JOIN operators op ON op.id = r.operator_id
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY r.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

export async function searchReceivingItems({ orderType, vendor = null, sourceLocationId = null, destinationLocationId = null, search = "" } = {}) {
  const term = String(search || "").trim();
  if (term.length < 2) return [];
  const params = [orderType, `%${term}%`];
  const clauses = [
    "ro.order_type = $1",
    "ro.netsuite_active = true",
    "ro.status_text ILIKE '%Pending Receipt%'",
    "rol.netsuite_active = true",
    "(rol.item_name ILIKE $2 OR rol.item_description ILIKE $2)"
  ];
  if (vendor) {
    params.push(vendor);
    clauses.push(`ro.vendor = $${params.length}`);
  }
  if (sourceLocationId) {
    params.push(sourceLocationId);
    clauses.push(`ro.source_location_id = $${params.length}`);
  }
  if (destinationLocationId) {
    params.push(destinationLocationId);
    clauses.push(`ro.destination_location_id = $${params.length}`);
  }
  const result = await query(
    `SELECT rol.item_id,
            rol.item_name,
            MIN(rol.item_description) AS item_description,
            COUNT(DISTINCT ro.netsuite_id)::int AS order_count
     FROM receiving_order_lines rol
     INNER JOIN receiving_orders ro ON ro.netsuite_id = rol.order_id
     WHERE ${clauses.join(" AND ")}
     GROUP BY rol.item_id, rol.item_name
     ORDER BY order_count DESC, rol.item_name
     LIMIT 12`,
    params
  );
  return result.rows;
}
