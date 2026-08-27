import { hasActiveTransaction, query } from "./db.js";
import { salesStoreLocationIdSql } from "./sales-store.js";
import {
  getActiveReloadCycleForOrder,
  getLatestSalesOrderReattemptForOrder,
  listSalesOrderLoadAttempts
} from "./sales-order-reload-repository.js";

const VALID_DIRECTIONS = new Set(["inbound", "outbound"]);
const VALID_ORDER_TYPES = new Set(["sales_order", "transfer_order", "purchase_order", "co_order", "vrma_order", "custom_order"]);

function salesModuleLocationIdSql(alias = "movement") {
  return `CASE
    WHEN ${alias}.order_type = 'sales_order' THEN ${salesStoreLocationIdSql(`${alias}.tranid`)}
    ELSE ${alias}.yard_location_id
  END`;
}

function normalizeDate(value, fallback = new Date()) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return [
    fallback.getFullYear(),
    String(fallback.getMonth() + 1).padStart(2, "0"),
    String(fallback.getDate()).padStart(2, "0")
  ].join("-");
}

function dateKey(value) {
  if (!value) return "";
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value).slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function attemptsWithinDates(attempts, fromDate, toDate) {
  return (attempts || []).filter((attempt) => {
    const key = dateKey(attempt.processedAt);
    return key && key >= fromDate && key <= toDate;
  });
}

