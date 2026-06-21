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
  return Math.max(0, normalizeQuantity(value) || 0);
}

function roundQuantity(value) {
  return Number(Number(value || 0).toFixed(6));
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

const packedQtySql = `
  COALESCE(packed_pallet_qty, 0)
  + COALESCE(packed_section_qty, 0)
  + COALESCE(packed_layer_qty, 0)
  + COALESCE(packed_piece_qty, 0)
`;

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

export async function upsertDeliveryOrders(orders) {
  for (const order of orders) {
    const normalized = {
      netsuite_id: order.id,
      tranid: order.tranid,
      trandate: normalizeNetSuiteDate(order.trandate),
      customer_id: order.customer_id,
      customer: order.customer,
      status: order.status,
      status_text: order.status_text,
      foreign_total: normalizeNumber(order.foreigntotal),
      order_location_id: order.order_location_id,
      order_location: order.order_location,
      outbound_location_id: order.outbound_location_id,
      outbound_location: order.outbound_location,
      delivery_method_id: order.delivery_method_id,
      delivery_method: order.delivery_method
    };
    const existing = await query(
      `SELECT tranid, trandate, customer_id, customer, status, status_text,
              foreign_total, order_location_id, order_location, outbound_location_id,
              outbound_location, delivery_method_id, delivery_method
       FROM delivery_orders
       WHERE netsuite_id = $1`,
      [normalized.netsuite_id]
    );

    await query(
      `INSERT INTO delivery_orders (
        netsuite_id, tranid, trandate, customer_id, customer, status, status_text,
        foreign_total, order_location_id, order_location, outbound_location_id,
        outbound_location, delivery_method_id, delivery_method, netsuite_active, netsuite_missing_at, synced_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14, true, null, now()
      )
      ON CONFLICT (netsuite_id) DO UPDATE SET
        tranid = EXCLUDED.tranid,
        trandate = EXCLUDED.trandate,
        customer_id = EXCLUDED.customer_id,
        customer = EXCLUDED.customer,
        status = EXCLUDED.status,
        status_text = EXCLUDED.status_text,
        foreign_total = EXCLUDED.foreign_total,
        order_location_id = EXCLUDED.order_location_id,
        order_location = EXCLUDED.order_location,
        outbound_location_id = EXCLUDED.outbound_location_id,
        outbound_location = EXCLUDED.outbound_location,
        delivery_method_id = EXCLUDED.delivery_method_id,
        delivery_method = EXCLUDED.delivery_method,
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
        normalized.delivery_method
      ]
    );

    const fields = [
      "tranid", "trandate", "customer_id", "customer", "status", "status_text",
      "foreign_total", "order_location_id", "order_location", "outbound_location_id",
      "outbound_location", "delivery_method_id", "delivery_method"
    ];
    const changes = existing.rowCount ? changedFields(existing.rows[0], normalized, fields) : {};
    if (!existing.rowCount || Object.keys(changes).length) {
      await writeAudit({
        actorType: "system",
        source: "netsuite",
        action: existing.rowCount ? "netsuite.order.update" : "netsuite.order.discover",
        orderId: normalized.netsuite_id,
        details: existing.rowCount ? { changes } : { order: normalized }
      });
    }
  }
}

export async function markMissingDeliveryOrders(locationId, activeOrderIds) {
  const ids = activeOrderIds.map((id) => Number(id)).filter((id) => Number.isInteger(id));
  await query(
    `UPDATE delivery_orders
     SET netsuite_active = false,
         netsuite_missing_at = now(),
         synced_at = now()
     WHERE outbound_location_id = $1
       AND NOT (netsuite_id = ANY($2::bigint[]))`,
    [locationId, ids]
  );
}

export async function listExistingDeliveryOrderIds({ locationId = null } = {}) {
  const params = [];
  let locationClause = "";
  if (locationId) {
    params.push(locationId);
    locationClause = `WHERE outbound_location_id = $${params.length}`;
  }

  const result = await query(
    `SELECT netsuite_id
     FROM delivery_orders
     ${locationClause}
     ORDER BY synced_at ASC, netsuite_id`,
    params
  );
  return result.rows.map((row) => row.netsuite_id);
}

export async function markDeliveryOrderMissing(orderId) {
  await query(
    `UPDATE delivery_orders
     SET netsuite_active = false,
         netsuite_missing_at = now(),
         synced_at = now()
     WHERE netsuite_id = $1`,
    [orderId]
  );
}

export async function resetDeliveryFulfillmentState(orderId, operatorId, reason = "netsuite_if_missing") {
  await query(
    `UPDATE delivery_order_lines
     SET fulfilled_pallet_qty = 0,
         fulfilled_layer_qty = 0,
         fulfilled_piece_qty = 0,
         fulfilled_section_qty = 0
     WHERE order_id = $1`,
    [orderId]
  );
  await query(
    `UPDATE delivery_orders
     SET fulfillment_status = 'not_fulfilled',
         last_item_fulfillment_id = null,
         last_item_fulfillment_tranid = null,
         fulfilled_at = null,
         operator_status = CASE WHEN operator_status = 'fulfilled' THEN 'packed' ELSE operator_status END,
         status_updated_at = now()
     WHERE netsuite_id = $1`,
    [orderId]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.fulfillment.reset",
    orderId,
    details: { reason }
  });
}

function parseStatusFilter(status) {
  if (!status || status === "active") return ["open", "preparing"];
  if (status === "packed") return ["packed"];
  return String(status).split(",").map((item) => item.trim()).filter(Boolean);
}

export async function listDeliveryOrders({ locationId = null, status = "active" } = {}) {
  const statuses = parseStatusFilter(status);
  const params = [];
  let locationClause = "";
  if (locationId) {
    params.push(locationId);
    locationClause = `AND outbound_location_id = $${params.length}`;
  }
  const pickable = "COALESCE(l.item_type, '') IN ('InvtPart', 'NonInvtPart')";
  const hasPackedQty = `
    EXISTS (
      SELECT 1 FROM delivery_order_lines l
      WHERE l.order_id = delivery_orders.netsuite_id
        AND (${pickable} OR l.sync_exception IS NOT NULL)
        AND (
          COALESCE(l.packed_pallet_qty, 0) > 0
          OR COALESCE(l.packed_section_qty, 0) > 0
          OR COALESCE(l.packed_layer_qty, 0) > 0
          OR COALESCE(l.packed_piece_qty, 0) > 0
        )
    )
  `;
  const hasRemainingQty = `
    EXISTS (
      SELECT 1 FROM delivery_order_lines l
      WHERE l.order_id = delivery_orders.netsuite_id
        AND ${pickable}
        AND l.netsuite_active = true
        AND (
          GREATEST(COALESCE(l.pallet_qty, 0) - COALESCE(l.packed_pallet_qty, 0), 0) > 0
          OR GREATEST(COALESCE(l.section_qty, 0) - COALESCE(l.packed_section_qty, 0), 0) > 0
          OR GREATEST(COALESCE(l.layer_qty, 0) - COALESCE(l.packed_layer_qty, 0), 0) > 0
          OR GREATEST(COALESCE(l.piece_qty, 0) - COALESCE(l.packed_piece_qty, 0), 0) > 0
          OR (
            COALESCE(l.pallet_qty, 0) = 0
            AND COALESCE(l.section_qty, 0) = 0
            AND COALESCE(l.layer_qty, 0) = 0
            AND COALESCE(l.piece_qty, 0) = 0
            AND GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.packed_piece_qty, 0), 0) > 0
          )
        )
    )
  `;
  const underpackCountSql = `
    SELECT COUNT(*)::int
    FROM delivery_order_lines underpack_line
    WHERE underpack_line.order_id = delivery_orders.netsuite_id
      AND COALESCE(underpack_line.item_type, '') IN ('InvtPart', 'NonInvtPart')
      AND underpack_line.netsuite_active = true
      AND (
        GREATEST(COALESCE(underpack_line.pallet_qty, 0) - COALESCE(underpack_line.packed_pallet_qty, 0), 0) > 0
        OR GREATEST(COALESCE(underpack_line.section_qty, 0) - COALESCE(underpack_line.packed_section_qty, 0), 0) > 0
        OR GREATEST(COALESCE(underpack_line.layer_qty, 0) - COALESCE(underpack_line.packed_layer_qty, 0), 0) > 0
        OR GREATEST(COALESCE(underpack_line.piece_qty, 0) - COALESCE(underpack_line.packed_piece_qty, 0), 0) > 0
        OR (
          COALESCE(underpack_line.pallet_qty, 0) = 0
          AND COALESCE(underpack_line.section_qty, 0) = 0
          AND COALESCE(underpack_line.layer_qty, 0) = 0
          AND COALESCE(underpack_line.piece_qty, 0) = 0
          AND GREATEST(COALESCE(underpack_line.quantity, 0) - COALESCE(underpack_line.packed_piece_qty, 0), 0) > 0
        )
      )
  `;
  const statusClause = status === "packed"
    ? `operator_status = 'packed'`
    : `(
        operator_status = ANY($${params.length + 1}) AND operator_status <> 'packed'
        OR (operator_status = 'packed' AND (${underpackCountSql}) > 0)
      )`;
  if (status !== "packed") params.push(statuses);

  const result = await query(
    `SELECT delivery_orders.*,
            (
              SELECT COUNT(*)::int
              FROM delivery_order_lines warning_line
              WHERE warning_line.order_id = delivery_orders.netsuite_id
                AND warning_line.sync_exception IS NOT NULL
                AND (
                  COALESCE(warning_line.packed_pallet_qty, 0) > 0
                  OR COALESCE(warning_line.packed_section_qty, 0) > 0
                  OR COALESCE(warning_line.packed_layer_qty, 0) > 0
                  OR COALESCE(warning_line.packed_piece_qty, 0) > 0
                )
            ) AS warning_count
            , (${underpackCountSql}) AS underpack_count
     FROM delivery_orders
     WHERE ${statusClause}
       ${locationClause}
        AND netsuite_active = true
        AND (status = 'B' OR fulfillment_status = 'partial_fulfilled')
        AND fulfillment_status <> 'fulfilled'
     ORDER BY warning_count DESC, underpack_count DESC, trandate DESC, tranid DESC`
    ,
    params
  );
  return result.rows;
}

export async function getDeliveryOrder(id) {
  const order = await query(
    `SELECT delivery_orders.*,
            (
              SELECT COUNT(*)::int
              FROM delivery_order_lines warning_line
              WHERE warning_line.order_id = delivery_orders.netsuite_id
                AND warning_line.sync_exception IS NOT NULL
                AND (
                  COALESCE(warning_line.packed_pallet_qty, 0) > 0
                  OR COALESCE(warning_line.packed_section_qty, 0) > 0
                  OR COALESCE(warning_line.packed_layer_qty, 0) > 0
                  OR COALESCE(warning_line.packed_piece_qty, 0) > 0
                )
            ) AS warning_count
            , (
              SELECT COUNT(*)::int
              FROM delivery_order_lines underpack_line
              WHERE underpack_line.order_id = delivery_orders.netsuite_id
                AND COALESCE(underpack_line.item_type, '') IN ('InvtPart', 'NonInvtPart')
                AND underpack_line.netsuite_active = true
                AND (
                  GREATEST(COALESCE(underpack_line.pallet_qty, 0) - COALESCE(underpack_line.packed_pallet_qty, 0), 0) > 0
                  OR GREATEST(COALESCE(underpack_line.section_qty, 0) - COALESCE(underpack_line.packed_section_qty, 0), 0) > 0
                  OR GREATEST(COALESCE(underpack_line.layer_qty, 0) - COALESCE(underpack_line.packed_layer_qty, 0), 0) > 0
                  OR GREATEST(COALESCE(underpack_line.piece_qty, 0) - COALESCE(underpack_line.packed_piece_qty, 0), 0) > 0
                  OR (
                    COALESCE(underpack_line.pallet_qty, 0) = 0
                    AND COALESCE(underpack_line.section_qty, 0) = 0
                    AND COALESCE(underpack_line.layer_qty, 0) = 0
                    AND COALESCE(underpack_line.piece_qty, 0) = 0
                    AND GREATEST(COALESCE(underpack_line.quantity, 0) - COALESCE(underpack_line.packed_piece_qty, 0), 0) > 0
                  )
                )
            ) AS underpack_count
     FROM delivery_orders
     WHERE netsuite_id = $1`,
    [id]
  );
  if (!order.rowCount) return null;

  const lines = await query(
    `SELECT *
     FROM delivery_order_lines
     WHERE order_id = $1
       AND (
         netsuite_active = true
         OR sync_exception IS NOT NULL
         OR (${packedQtySql}) > 0
       )
     ORDER BY line_id NULLS LAST, id`,
    [id]
  );

  return { ...order.rows[0], lines: lines.rows };
}

export async function getFulfillableDeliveryOrder(orderId) {
  const order = await getDeliveryOrder(orderId);
  if (!order) throw new Error("Delivery order not found.");
  const lines = order.lines.filter((line) => {
    const delta = Math.max(positiveQuantity(line.packed_pallet_qty) - positiveQuantity(line.fulfilled_pallet_qty), 0)
      + Math.max(positiveQuantity(line.packed_layer_qty) - positiveQuantity(line.fulfilled_layer_qty), 0)
      + Math.max(positiveQuantity(line.packed_section_qty) - positiveQuantity(line.fulfilled_section_qty), 0)
      + Math.max(positiveQuantity(line.packed_piece_qty) - positiveQuantity(line.fulfilled_piece_qty), 0);
    return line.netsuite_active && !line.sync_exception && ["InvtPart", "NonInvtPart"].includes(line.item_type || "") && delta > 0;
  });
  if (!lines.length) throw new Error("No packed lines to fulfill.");
  return { ...order, fulfillableLines: lines };
}

export function buildItemFulfillmentPayload(order, lines) {
  const items = lines.map((line) => {
    const packedQuantity = fulfillmentLineQuantity(line);
    return {
      orderLine: Number(line.line_id),
      location: Number(line.location_id || order.outbound_location_id),
      quantity: packedQuantity,
      itemreceive: true
    };
  });

  const fulfilledLineIds = new Set(lines.map((line) => Number(line.line_id)));
  for (const line of order.lines || []) {
    if (!line.netsuite_active || !["InvtPart", "NonInvtPart"].includes(line.item_type || "")) continue;
    if (fulfilledLineIds.has(Number(line.line_id))) continue;
    items.push({
      orderLine: Number(line.line_id),
      location: Number(line.location_id || order.outbound_location_id),
      itemreceive: false
    });
  }

  return {
    item: { items }
  };
}

function fulfillmentLineQuantity(line) {
  const salesQuantity = Math.max(positiveQuantity(line.packed_piece_qty) - positiveQuantity(line.fulfilled_piece_qty), 0)
    || Math.max(positiveQuantity(line.packed_section_qty) - positiveQuantity(line.fulfilled_section_qty), 0)
    || Math.max(positiveQuantity(line.packed_layer_qty) - positiveQuantity(line.fulfilled_layer_qty), 0)
    || Math.max(positiveQuantity(line.packed_pallet_qty) - positiveQuantity(line.fulfilled_pallet_qty), 0);
  if (!hasConversion(line)) {
    if (hasRequiredCustomQuantity(line)) {
      return roundQuantity(positiveQuantity(line.quantity) || salesQuantity);
    }
    return roundQuantity(salesQuantity);
  }
  const convertedQuantity = (Math.max(positiveQuantity(line.packed_pallet_qty) - positiveQuantity(line.fulfilled_pallet_qty), 0) * positiveQuantity(line.to_plt))
    + (Math.max(positiveQuantity(line.packed_layer_qty) - positiveQuantity(line.fulfilled_layer_qty), 0) * positiveQuantity(line.to_lyr))
    + (Math.max(positiveQuantity(line.packed_section_qty) - positiveQuantity(line.fulfilled_section_qty), 0) * positiveQuantity(line.to_sec))
    + (Math.max(positiveQuantity(line.packed_piece_qty) - positiveQuantity(line.fulfilled_piece_qty), 0) * positiveQuantity(line.to_pcs));
  if (convertedQuantity > 0) return roundQuantity(convertedQuantity);
  return roundQuantity(salesQuantity);
}

export async function recordDeliveryFulfillment(orderId, operatorId, { photoDataUrl, payload, response, itemFulfillmentId, itemFulfillmentTranid }) {
  if (!photoDataUrl || !String(photoDataUrl).startsWith("data:image/")) {
    throw new Error("Photo proof is required.");
  }
  const order = await getDeliveryOrder(orderId);
  if (!order) throw new Error("Delivery order not found.");
  await query(
    `UPDATE delivery_order_lines
     SET fulfilled_pallet_qty = GREATEST(
           COALESCE(fulfilled_pallet_qty, 0),
           CASE
             WHEN COALESCE(to_plt, 0) = 0 AND COALESCE(to_lyr, 0) = 0 AND COALESCE(to_sec, 0) = 0 AND COALESCE(to_pcs, 0) = 0
              AND (COALESCE(pallet_qty, 0) + COALESCE(layer_qty, 0) + COALESCE(section_qty, 0) + COALESCE(piece_qty, 0)) > 0
             THEN COALESCE(pallet_qty, 0)
             ELSE COALESCE(packed_pallet_qty, 0)
           END
         ),
         fulfilled_layer_qty = GREATEST(
           COALESCE(fulfilled_layer_qty, 0),
           CASE
             WHEN COALESCE(to_plt, 0) = 0 AND COALESCE(to_lyr, 0) = 0 AND COALESCE(to_sec, 0) = 0 AND COALESCE(to_pcs, 0) = 0
              AND (COALESCE(pallet_qty, 0) + COALESCE(layer_qty, 0) + COALESCE(section_qty, 0) + COALESCE(piece_qty, 0)) > 0
             THEN COALESCE(layer_qty, 0)
             ELSE COALESCE(packed_layer_qty, 0)
           END
         ),
         fulfilled_piece_qty = GREATEST(
           COALESCE(fulfilled_piece_qty, 0),
           CASE
             WHEN COALESCE(to_plt, 0) = 0 AND COALESCE(to_lyr, 0) = 0 AND COALESCE(to_sec, 0) = 0 AND COALESCE(to_pcs, 0) = 0
              AND (COALESCE(pallet_qty, 0) + COALESCE(layer_qty, 0) + COALESCE(section_qty, 0) + COALESCE(piece_qty, 0)) > 0
             THEN COALESCE(piece_qty, 0)
             ELSE COALESCE(packed_piece_qty, 0)
           END
         ),
         fulfilled_section_qty = GREATEST(
           COALESCE(fulfilled_section_qty, 0),
           CASE
             WHEN COALESCE(to_plt, 0) = 0 AND COALESCE(to_lyr, 0) = 0 AND COALESCE(to_sec, 0) = 0 AND COALESCE(to_pcs, 0) = 0
              AND (COALESCE(pallet_qty, 0) + COALESCE(layer_qty, 0) + COALESCE(section_qty, 0) + COALESCE(piece_qty, 0)) > 0
             THEN COALESCE(section_qty, 0)
             ELSE COALESCE(packed_section_qty, 0)
           END
         )
     WHERE order_id = $1
       AND line_id = ANY($2::bigint[])`,
    [
      orderId,
      (payload?.item?.items || [])
        .filter((item) => item.itemreceive !== false && positiveQuantity(item.quantity) > 0)
        .map((item) => Number(item.orderLine))
        .filter((id) => Number.isInteger(id))
    ]
  );
  const refreshedOrder = await getDeliveryOrder(orderId);
  const remainingLines = (order.lines || []).filter((line) => {
    if (!line.netsuite_active || !["InvtPart", "NonInvtPart"].includes(line.item_type || "")) return false;
    const latest = (refreshedOrder.lines || []).find((item) => String(item.id) === String(line.id)) || line;
    return positiveQuantity(latest.pallet_qty) > positiveQuantity(latest.fulfilled_pallet_qty)
      || positiveQuantity(latest.layer_qty) > positiveQuantity(latest.fulfilled_layer_qty)
      || positiveQuantity(latest.section_qty) > positiveQuantity(latest.fulfilled_section_qty)
      || positiveQuantity(latest.piece_qty || latest.quantity) > positiveQuantity(latest.fulfilled_piece_qty);
  });
  const fulfillmentStatus = remainingLines.length ? "partial_fulfilled" : "fulfilled";

  await query(
    `INSERT INTO delivery_fulfillment_records (
       order_id, operator_id, item_fulfillment_id, item_fulfillment_tranid,
       fulfillment_status, photo_data_url, payload, response
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      orderId,
      operatorId || null,
      itemFulfillmentId || null,
      itemFulfillmentTranid || null,
      fulfillmentStatus,
      photoDataUrl,
      JSON.stringify(payload || {}),
      JSON.stringify(response || {})
    ]
  );

  await query(
    `UPDATE delivery_orders
     SET fulfillment_status = $2,
         last_item_fulfillment_id = $3,
         last_item_fulfillment_tranid = $4,
         fulfilled_at = now(),
         operator_status = CASE WHEN $2 = 'fulfilled' THEN 'fulfilled' ELSE 'packed' END,
         status_updated_at = now()
     WHERE netsuite_id = $1`,
    [orderId, fulfillmentStatus, itemFulfillmentId || null, itemFulfillmentTranid || null]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.order.fulfill",
    orderId,
    details: { fulfillmentStatus, itemFulfillmentId, itemFulfillmentTranid, payload, response }
  });

  return { fulfillmentStatus, itemFulfillmentId, itemFulfillmentTranid };
}

