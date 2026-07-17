import { query } from "./db.js";

const VALID_DIRECTIONS = new Set(["inbound", "outbound"]);
const VALID_ORDER_TYPES = new Set(["sales_order", "transfer_order", "purchase_order", "co_order", "vrma_order"]);

function normalizeDate(value, fallback = new Date()) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return [
    fallback.getFullYear(),
    String(fallback.getMonth() + 1).padStart(2, "0"),
    String(fallback.getDate()).padStart(2, "0")
  ].join("-");
}

function photoCountSql(arrayExpression, fallbackExpression = "''") {
  return `CASE
    WHEN jsonb_typeof(COALESCE(${arrayExpression}, '[]'::jsonb)) = 'array'
      AND jsonb_array_length(COALESCE(${arrayExpression}, '[]'::jsonb)) > 0
      THEN jsonb_array_length(COALESCE(${arrayExpression}, '[]'::jsonb))
    WHEN COALESCE(${fallbackExpression}, '') <> '' THEN 1
    ELSE 0
  END`;
}

function yardLocationIdSql(valueExpression) {
  return `CASE
    WHEN ${valueExpression} ILIKE '%3445%' THEN 1::bigint
    WHEN ${valueExpression} ILIKE '%2967%' THEN 28::bigint
    WHEN ${valueExpression} ILIKE '%12441%' THEN 15::bigint
    WHEN ${valueExpression} ILIKE '%150%' THEN 26::bigint
    ELSE NULL::bigint
  END`;
}

function receivedSalesSql(alias, { hasSalesColumn = true } = {}) {
  const salesValue = hasSalesColumn ? `COALESCE(${alias}.received_sales_qty, 0)` : "0::numeric";
  return `CASE
    WHEN ${salesValue} > 0 THEN ${salesValue}
    WHEN COALESCE(${alias}.to_plt, 0) > 0
      OR COALESCE(${alias}.to_lyr, 0) > 0
      OR COALESCE(${alias}.to_sec, 0) > 0
      OR COALESCE(${alias}.to_pcs, 0) > 0
      THEN (COALESCE(${alias}.received_pallet_qty, 0) * COALESCE(${alias}.to_plt, 0))
        + (COALESCE(${alias}.received_layer_qty, 0) * COALESCE(${alias}.to_lyr, 0))
        + (COALESCE(${alias}.received_section_qty, 0) * COALESCE(${alias}.to_sec, 0))
        + (COALESCE(${alias}.received_piece_qty, 0) * COALESCE(${alias}.to_pcs, 0))
    ELSE COALESCE(${alias}.received_pallet_qty, 0)
      + COALESCE(${alias}.received_layer_qty, 0)
      + COALESCE(${alias}.received_section_qty, 0)
      + COALESCE(${alias}.received_piece_qty, 0)
  END`;
}