async function runIndependentReads(reads) {
  if (!hasActiveTransaction()) return Promise.all(reads.map((read) => read()));
  const results = [];
  for (const read of reads) results.push(await read());
  return results;
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

function exactYardCodeLocationIdSql(valueExpression) {
  return `CASE
    WHEN BTRIM(COALESCE(${valueExpression}, '')) = '3445' THEN 1::bigint
    WHEN BTRIM(COALESCE(${valueExpression}, '')) = '2967' THEN 28::bigint
    WHEN BTRIM(COALESCE(${valueExpression}, '')) = '12441' THEN 15::bigint
    WHEN BTRIM(COALESCE(${valueExpression}, '')) = '150' THEN 26::bigint
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

function activityWindowSql(expression, fromParam, toParam) {
  if (!fromParam || !toParam) return "";
  return `AND ${expression} >= $${fromParam}::date
       AND ${expression} < ($${toParam}::date + interval '1 day')`;
}

function movementRecordsSql({ fromParam = null, toParam = null } = {}) {
  const recordWindow = (alias) => activityWindowSql(`${alias}.created_at`, fromParam, toParam);
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
       ${recordWindow("r")}
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
       ${recordWindow("r")}
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
       ${recordWindow("r")}
    UNION ALL
    SELECT 'outbound', 'co_order', o.id, o.co_ref, o.source_order_ref,
           o.from_location_id, o.from_location, o.from_location, o.to_location,
           COALESCE(NULLIF(o.status, ''), 'planned'),
           r.id, r.created_at,
           ${photoCountSql("r.photo_data_urls", "r.photo_data_url")}::int
      FROM operator_load_records r
      JOIN local_co_orders o
        ON o.id = r.source_record_id
       AND r.source_table = 'local_co_orders'
     WHERE r.load_type = 'local_co_load'
       ${recordWindow("r")}
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
       ${recordWindow("r")}
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
       ${recordWindow("r")}
    UNION ALL
    SELECT 'inbound', 'co_order', o.id, o.co_ref, o.source_order_ref,
           o.to_location_id, o.to_location, o.from_location, o.to_location,
           COALESCE(NULLIF(o.status, ''), 'received'),
           r.id, r.created_at,
           ${photoCountSql("r.photo_data_urls")}::int
      FROM local_co_receipt_records r
      JOIN local_co_orders o ON o.id = r.co_id
     WHERE 1 = 1
       ${recordWindow("r")}
  `;
}

function driverOrderCtes({ fromParam = null, toParam = null } = {}) {
  const driverPhotoCount = photoCountSql("r.photo_data_urls");
  const driverActivityAt = `CASE
    WHEN r.status = 'complete' THEN COALESCE(r.completed_at, r.started_at, r.created_at)
    ELSE COALESCE(r.started_at, r.created_at)
  END`;
  const driverWindow = activityWindowSql(driverActivityAt, fromParam, toParam);
  return [
    `driver_record_refs AS (
      SELECT r.id AS driver_record_id,
             r.job_id,
             r.plan_id,
             r.plan_date,
             r.driver_login,
             COALESCE(NULLIF(d.name, ''), r.driver_login) AS driver_name,
             r.truck_id,
             r.truck_plate,
             r.load_id,
             r.load_name,
             r.stop_id,
             r.stop_type,
             r.order_refs,
             r.photo_data_urls,
             r.status,
             r.started_at,
             r.completed_at,
             r.created_at,
             r.job_details,
             ref.order_ref,
             ref.ref_index,
             ${driverPhotoCount}::int AS driver_photo_count
        FROM driver_job_records r
        LEFT JOIN dispatch_drivers d
          ON LOWER(BTRIM(d.login)) = LOWER(BTRIM(r.driver_login))
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(COALESCE(r.order_refs, '[]'::jsonb)) = 'array'
              THEN COALESCE(r.order_refs, '[]'::jsonb)
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS ref(order_ref, ref_index)
       WHERE r.stop_type IN ('pickup', 'dropoff')
         AND r.status IN ('in_progress', 'complete')
         AND BTRIM(ref.order_ref) <> ''
         ${driverWindow}
    )`,
    `driver_order_matches AS (
      SELECT refs.*,
             'outbound'::text AS direction,
             'sales_order'::text AS order_type,
             o.netsuite_id AS order_id,
             o.tranid,
             o.customer AS party,
             o.outbound_location_id AS yard_location_id,
             o.outbound_location AS yard_location,
             NULL::text AS source_location,
             o.outbound_location AS destination_location,
             10 AS match_priority
        FROM driver_record_refs refs
        JOIN sales_orders o
          ON LOWER(BTRIM(o.tranid)) = LOWER(BTRIM(refs.order_ref))
      UNION ALL
      SELECT refs.*,
             'inbound', 'purchase_order', o.netsuite_id,
             COALESCE(NULLIF(o.dispatch_ref, ''), o.tranid), o.vendor,
             o.destination_location_id, o.destination_location,
             COALESCE(NULLIF(o.source_location, ''), o.vendor), o.destination_location,
             20
        FROM driver_record_refs refs
        JOIN purchase_orders o
          ON LOWER(BTRIM(refs.order_ref)) IN (
            LOWER(BTRIM(COALESCE(o.tranid, ''))),
            LOWER(BTRIM(COALESCE(o.dispatch_ref, '')))
          )
      UNION ALL
      SELECT refs.*,
             CASE WHEN refs.stop_type = 'dropoff' THEN 'inbound' ELSE 'outbound' END,
             'transfer_order', o.netsuite_id, o.tranid,
             CONCAT_WS(' → ', NULLIF(o.from_location, ''), NULLIF(o.to_location, '')),
             CASE WHEN refs.stop_type = 'dropoff' THEN o.to_location_id ELSE o.from_location_id END,
             CASE WHEN refs.stop_type = 'dropoff' THEN o.to_location ELSE o.from_location END,
             o.from_location, o.to_location,
             30
        FROM driver_record_refs refs
        JOIN transfer_orders o
          ON LOWER(BTRIM(o.tranid)) = LOWER(BTRIM(refs.order_ref))
      UNION ALL
      SELECT refs.*,
             CASE WHEN refs.stop_type = 'dropoff' THEN 'inbound' ELSE 'outbound' END,
             'co_order', o.id, o.co_ref, o.source_order_ref,
             CASE WHEN refs.stop_type = 'dropoff' THEN o.to_location_id ELSE o.from_location_id END,
             CASE WHEN refs.stop_type = 'dropoff' THEN o.to_location ELSE o.from_location END,
             o.from_location, o.to_location,
             40
        FROM driver_record_refs refs
        JOIN local_co_orders o
          ON LOWER(BTRIM(o.co_ref)) = LOWER(BTRIM(refs.order_ref))
      UNION ALL
      SELECT refs.*,
             'outbound', 'vrma_order', o.id, o.vrma_ref,
             COALESCE(NULLIF(o.local_vendor, ''), o.vendor),
             ${yardLocationIdSql("COALESCE(o.pickup_location, '')")},
             o.pickup_location, o.pickup_location, o.dropoff_location,
             50
        FROM driver_record_refs refs
        JOIN scm_vrma_orders o
          ON LOWER(BTRIM(o.vrma_ref)) = LOWER(BTRIM(refs.order_ref))
      UNION ALL
      SELECT refs.*,
             'outbound', 'custom_order', o.id, o.ref_number,
             'Custom Order',
             ${exactYardCodeLocationIdSql("o.pickup_location")},
             o.pickup_location, o.pickup_location, o.dropoff_location,
             60
        FROM driver_record_refs refs
        JOIN dispatch_custom_orders o
          ON LOWER(BTRIM(o.ref_number)) = LOWER(BTRIM(refs.order_ref))
    )`,
    `driver_order_events AS (
      SELECT ranked.*
        FROM (
          SELECT matched.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY matched.driver_record_id, matched.ref_index
                   ORDER BY matched.match_priority, matched.order_type, matched.order_id
                 ) AS match_rank
            FROM driver_order_matches matched
        ) ranked
       WHERE ranked.match_rank = 1
    )`
  ];
}

function recordEventsSql() {
  return `
    SELECT movement.direction,
           movement.order_type,
           movement.order_id,
           movement.tranid,
           movement.party,
           movement.yard_location_id,
           movement.yard_location,
           movement.source_location,
           movement.destination_location,
           movement.movement_status,
           CONCAT('yard:', movement.direction, ':', movement.order_type, ':', movement.record_id) AS event_key,
           movement.processed_at AS activity_at,
           1::int AS yard_activity_count,
           movement.photo_count::int AS yard_photo_count,
           0::int AS driver_activity_count,
           0::int AS driver_photo_count,
           NULL::timestamptz AS driver_completed_at,
           NULL::timestamptz AS delivery_at,
           NULL::text AS driver_name,
           NULL::text AS driver_login,
           NULL::text AS truck_plate,
           NULL::text AS stop_type
      FROM movement_records movement
    UNION ALL
    SELECT event.direction,
           event.order_type,
           event.order_id,
           event.tranid,
           event.party,
           event.yard_location_id,
           event.yard_location,
           event.source_location,
           event.destination_location,
           CASE
             WHEN event.status = 'complete' AND event.stop_type = 'dropoff' THEN 'delivered'
             WHEN event.status = 'complete' AND event.stop_type = 'pickup' THEN 'pickup complete'
             ELSE 'driver in progress'
           END,
           CONCAT('driver:', event.driver_record_id),
           CASE
             WHEN event.status = 'complete'
               THEN COALESCE(event.completed_at, event.started_at, event.created_at)
             ELSE COALESCE(event.started_at, event.created_at)
           END,
           0,
           0,
           1,
           event.driver_photo_count,
           CASE WHEN event.status = 'complete' THEN event.completed_at ELSE NULL END,
           CASE
             WHEN event.status = 'complete' AND event.stop_type = 'dropoff'
               THEN event.completed_at
             ELSE NULL
           END,
           event.driver_name,
           event.driver_login,
           event.truck_plate,
           event.stop_type
      FROM driver_order_events event
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
    SELECT 'outbound', 'co_order', o.id, COALESCE(l.id, r.id),
           NULLIF(snapshot."lineId", '')::bigint, COALESCE(l.item_id, NULLIF(snapshot."itemId", '')::bigint),
           COALESCE(NULLIF(l.item_name, ''), snapshot."itemName"),
           COALESCE(NULLIF(l.sku, ''), snapshot."itemName"),
           COALESCE(NULLIF(l.item_description, ''), snapshot.description),
           COALESCE(snapshot.quantity, 0),
           COALESCE(NULLIF(snapshot."loadedUom", ''), NULLIF(snapshot.unit, ''), l.unit),
           COALESCE(NULLIF(snapshot.unit, ''), l.unit), NULL::text,
           l.to_plt, l.to_lyr, l.to_sec, l.to_pcs,
           COALESCE(snapshot."packedPallets", 0), COALESCE(snapshot."packedLayers", 0),
           COALESCE(snapshot."packedSections", 0), COALESCE(snapshot."packedPieces", 0)
      FROM operator_load_records r
      JOIN local_co_orders o
        ON o.id = r.source_record_id
       AND r.source_table = 'local_co_orders'
      CROSS JOIN LATERAL jsonb_to_recordset(COALESCE(r.line_snapshot, '[]'::jsonb)) AS snapshot(
        "lineId" text, "itemId" text, "itemName" text, description text,
        quantity numeric, unit text, "packedPallets" numeric, "packedLayers" numeric,
        "packedSections" numeric, "packedPieces" numeric, "packedSalesQty" numeric,
        "loadedQty" numeric, "loadedUom" text
      )
      LEFT JOIN local_co_order_lines l
        ON l.co_id = o.id
       AND l.line_id::text = snapshot."lineId"
     WHERE r.load_type = 'local_co_load'
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
    UNION ALL
    SELECT 'outbound', 'custom_order', o.id, o.id, 1::bigint, NULL::bigint,
           'Custom order', 'CUSTOM', o.order_details, 1::numeric,
           'LOAD', 'LOAD', o.pickup_location,
           NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
           0::numeric, 0::numeric, 0::numeric, 0::numeric
      FROM dispatch_custom_orders o
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
           r.id, r.created_at, photo.photo_data_url, r.response, 'yard'::text AS source
      FROM operator_load_records r
      CROSS JOIN LATERAL ${arrayRows("r.photo_data_urls", "r.photo_data_url")} photo(photo_data_url)
     WHERE (r.order_family = 'sales_order' AND r.load_type IN ('sales_order_delivery_load', 'customer_pickup_load'))
        OR (r.order_family = 'transfer_order' AND r.load_type = 'transfer_order_load')
        OR (r.order_family = 'vrma_order' AND r.load_type = 'vrma_local_load')
    UNION ALL
    SELECT 'outbound', 'co_order', o.id, r.id, r.created_at,
           photo.photo_data_url, r.response, 'yard'
      FROM operator_load_records r
      JOIN local_co_orders o
        ON o.id = r.source_record_id
       AND r.source_table = 'local_co_orders'
      CROSS JOIN LATERAL ${arrayRows("r.photo_data_urls", "r.photo_data_url")} photo(photo_data_url)
     WHERE r.load_type = 'local_co_load'
    UNION ALL
    SELECT 'inbound', 'purchase_order', r.order_id, r.id, r.created_at,
           photo.photo_data_url, r.response, 'yard'
      FROM receiving_receipt_records r
      JOIN purchase_orders o ON o.netsuite_id = r.order_id
      CROSS JOIN LATERAL ${arrayRows("r.photo_data_urls")} photo(photo_data_url)
     WHERE r.receipt_status <> 'failed'
    UNION ALL
    SELECT 'inbound', 'transfer_order', r.order_id, r.id, r.created_at,
           photo.photo_data_url, r.response, 'yard'
      FROM receiving_receipt_records r
      JOIN transfer_orders o ON o.netsuite_id = r.order_id
      CROSS JOIN LATERAL ${arrayRows("r.photo_data_urls")} photo(photo_data_url)
     WHERE r.receipt_status <> 'failed'
    UNION ALL
    SELECT 'inbound', 'co_order', r.co_id, r.id, r.created_at,
           photo.photo_data_url, r.response, 'yard'
      FROM local_co_receipt_records r
      CROSS JOIN LATERAL ${arrayRows("r.photo_data_urls")} photo(photo_data_url)
  `;
}

function movementCtes({
  lines = true,
  photos = false,
  events = true,
  fromParam = null,
  toParam = null
} = {}) {
  const ctes = [
    `movement_records AS (${movementRecordsSql({ fromParam, toParam })})`,
    ...driverOrderCtes({ fromParam, toParam })
  ];
  if (events) ctes.push(`record_events AS (${recordEventsSql()})`);
  if (lines) ctes.push(`movement_lines AS (${movementLinesSql()})`);
  if (photos) ctes.push(`movement_photos AS (${movementPhotosSql()})`);
  return `WITH ${ctes.join(",\n")}`;
}

function movementFilterParams({
  from = "",
  to = "",
  yard = "all",
  search = "",
  itemSearch = "",
  driver = "all",
  direction = "",
  orderType = "",
  allowedYardLocationIds,
  allowedSalesStoreLocationIds
} = {}) {
  const fromDate = normalizeDate(from);
  const toDate = normalizeDate(to || fromDate);
  const params = [fromDate, toDate];
  const clauses = [
    "movement.activity_at >= $1::date",
    "movement.activity_at < ($2::date + interval '1 day')"
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
  const salesStoreScoped = Array.isArray(allowedSalesStoreLocationIds);
  const locationIdSql = salesStoreScoped
    ? salesModuleLocationIdSql("movement")
    : "movement.yard_location_id";
  if (yard && yard !== "all") {
    params.push(String(yard));
    clauses.push(`(${locationIdSql})::text = $${params.length}`);
  }
  if (salesStoreScoped) {
    const allowedStores = [...new Set(
      allowedSalesStoreLocationIds.map(Number).filter((value) => Number.isInteger(value) && value > 0)
    )];
    if (!allowedStores.length) {
      clauses.push("FALSE");
    } else {
      params.push(allowedStores);
      clauses.push(`(${locationIdSql}) = ANY($${params.length}::bigint[])`);
    }
  } else if (Array.isArray(allowedYardLocationIds)) {
    const allowedYards = [...new Set(
      allowedYardLocationIds.map(Number).filter((value) => Number.isInteger(value) && value > 0)
    )];
    if (!allowedYards.length) {
      clauses.push("FALSE");
    } else {
      params.push(allowedYards);
      clauses.push(`movement.yard_location_id = ANY($${params.length}::bigint[])`);
    }
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
  const driverLogin = String(driver || "").trim();
  if (driverLogin && driverLogin.toLowerCase() !== "all") {
    params.push(driverLogin);
    clauses.push(`LOWER(BTRIM(COALESCE(movement.driver_login, ''))) = LOWER(BTRIM($${params.length}))`);
  }
  return { params, where: clauses.join("\n       AND "), fromDate, toDate };
}

function movementSummaryColumns(alias = "movement") {
  return `
    ${alias}.direction,
    ${alias}.order_type,
    ${alias}.order_id,
    (ARRAY_AGG(${alias}.tranid ORDER BY ${alias}.activity_at DESC))[1] AS tranid,
    (ARRAY_AGG(${alias}.party ORDER BY ${alias}.activity_at DESC))[1] AS party,
    (ARRAY_AGG(${alias}.yard_location_id ORDER BY ${alias}.activity_at DESC))[1] AS yard_location_id,
    (ARRAY_AGG(${alias}.yard_location ORDER BY ${alias}.activity_at DESC))[1] AS yard_location,
    (ARRAY_AGG(${alias}.source_location ORDER BY ${alias}.activity_at DESC))[1] AS source_location,
    (ARRAY_AGG(${alias}.destination_location ORDER BY ${alias}.activity_at DESC))[1] AS destination_location,
    (ARRAY_AGG(${alias}.movement_status ORDER BY ${alias}.activity_at DESC))[1] AS movement_status,
    MIN(${alias}.activity_at) FILTER (WHERE ${alias}.yard_activity_count > 0) AS first_processed_at,
    MAX(${alias}.activity_at) FILTER (WHERE ${alias}.yard_activity_count > 0) AS last_processed_at,
    MIN(${alias}.activity_at) AS first_activity_at,
    MAX(${alias}.activity_at) AS last_activity_at,
    COUNT(DISTINCT ${alias}.event_key) FILTER (WHERE ${alias}.yard_activity_count > 0)::int AS process_count,
    COUNT(DISTINCT ${alias}.event_key) FILTER (WHERE ${alias}.yard_activity_count > 0)::int AS yard_activity_count,
    COUNT(DISTINCT ${alias}.event_key) FILTER (WHERE ${alias}.driver_activity_count > 0)::int AS driver_activity_count,
    COUNT(DISTINCT ${alias}.event_key) FILTER (WHERE ${alias}.driver_activity_count > 0)::int AS driver_record_count,
    COALESCE(SUM(${alias}.yard_photo_count), 0)::int AS yard_photo_count,
    COALESCE(SUM(${alias}.driver_photo_count), 0)::int AS driver_photo_count,
    COALESCE(SUM(${alias}.yard_photo_count + ${alias}.driver_photo_count), 0)::int AS photo_count,
    MAX(${alias}.driver_completed_at) AS last_driver_completed_at,
    MAX(${alias}.delivery_at) AS delivery_at,
    BOOL_OR(${alias}.yard_activity_count > 0) AS has_yard_record,
    BOOL_OR(${alias}.driver_activity_count > 0) AS has_driver_record,
    (
      NOT BOOL_OR(${alias}.yard_activity_count > 0)
      AND BOOL_OR(${alias}.driver_activity_count > 0)
    ) AS driver_only,
    (
      ARRAY_AGG(NULLIF(${alias}.driver_name, '') ORDER BY ${alias}.activity_at DESC)
        FILTER (WHERE COALESCE(${alias}.driver_name, '') <> '')
    )[1] AS driver_name,
    (
      ARRAY_AGG(NULLIF(${alias}.truck_plate, '') ORDER BY ${alias}.activity_at DESC)
        FILTER (WHERE COALESCE(${alias}.truck_plate, '') <> '')
    )[1] AS truck_plate
  `;
}

export async function listYardMovements(filters = {}) {
  const { params, where } = movementFilterParams(filters);
  const result = await query(
    `${movementCtes({ fromParam: 1, toParam: 2 })},
     matching_orders AS (
       SELECT DISTINCT movement.direction, movement.order_type, movement.order_id
         FROM record_events movement
        WHERE ${where}
     )
     SELECT ${movementSummaryColumns()}
       FROM record_events movement
       JOIN matching_orders matched
         ON matched.direction = movement.direction
        AND matched.order_type = movement.order_type
        AND matched.order_id = movement.order_id
      GROUP BY movement.direction, movement.order_type, movement.order_id
      ORDER BY MAX(movement.activity_at) DESC,
               (ARRAY_AGG(movement.tranid ORDER BY movement.activity_at DESC))[1]`,
    params
  );
  return result.rows;
}

export async function getYardMovementDetail({
  direction,
  orderType,
  orderId,
  from = "",
  to = "",
  allowedYardLocationIds,
  allowedSalesStoreLocationIds
} = {}) {
  const normalizedDirection = VALID_DIRECTIONS.has(String(direction || "").toLowerCase())
    ? String(direction).toLowerCase()
    : "outbound";
  const normalizedType = VALID_ORDER_TYPES.has(String(orderType || "").toLowerCase())
    ? String(orderType).toLowerCase()
    : "sales_order";
  const fromDate = normalizeDate(from);
  const toDate = normalizeDate(to || fromDate);
  const params = [normalizedDirection, normalizedType, String(orderId || ""), fromDate, toDate];
  const allowedClauses = [];
  const salesStoreScoped = Array.isArray(allowedSalesStoreLocationIds);
  const allowedLocationIds = salesStoreScoped
    ? allowedSalesStoreLocationIds
    : allowedYardLocationIds;
  if (Array.isArray(allowedLocationIds)) {
    const allowedYards = [...new Set(
      allowedLocationIds.map(Number).filter((value) => Number.isInteger(value) && value > 0)
    )];
    if (!allowedYards.length) {
      allowedClauses.push("FALSE");
    } else {
      params.push(allowedYards);
      const locationIdSql = salesStoreScoped
        ? salesModuleLocationIdSql("movement")
        : "movement.yard_location_id";
      allowedClauses.push(`(${locationIdSql}) = ANY($${params.length}::bigint[])`);
    }
  }
  const orderResult = await query(
    `${movementCtes({ lines: false, fromParam: 4, toParam: 5 })},
     matching_order AS (
       SELECT DISTINCT movement.direction, movement.order_type, movement.order_id
         FROM record_events movement
        WHERE movement.direction = $1
          AND movement.order_type = $2
          AND movement.order_id::text = $3
          AND movement.activity_at >= $4::date
          AND movement.activity_at < ($5::date + interval '1 day')
          ${allowedClauses.length ? `AND ${allowedClauses.join("\n          AND ")}` : ""}
     )
     SELECT ${movementSummaryColumns()}
       FROM record_events movement
       JOIN matching_order matched
         ON matched.direction = movement.direction
        AND matched.order_type = movement.order_type
        AND matched.order_id = movement.order_id
      GROUP BY movement.direction, movement.order_type, movement.order_id`,
    params
  );
  if (!orderResult.rowCount) return null;

  const identityParams = [normalizedDirection, normalizedType, String(orderId || "")];
  const detailParams = [...identityParams, fromDate, toDate];
  const readLines = () => query(
    `WITH movement_lines AS (${movementLinesSql()})
       SELECT *
         FROM movement_lines
        WHERE direction = $1
          AND order_type = $2
          AND order_id::text = $3
        ORDER BY line_id NULLS LAST, id`,
    identityParams
  );
  const readPhotos = () => query(
    `WITH movement_photos AS (${movementPhotosSql()})
       SELECT id, created_at, photo_data_url, response, source
         FROM movement_photos
        WHERE direction = $1
          AND order_type = $2
          AND order_id::text = $3
          AND created_at >= $4::date
          AND created_at < ($5::date + interval '1 day')
        ORDER BY created_at DESC, id DESC`,
    detailParams
  );
  const readDriverRecords = () => query(
    `${movementCtes({ lines: false, events: false, fromParam: 4, toParam: 5 })}
       SELECT event.driver_record_id AS id,
              event.job_id,
              event.plan_id,
              event.plan_date,
              event.stop_id,
              event.stop_type,
              event.driver_login,
              event.driver_name,
              event.truck_id,
              event.truck_plate,
              event.load_id,
              event.load_name,
              event.status,
              event.started_at,
              event.completed_at,
              event.created_at,
              CASE
                WHEN event.completed_at IS NOT NULL AND event.started_at IS NOT NULL
                  THEN GREATEST(0, EXTRACT(EPOCH FROM event.completed_at - event.started_at))::int
                ELSE NULL
              END AS duration_seconds,
              event.driver_photo_count AS photo_count,
              event.photo_data_urls,
              event.job_details,
              CASE
                WHEN event.status = 'complete' AND event.stop_type = 'dropoff'
                  THEN event.completed_at
                ELSE NULL
              END AS delivery_at,
              'driver'::text AS source
         FROM driver_order_events event
        WHERE event.direction = $1
          AND event.order_type = $2
          AND event.order_id::text = $3
        ORDER BY COALESCE(event.completed_at, event.started_at, event.created_at) DESC,
                 event.driver_record_id DESC`,
    detailParams
  );
  const readDriverPhotos = () => query(
    `${movementCtes({ lines: false, events: false, fromParam: 4, toParam: 5 })}
       SELECT CONCAT(event.driver_record_id, ':', photo.photo_index) AS id,
              event.driver_record_id,
              COALESCE(event.completed_at, event.started_at, event.created_at) AS created_at,
              photo.photo_data_url,
              'driver'::text AS source,
              event.stop_type,
              event.driver_login,
              event.driver_name,
              event.truck_plate
         FROM driver_order_events event
         CROSS JOIN LATERAL jsonb_array_elements_text(
           CASE
             WHEN jsonb_typeof(COALESCE(event.photo_data_urls, '[]'::jsonb)) = 'array'
               THEN COALESCE(event.photo_data_urls, '[]'::jsonb)
             ELSE '[]'::jsonb
           END
         ) WITH ORDINALITY AS photo(photo_data_url, photo_index)
        WHERE event.direction = $1
          AND event.order_type = $2
          AND event.order_id::text = $3
        ORDER BY COALESCE(event.completed_at, event.started_at, event.created_at) DESC,
                 event.driver_record_id DESC,
                 photo.photo_index`,
    detailParams
  );
  const isSalesOrderLoad = normalizedDirection === "outbound"
    && normalizedType === "sales_order"
    && /^\d+$/.test(String(orderId || ""));
  const [
    lineResult,
    photoResult,
    driverResult,
    driverPhotoResult,
    allLoadAttempts,
    activeReloadCycle,
    latestReattemptCycle
  ] = await runIndependentReads([
    readLines,
    readPhotos,
    readDriverRecords,
    readDriverPhotos,
    () => (isSalesOrderLoad ? listSalesOrderLoadAttempts(Number(orderId)) : Promise.resolve([])),
    () => (isSalesOrderLoad ? getActiveReloadCycleForOrder(Number(orderId)) : Promise.resolve(null)),
    () => (isSalesOrderLoad ? getLatestSalesOrderReattemptForOrder(Number(orderId)) : Promise.resolve(null))
  ]);
  const loadAttempts = attemptsWithinDates(allLoadAttempts, fromDate, toDate);
  return {
    order: orderResult.rows[0],
    lines: lineResult.rows,
    photos: photoResult.rows,
    driverRecords: driverResult.rows,
    driverEvents: driverResult.rows,
    driverPhotos: driverPhotoResult.rows,
    loadAttempts,
    activeReloadCycle,
    latestReattemptCycle
  };
}

function attemptCsvLine(attemptLine = {}, detailLines = []) {
  const canonical = detailLines.find((line) => (
    String(line.id) === String(attemptLine.salesOrderLineId || "")
    || String(line.line_id) === String(attemptLine.lineId || "")
    || (attemptLine.itemId && String(line.item_id) === String(attemptLine.itemId))
  )) || {};
  return {
    id: attemptLine.salesOrderLineId || canonical.id || null,
    line_id: attemptLine.lineId || canonical.line_id || null,
    item_id: attemptLine.itemId || canonical.item_id || null,
    item_name: attemptLine.itemName || canonical.item_name || "",
    sku: attemptLine.sku || canonical.sku || "",
    item_description: attemptLine.description || canonical.item_description || "",
    processed_qty: attemptLine.loadedQty ?? attemptLine.quantity ?? attemptLine.packedSalesQty ?? 0,
    processed_uom: attemptLine.loadedUom || attemptLine.unit || canonical.processed_uom || canonical.unit || "",
    unit: attemptLine.unit || canonical.unit || "",
    location: canonical.location || "",
    to_plt: canonical.to_plt ?? null,
    to_lyr: canonical.to_lyr ?? null,
    to_sec: canonical.to_sec ?? null,
    to_pcs: canonical.to_pcs ?? null,
    processed_pallet_qty: attemptLine.packedPallets ?? 0,
    processed_layer_qty: attemptLine.packedLayers ?? 0,
    processed_section_qty: attemptLine.packedSections ?? 0,
    processed_piece_qty: attemptLine.packedPieces ?? 0
  };
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
      to: filters.to,
      allowedYardLocationIds: filters.allowedYardLocationIds,
      allowedSalesStoreLocationIds: filters.allowedSalesStoreLocationIds
    });
    const latestDelivery = (detail?.driverRecords || [])
      .find((record) => record.stop_type === "dropoff" && record.status === "complete");
    const common = {
      direction: order.direction,
      order_type: order.order_type,
      order_ref: order.tranid,
      processed_at: order.last_processed_at,
      last_activity_at: order.last_activity_at,
      delivery_at: order.delivery_at,
      yard_location: order.yard_location,
      party: order.party,
      driver_only: order.driver_only,
      driver_name: latestDelivery?.driver_name || order.driver_name || "",
      truck_plate: latestDelivery?.truck_plate || order.truck_plate || "",
      yard_photo_count: order.yard_photo_count,
      driver_photo_count: order.driver_photo_count
    };
    const loadAttempts = detail?.loadAttempts || [];
    if (order.direction === "outbound" && order.order_type === "sales_order" && loadAttempts.length) {
      for (const attempt of loadAttempts) {
        const attemptCommon = {
          ...common,
          processed_at: attempt.processedAt,
          yard_photo_count: attempt.photos.length,
          attempt_id: attempt.id,
          attempt_kind: attempt.attemptKind,
          attempt_cycle_number: attempt.cycleNumber,
          attempt_reason: attempt.reason,
          attempt_operator: attempt.operatorName || attempt.operatorId || "",
          attempt_authorized_by: attempt.authorizedByName || attempt.authorizedBy || "",
          attempt_quantity_basis: attempt.quantityBasis,
          attempt_processed_at: attempt.processedAt
        };
        if (!attempt.attemptLines.length) {
          rows.push(attemptCommon);
          continue;
        }
        for (const line of attempt.attemptLines) {
          rows.push({ ...attemptCommon, ...attemptCsvLine(line, detail?.lines || []) });
        }
      }
      continue;
    }
    const lines = detail?.lines || [];
    if (!lines.length) {
      rows.push(common);
      continue;
    }
    for (const line of lines) rows.push({ ...common, ...line });
  }
  return rows;
}