export async function recordDeliveryFulfillmentFailure(orderId, operatorId, { photoDataUrl, payload, error, stage }) {
  const message = error?.message || String(error || "Unknown fulfillment error");
  try {
    await query(
      `INSERT INTO delivery_fulfillment_records (
         order_id, operator_id, fulfillment_status, photo_data_url, payload, response
       ) VALUES ($1, $2, 'failed', $3, $4, $5)`,
      [
        orderId,
        operatorId || null,
        photoDataUrl && String(photoDataUrl).startsWith("data:image/") ? photoDataUrl : "",
        JSON.stringify(payload || {}),
        JSON.stringify({ error: message, stage: stage || null })
      ]
    );

    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.order.fulfill_failed",
      orderId,
      details: { error: message, stage, payload }
    });
  } catch (recordError) {
    console.error("Delivery fulfillment failure record failed:", recordError.message);
  }
}

export async function listDeliveryFulfillments({ limit = 100 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const result = await query(
    `SELECT f.id,
            f.order_id,
            o.tranid,
            f.item_fulfillment_id,
            f.item_fulfillment_tranid,
            f.fulfillment_status,
            f.created_at,
            op.display_name AS operator_name,
            f.payload,
            f.response,
            left(f.photo_data_url, 80) AS photo_preview
     FROM delivery_fulfillment_records f
     LEFT JOIN delivery_orders o ON o.netsuite_id = f.order_id
     LEFT JOIN operators op ON op.id = f.operator_id
     ORDER BY f.created_at DESC
     LIMIT ${safeLimit}`
  );
  return result.rows;
}

export async function upsertDeliveryOrderLines(orderId, lines) {
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
      to_pcs: normalizeNumber(line.to_pcs),
      section: line.section || null
    };
    const existing = await query(
      `SELECT line_id, item_id, item_name, item_type, item_type_text,
              item_description, sku, quantity, unit, location_id, location,
              pallet_qty, layer_qty, piece_qty, section_qty, section
       FROM delivery_order_lines
       WHERE order_id = $1
         AND line_id = $2`,
      [orderId, normalized.line_id]
    );

    await query(
      `INSERT INTO delivery_order_lines (
        order_id, line_id, item_id, item_name, item_type, item_type_text,
        item_description, sku, quantity,
        unit, location_id, location, pallet_qty, layer_qty, piece_qty,
        section_qty, to_plt, to_lyr, to_sec, to_pcs, section, raw, synced_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, now()
      )
      ON CONFLICT (order_id, line_id) DO UPDATE SET
        item_id = EXCLUDED.item_id,
        item_name = EXCLUDED.item_name,
        item_type = EXCLUDED.item_type,
        item_type_text = EXCLUDED.item_type_text,
        item_description = EXCLUDED.item_description,
        sku = EXCLUDED.sku,
        quantity = EXCLUDED.quantity,
        unit = EXCLUDED.unit,
        location_id = EXCLUDED.location_id,
        location = EXCLUDED.location,
        sync_exception = CASE
          WHEN (
            COALESCE(delivery_order_lines.packed_pallet_qty, 0) > COALESCE(EXCLUDED.pallet_qty, 0)
            OR COALESCE(delivery_order_lines.packed_layer_qty, 0) > COALESCE(EXCLUDED.layer_qty, 0)
            OR COALESCE(delivery_order_lines.packed_piece_qty, 0) > COALESCE(EXCLUDED.piece_qty, EXCLUDED.quantity, 0)
            OR COALESCE(delivery_order_lines.packed_section_qty, 0) > COALESCE(EXCLUDED.section_qty, 0)
          ) THEN 'qty_reduced'
          ELSE null
        END,
        sync_exception_at = CASE
          WHEN (
            COALESCE(delivery_order_lines.packed_pallet_qty, 0) > COALESCE(EXCLUDED.pallet_qty, 0)
            OR COALESCE(delivery_order_lines.packed_layer_qty, 0) > COALESCE(EXCLUDED.layer_qty, 0)
            OR COALESCE(delivery_order_lines.packed_piece_qty, 0) > COALESCE(EXCLUDED.piece_qty, EXCLUDED.quantity, 0)
            OR COALESCE(delivery_order_lines.packed_section_qty, 0) > COALESCE(EXCLUDED.section_qty, 0)
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
        section = EXCLUDED.section,
        netsuite_active = true,
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
        normalized.section,
        JSON.stringify(line)
      ]
    );

    const fields = [
      "line_id", "item_id", "item_name", "item_type", "item_type_text",
      "item_description", "sku", "quantity", "unit", "location_id", "location",
      "pallet_qty", "layer_qty", "piece_qty", "section_qty", "to_plt", "to_lyr", "to_sec", "to_pcs", "section"
    ];
    const changes = existing.rowCount ? changedFields(existing.rows[0], normalized, fields) : {};
    if (!existing.rowCount || Object.keys(changes).length) {
      await writeAudit({
        actorType: "system",
        source: "netsuite",
        action: existing.rowCount ? "netsuite.line.update" : "netsuite.line.discover",
        orderId,
        lineId: normalized.line_id,
        details: existing.rowCount ? { changes } : { line: normalized }
      });
    }
  }
}

export async function markMissingDeliveryOrderLines(orderId, activeLineIds) {
  const ids = activeLineIds.map((id) => Number(id)).filter((id) => Number.isInteger(id));
  const result = await query(
    `UPDATE delivery_order_lines
     SET netsuite_active = false,
         sync_exception = CASE WHEN (${packedQtySql}) > 0 THEN 'line_deleted' ELSE sync_exception END,
         sync_exception_at = CASE WHEN (${packedQtySql}) > 0 THEN now() ELSE sync_exception_at END,
         synced_at = now()
     WHERE order_id = $1
       AND NOT (line_id = ANY($2::bigint[]))
       AND netsuite_active = true
     RETURNING line_id, item_name, (${packedQtySql}) AS packed_qty, sync_exception`,
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

async function assertOrderEditable(orderId, operatorId) {
  const result = await query(
    `SELECT operator_status, preparing_operator_id
     FROM delivery_orders
     WHERE netsuite_id = $1`,
    [orderId]
  );
  const order = result.rows[0];
  if (!order) throw new Error("Delivery order not found.");
  if (order.operator_status === "preparing" && order.preparing_operator_id && order.preparing_operator_id !== operatorId) {
    throw new Error("This order is preparing on another tablet.");
  }
}

async function claimPreparingOrder(orderId, operatorId) {
  await assertOrderEditable(orderId, operatorId);

  const existing = await query(
    `SELECT netsuite_id
     FROM delivery_orders
     WHERE operator_status = 'preparing'
       AND preparing_operator_id = $1
       AND netsuite_id <> $2
     LIMIT 1`,
    [operatorId, orderId]
  );
  if (existing.rowCount) {
    throw new Error("Pack your current preparing order before moving on.");
  }

  await query(
    `UPDATE delivery_orders
     SET operator_status = CASE WHEN operator_status = 'open' THEN 'preparing' ELSE operator_status END,
         preparing_operator_id = CASE WHEN operator_status = 'open' THEN $2 ELSE preparing_operator_id END,
         preparing_started_at = CASE WHEN operator_status = 'open' THEN now() ELSE preparing_started_at END,
         status_updated_at = now()
     WHERE netsuite_id = $1`,
    [orderId, operatorId]
  );
}

export async function confirmDeliveryLine(orderId, lineId, values, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  await claimPreparingOrder(orderId, operatorId);

  const pallets = normalizeQuantity(values?.pallets) || 0;
  const layers = normalizeQuantity(values?.layers) || 0;
  const pieces = normalizeQuantity(values?.pieces) || 0;
  const sections = normalizeQuantity(values?.sections) || 0;

  await query(
    `UPDATE delivery_order_lines
     SET packed_pallet_qty = LEAST(COALESCE(pallet_qty, 0), COALESCE(packed_pallet_qty, 0) + $3),
         packed_layer_qty = LEAST(COALESCE(layer_qty, 0), COALESCE(packed_layer_qty, 0) + $4),
         packed_piece_qty = LEAST(COALESCE(piece_qty, quantity, 0), COALESCE(packed_piece_qty, 0) + $5),
         packed_section_qty = LEAST(COALESCE(section_qty, 0), COALESCE(packed_section_qty, 0) + $6),
         confirmed = true,
         confirmed_at = now()
     WHERE order_id = $1
       AND sync_exception IS NULL
       AND id = $2`,
    [orderId, lineId, pallets, layers, pieces, sections]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.line.confirm",
    orderId,
    lineId,
    details: { pallets, layers, pieces, sections }
  });
}

export async function setDeliveryLinePackedQuantity(orderId, lineId, values, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  await assertOrderEditable(orderId, operatorId);

  const pallets = normalizeQuantity(values?.pallets) || 0;
  const layers = normalizeQuantity(values?.layers) || 0;
  const pieces = normalizeQuantity(values?.pieces) || 0;
  const sections = normalizeQuantity(values?.sections) || 0;

  await query(
    `UPDATE delivery_order_lines
     SET packed_pallet_qty = LEAST(COALESCE(pallet_qty, 0), $3),
         packed_layer_qty = LEAST(COALESCE(layer_qty, 0), $4),
         packed_piece_qty = LEAST(COALESCE(piece_qty, quantity, 0), $5),
         packed_section_qty = LEAST(COALESCE(section_qty, 0), $6),
         confirmed = ($3 + $4 + $5 + $6) > 0,
         confirmed_at = CASE WHEN ($3 + $4 + $5 + $6) > 0 THEN COALESCE(confirmed_at, now()) ELSE null END
     WHERE order_id = $1
       AND sync_exception IS NULL
       AND id = $2`,
    [orderId, lineId, pallets, layers, pieces, sections]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.line.update_packed_quantity",
    orderId,
    lineId,
    details: { pallets, layers, pieces, sections }
  });
}

export async function unpackDeliveryLine(orderId, lineId, values, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  await assertOrderEditable(orderId, operatorId);

  const pallets = normalizeQuantity(values?.pallets) || 0;
  const layers = normalizeQuantity(values?.layers) || 0;
  const pieces = normalizeQuantity(values?.pieces) || 0;
  const sections = normalizeQuantity(values?.sections) || 0;

  await query(
    `UPDATE delivery_order_lines
     SET packed_pallet_qty = GREATEST(COALESCE(packed_pallet_qty, 0) - $3, 0),
         packed_layer_qty = GREATEST(COALESCE(packed_layer_qty, 0) - $4, 0),
         packed_piece_qty = GREATEST(COALESCE(packed_piece_qty, 0) - $5, 0),
         packed_section_qty = GREATEST(COALESCE(packed_section_qty, 0) - $6, 0),
         confirmed = (
           GREATEST(COALESCE(packed_pallet_qty, 0) - $3, 0)
           + GREATEST(COALESCE(packed_layer_qty, 0) - $4, 0)
           + GREATEST(COALESCE(packed_piece_qty, 0) - $5, 0)
           + GREATEST(COALESCE(packed_section_qty, 0) - $6, 0)
         ) > 0,
         confirmed_at = CASE WHEN (
           GREATEST(COALESCE(packed_pallet_qty, 0) - $3, 0)
           + GREATEST(COALESCE(packed_layer_qty, 0) - $4, 0)
           + GREATEST(COALESCE(packed_piece_qty, 0) - $5, 0)
           + GREATEST(COALESCE(packed_section_qty, 0) - $6, 0)
        ) > 0 THEN confirmed_at ELSE null END,
         sync_exception = CASE WHEN (
           GREATEST(COALESCE(packed_pallet_qty, 0) - $3, 0)
           + GREATEST(COALESCE(packed_layer_qty, 0) - $4, 0)
           + GREATEST(COALESCE(packed_piece_qty, 0) - $5, 0)
           + GREATEST(COALESCE(packed_section_qty, 0) - $6, 0)
         ) > 0 THEN sync_exception ELSE null END,
         sync_exception_at = CASE WHEN (
           GREATEST(COALESCE(packed_pallet_qty, 0) - $3, 0)
           + GREATEST(COALESCE(packed_layer_qty, 0) - $4, 0)
           + GREATEST(COALESCE(packed_piece_qty, 0) - $5, 0)
           + GREATEST(COALESCE(packed_section_qty, 0) - $6, 0)
         ) > 0 THEN sync_exception_at ELSE null END
     WHERE order_id = $1
       AND id = $2`,
    [orderId, lineId, pallets, layers, pieces, sections]
  );

  await query(
    `UPDATE delivery_orders
     SET operator_status = 'open',
         prepared = false,
         prepared_at = null,
         status_updated_at = now()
     WHERE netsuite_id = $1`,
    [orderId]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.line.unpack",
    orderId,
    lineId,
    details: { pallets, layers, pieces, sections }
  });
}

export async function unpackDeliveryOrder(orderId, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  await assertOrderEditable(orderId, operatorId);

  await query(
    `UPDATE delivery_order_lines
     SET packed_pallet_qty = 0,
         packed_layer_qty = 0,
         packed_piece_qty = 0,
         packed_section_qty = 0,
         confirmed = false,
         confirmed_at = null,
         sync_exception = null,
         sync_exception_at = null
     WHERE order_id = $1`,
    [orderId]
  );

  await query(
    `UPDATE delivery_orders
     SET operator_status = 'open',
         prepared = false,
         prepared_at = null,
         preparing_operator_id = null,
         preparing_started_at = null,
         status_updated_at = now()
     WHERE netsuite_id = $1`,
    [orderId]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.order.unpack",
    orderId
  });
}

export async function updateDeliveryStatus(id, status, operatorId) {
  if (!operatorId) throw new Error("Operator ID is required.");
  const allowed = new Set(["open", "preparing", "packed"]);
  if (!allowed.has(status)) throw new Error("Invalid delivery status.");

  if (status === "preparing") {
    await claimPreparingOrder(id, operatorId);
    await writeAudit({
      actorOperatorId: operatorId,
      action: "delivery.order.status",
      orderId: id,
      details: { status }
    });
    return;
  }

  await assertOrderEditable(id, operatorId);

  if (status === "packed") {
    const existing = await query(
      `SELECT netsuite_id
       FROM delivery_orders
       WHERE operator_status = 'preparing'
         AND preparing_operator_id = $1
         AND netsuite_id <> $2
       LIMIT 1`,
      [operatorId, id]
    );
    if (existing.rowCount) {
      throw new Error("Pack your current preparing order before moving on.");
    }
  }

  await query(
    `UPDATE delivery_orders
     SET operator_status = $2,
         prepared = $2 = 'packed',
         prepared_at = CASE WHEN $2 = 'packed' THEN COALESCE(prepared_at, now()) ELSE null END,
         preparing_operator_id = CASE WHEN $2 = 'packed' OR $2 = 'open' THEN null ELSE preparing_operator_id END,
         preparing_started_at = CASE WHEN $2 = 'packed' OR $2 = 'open' THEN null ELSE preparing_started_at END,
         status_updated_at = now()
     WHERE netsuite_id = $1`,
    [id, status]
  );

  await writeAudit({
    actorOperatorId: operatorId,
    action: "delivery.order.status",
    orderId: id,
    details: { status }
  });
}

export async function markDeliveryPrepared(id, { operatorName, photoPath, notes }) {
  await query(
    `UPDATE delivery_orders
     SET prepared = true,
         prepared_at = now(),
         operator_status = 'packed',
         status_updated_at = now()
     WHERE netsuite_id = $1`,
    [id]
  );

  await query(
    `INSERT INTO delivery_preparation_records (order_id, operator_name, photo_path, notes)
     VALUES ($1, $2, $3, $4)`,
    [id, operatorName || null, photoPath || null, notes || null]
  );
}