function movementRecordsSql() {
  return `
    SELECT 'outbound'::text AS direction,
           'sales_order'::text AS order_type,
           o.netsuite_id AS order_id,
           o.tranid,
           o.customer AS party,
           o.outbound_location_id AS yard_location_id,
           o.outbound_location AS yard_location,
           NULL::text AS source_location,
           o.outbound_location AS destination_location,
           COALESCE(NULLIF(o.local_yard_order_status, ''), o.operator_status) AS movement_status,
           r.id AS record_id,
           r.created_at AS processed_at,
           ${photoCountSql("r.photo_data_urls", "r.photo_data_url")}::int AS photo_count
      FROM operator_load_records r
      JOIN sales_orders o ON o.netsuite_id = r.order_id
     WHERE r.order_family = 'sales_order'
       AND r.load_type IN ('sales_order_delivery_load', 'customer_pickup_load')
    UNION ALL
    SELECT 'outbound', 'transfer_order', o.netsuite_id, o.tranid,
           CONCAT_WS(' → ', NULLIF(o.from_location, ''), NULLIF(o.to_location, '')),
           o.from_location_id, o.from_location, o.from_location, o.to_location,
           COALESCE(NULLIF(o.local_yard_order_status, ''), o.outbound_operator_status),
           r.id, r.created_at,
           ${photoCountSql("r.photo_data_urls", "r.photo_data_url")}::int
      FROM operator_load_records r
      JOIN transfer_orders o ON o.netsuite_id = r.order_id
     WHERE r.order_family = 'transfer_order'
       AND r.load_type = 'transfer_order_load'
    UNION ALL
    SELECT 'outbound', 'vrma_order', o.id, o.vrma_ref,
           COALESCE(NULLIF(o.local_vendor, ''), o.vendor),
           ${yardLocationIdSql("COALESCE(o.pickup_location, '')")},
           o.pickup_location, o.pickup_location, o.dropoff_location,
           COALESCE(NULLIF(o.local_yard_order_status, ''), o.operator_status, o.status),
           r.id, r.created_at,
           ${photoCountSql("r.photo_data_urls", "r.photo_data_url")}::int
      FROM operator_load_records r
      JOIN scm_vrma_orders o ON o.id = r.order_id
     WHERE r.order_family = 'vrma_order'
       AND r.load_type = 'vrma_local_load'
    UNION ALL
    SELECT 'inbound', 'purchase_order', o.netsuite_id,
           COALESCE(NULLIF(o.dispatch_ref, ''), o.tranid), o.vendor,
           o.destination_location_id, o.destination_location,
           COALESCE(NULLIF(o.source_location, ''), o.vendor), o.destination_location,
           COALESCE(NULLIF(r.receipt_status, ''), o.receipt_status),
           r.id, r.created_at,
           ${photoCountSql("r.photo_data_urls")}::int
      FROM receiving_receipt_records r
      JOIN purchase_orders o ON o.netsuite_id = r.order_id
     WHERE r.receipt_status <> 'failed'
    UNION ALL
    SELECT 'inbound', 'transfer_order', o.netsuite_id, o.tranid,
           CONCAT_WS(' → ', NULLIF(o.from_location, ''), NULLIF(o.to_location, '')),
           o.to_location_id, o.to_location, o.from_location, o.to_location,
           COALESCE(NULLIF(r.receipt_status, ''), o.receiving_status),
           r.id, r.created_at,
           ${photoCountSql("r.photo_data_urls")}::int
      FROM receiving_receipt_records r
      JOIN transfer_orders o ON o.netsuite_id = r.order_id
     WHERE r.receipt_status <> 'failed'
    UNION ALL
    SELECT 'inbound', 'co_order', o.id, o.co_ref, o.source_order_ref,
           o.to_location_id, o.to_location, o.from_location, o.to_location,
           COALESCE(NULLIF(o.status, ''), 'received'),
           r.id, r.created_at,
           ${photoCountSql("r.photo_data_urls")}::int
      FROM local_co_receipt_records r
      JOIN local_co_orders o ON o.id = r.co_id
  `;
}

function movementLinesSql() {
  const poReceived = receivedSalesSql("l");
  const toReceived = receivedSalesSql("l");
  const coReceived = receivedSalesSql("l", { hasSalesColumn: false });
  return `
    SELECT 'outbound'::text AS direction, 'sales_order'::text AS order_type,
           l.sales_order_id AS order_id, l.id, l.line_id, l.item_id, l.item_name, l.sku,
           l.item_description, COALESCE(l.loaded_qty, 0) AS processed_qty,
           COALESCE(NULLIF(l.loaded_uom, ''), l.unit) AS processed_uom,
           l.unit, l.location, l.to_plt, l.to_lyr, l.to_sec, l.to_pcs,
           COALESCE(l.fulfilled_pallet_qty, 0) AS processed_pallet_qty,
           COALESCE(l.fulfilled_layer_qty, 0) AS processed_layer_qty,
           COALESCE(l.fulfilled_section_qty, 0) AS processed_section_qty,
           COALESCE(l.fulfilled_piece_qty, 0) AS processed_piece_qty
      FROM sales_order_lines l
     WHERE COALESCE(l.loaded_qty, 0) > 0
    UNION ALL
    SELECT 'outbound', 'transfer_order', l.transfer_order_id, l.id, l.line_id, l.item_id,
           l.item_name, l.sku, l.item_description, COALESCE(l.loaded_qty, 0),
           COALESCE(NULLIF(l.loaded_uom, ''), l.unit), l.unit, l.location,
           l.to_plt, l.to_lyr, l.to_sec, l.to_pcs,
           COALESCE(l.fulfilled_pallet_qty, 0), COALESCE(l.fulfilled_layer_qty, 0),
           COALESCE(l.fulfilled_section_qty, 0), COALESCE(l.fulfilled_piece_qty, 0)
      FROM transfer_order_lines l
     WHERE l.line_stage = 'outbound'
       AND COALESCE(l.loaded_qty, 0) > 0
    UNION ALL
    SELECT 'outbound', 'vrma_order', l.vrma_order_id, l.id, l.id, l.item_id,
           l.item_name, l.sku, l.item_description, COALESCE(l.loaded_qty, 0),
           COALESCE(NULLIF(l.loaded_uom, ''), l.unit), l.unit, NULL::text,
           l.to_plt, l.to_lyr, l.to_sec, l.to_pcs,
           0::numeric, 0::numeric, 0::numeric, 0::numeric
      FROM scm_vrma_order_lines l
     WHERE COALESCE(l.loaded_qty, 0) > 0
    UNION ALL
    SELECT 'inbound', 'purchase_order', l.purchase_order_id, l.id, l.line_id, l.item_id,
           l.item_name, l.sku, l.item_description, ${poReceived}, l.unit, l.unit, l.location,
           l.to_plt, l.to_lyr, l.to_sec, l.to_pcs,
           COALESCE(l.received_pallet_qty, 0), COALESCE(l.received_layer_qty, 0),
           COALESCE(l.received_section_qty, 0), COALESCE(l.received_piece_qty, 0)
      FROM purchase_order_lines l
     WHERE ${poReceived} > 0
    UNION ALL
    SELECT 'inbound', 'transfer_order', l.transfer_order_id, l.id, l.line_id, l.item_id,
           l.item_name, l.sku, l.item_description, ${toReceived}, l.unit, l.unit, l.location,
           l.to_plt, l.to_lyr, l.to_sec, l.to_pcs,
           COALESCE(l.received_pallet_qty, 0), COALESCE(l.received_layer_qty, 0),
           COALESCE(l.received_section_qty, 0), COALESCE(l.received_piece_qty, 0)
      FROM transfer_order_lines l
     WHERE l.line_stage = 'receiving'
       AND ${toReceived} > 0
    UNION ALL
    SELECT 'inbound', 'co_order', l.co_id, l.id, l.line_id, l.item_id,
           l.item_name, l.sku, l.item_description, ${coReceived}, l.unit, l.unit, NULL::text,
           l.to_plt, l.to_lyr, l.to_sec, l.to_pcs,
           COALESCE(l.received_pallet_qty, 0), COALESCE(l.received_layer_qty, 0),
           COALESCE(l.received_section_qty, 0), COALESCE(l.received_piece_qty, 0)
      FROM local_co_order_lines l
     WHERE ${coReceived} > 0
  `;
}

function movementPhotosSql() {
  const arrayRows = (arrayExpression, fallbackExpression = null) => `jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(COALESCE(${arrayExpression}, '[]'::jsonb)) = 'array'
        AND jsonb_array_length(COALESCE(${arrayExpression}, '[]'::jsonb)) > 0
        THEN ${arrayExpression}
      ${fallbackExpression ? `WHEN COALESCE(${fallbackExpression}, '') <> '' THEN jsonb_build_array(${fallbackExpression})` : ""}
      ELSE '[]'::jsonb
    END
  )`;
  return `
    SELECT 'outbound'::text AS direction, r.order_family AS order_type, r.order_id,
           r.id, r.created_at, photo.photo_data_url, r.response
      FROM operator_load_records r
      CROSS JOIN LATERAL ${arrayRows("r.photo_data_urls", "r.photo_data_url")} photo(photo_data_url)
     WHERE (r.order_family = 'sales_order' AND r.load_type IN ('sales_order_delivery_load', 'customer_pickup_load'))
        OR (r.order_family = 'transfer_order' AND r.load_type = 'transfer_order_load')
        OR (r.order_family = 'vrma_order' AND r.load_type = 'vrma_local_load')
    UNION ALL
    SELECT 'inbound', 'purchase_order', r.order_id, r.id, r.created_at,
           photo.photo_data_url, r.response
      FROM receiving_receipt_records r
      JOIN purchase_orders o ON o.netsuite_id = r.order_id
      CROSS JOIN LATERAL ${arrayRows("r.photo_data_urls")} photo(photo_data_url)
     WHERE r.receipt_status <> 'failed'
    UNION ALL
    SELECT 'inbound', 'transfer_order', r.order_id, r.id, r.created_at,
           photo.photo_data_url, r.response
      FROM receiving_receipt_records r
      JOIN transfer_orders o ON o.netsuite_id = r.order_id
      CROSS JOIN LATERAL ${arrayRows("r.photo_data_urls")} photo(photo_data_url)
     WHERE r.receipt_status <> 'failed'
    UNION ALL
    SELECT 'inbound', 'co_order', r.co_id, r.id, r.created_at,
           photo.photo_data_url, r.response
      FROM local_co_receipt_records r
      CROSS JOIN LATERAL ${arrayRows("r.photo_data_urls")} photo(photo_data_url)
  `;
}

function movementCtes({ lines = true, photos = false } = {}) {
  const ctes = [`movement_records AS (${movementRecordsSql()})`];
  if (lines) ctes.push(`movement_lines AS (${movementLinesSql()})`);
  if (photos) ctes.push(`movement_photos AS (${movementPhotosSql()})`);
  return `WITH ${ctes.join(",\n")}`;
}

function movementFilterParams({ from = "", to = "", yard = "all", search = "", itemSearch = "", direction = "", orderType = "" } = {}) {
  const fromDate = normalizeDate(from);
  const toDate = normalizeDate(to || fromDate);
  const params = [fromDate, toDate];
  const clauses = [
    "movement.processed_at >= $1::date",
    "movement.processed_at < ($2::date + interval '1 day')"
  ];
  const normalizedDirection = String(direction || "").trim().toLowerCase();
  if (VALID_DIRECTIONS.has(normalizedDirection)) {
    params.push(normalizedDirection);
    clauses.push(`movement.direction = $${params.length}`);
  }
  const normalizedType = String(orderType || "").trim().toLowerCase();
  if (VALID_ORDER_TYPES.has(normalizedType)) {
    params.push(normalizedType);
    clauses.push(`movement.order_type = $${params.length}`);
  }
  if (yard && yard !== "all") {
    params.push(String(yard));
    clauses.push(`movement.yard_location_id::text = $${params.length}`);
  }
  const orderTerm = String(search || "").trim();
  if (orderTerm) {
    params.push(`%${orderTerm}%`);
    clauses.push(`(
      movement.tranid ILIKE $${params.length}
      OR COALESCE(movement.party, '') ILIKE $${params.length}
      OR movement.order_id::text ILIKE $${params.length}
      OR COALESCE(movement.source_location, '') ILIKE $${params.length}
      OR COALESCE(movement.destination_location, '') ILIKE $${params.length}
    )`);
  }
  const itemTerm = String(itemSearch || "").trim();
  if (itemTerm) {
    params.push(`%${itemTerm}%`);
    clauses.push(`EXISTS (
      SELECT 1
        FROM movement_lines line
       WHERE line.direction = movement.direction
         AND line.order_type = movement.order_type
         AND line.order_id = movement.order_id
         AND (
           COALESCE(line.item_name, '') ILIKE $${params.length}
           OR COALESCE(line.sku, '') ILIKE $${params.length}
           OR COALESCE(line.item_description, '') ILIKE $${params.length}
           OR line.item_id::text ILIKE $${params.length}
         )
    )`);
  }
  return { params, where: clauses.join("\n       AND "), fromDate, toDate };
}

export async function listYardMovements(filters = {}) {
  const { params, where } = movementFilterParams(filters);
  const result = await query(
    `${movementCtes()}
     SELECT movement.direction,
            movement.order_type,
            movement.order_id,
            movement.tranid,
            movement.party,
            movement.yard_location_id,
            movement.yard_location,
            movement.source_location,
            movement.destination_location,
            (ARRAY_AGG(movement.movement_status ORDER BY movement.processed_at DESC))[1] AS movement_status,
            MIN(movement.processed_at) AS first_processed_at,
            MAX(movement.processed_at) AS last_processed_at,
            COUNT(DISTINCT movement.record_id)::int AS process_count,
            SUM(movement.photo_count)::int AS photo_count
       FROM movement_records movement
      WHERE ${where}
      GROUP BY movement.direction, movement.order_type, movement.order_id, movement.tranid,
               movement.party, movement.yard_location_id, movement.yard_location,
               movement.source_location, movement.destination_location
      ORDER BY MAX(movement.processed_at) DESC, movement.tranid`,
    params
  );
  return result.rows;
}

export async function getYardMovementDetail({ direction, orderType, orderId, from = "", to = "" } = {}) {
  const normalizedDirection = VALID_DIRECTIONS.has(String(direction || "").toLowerCase())
    ? String(direction).toLowerCase()
    : "outbound";
  const normalizedType = VALID_ORDER_TYPES.has(String(orderType || "").toLowerCase())
    ? String(orderType).toLowerCase()
    : "sales_order";
  const fromDate = normalizeDate(from);
  const toDate = normalizeDate(to || fromDate);
  const orderResult = await query(
    `${movementCtes({ lines: false })}
     SELECT movement.direction, movement.order_type, movement.order_id, movement.tranid,
            movement.party, movement.yard_location_id, movement.yard_location,
            movement.source_location, movement.destination_location,
            (ARRAY_AGG(movement.movement_status ORDER BY movement.processed_at DESC))[1] AS movement_status,
            MIN(movement.processed_at) AS first_processed_at,
            MAX(movement.processed_at) AS last_processed_at,
            COUNT(DISTINCT movement.record_id)::int AS process_count,
            SUM(movement.photo_count)::int AS photo_count
       FROM movement_records movement
      WHERE movement.direction = $1
        AND movement.order_type = $2
        AND movement.order_id = $3
        AND movement.processed_at >= $4::date
        AND movement.processed_at < ($5::date + interval '1 day')
      GROUP BY movement.direction, movement.order_type, movement.order_id, movement.tranid,
               movement.party, movement.yard_location_id, movement.yard_location,
               movement.source_location, movement.destination_location`,
    [normalizedDirection, normalizedType, orderId, fromDate, toDate]
  );
  if (!orderResult.rowCount) return null;

  const lineResult = await query(
    `WITH movement_lines AS (${movementLinesSql()})
     SELECT *
       FROM movement_lines
      WHERE direction = $1
        AND order_type = $2
        AND order_id = $3
      ORDER BY line_id NULLS LAST, id`,
    [normalizedDirection, normalizedType, orderId]
  );
  const photoResult = await query(
    `WITH movement_photos AS (${movementPhotosSql()})
     SELECT id, created_at, photo_data_url, response
       FROM movement_photos
      WHERE direction = $1
        AND order_type = $2
        AND order_id = $3
        AND created_at >= $4::date
        AND created_at < ($5::date + interval '1 day')
      ORDER BY created_at DESC, id DESC`,
    [normalizedDirection, normalizedType, orderId, fromDate, toDate]
  );
  return { order: orderResult.rows[0], lines: lineResult.rows, photos: photoResult.rows };
}

export async function listYardMovementCsvRows(filters = {}) {
  const orders = await listYardMovements(filters);
  const rows = [];
  for (const order of orders) {
    const detail = await getYardMovementDetail({
      direction: order.direction,
      orderType: order.order_type,
      orderId: order.order_id,
      from: filters.from,
      to: filters.to
    });
    for (const line of detail?.lines || []) {
      rows.push({
        direction: order.direction,
        order_type: order.order_type,
        order_ref: order.tranid,
        processed_at: order.last_processed_at,
        yard_location: order.yard_location,
        party: order.party,
        ...line
      });
    }
  }
  return rows;
}
