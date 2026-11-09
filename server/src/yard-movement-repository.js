import { hasActiveTransaction, query, withTransaction } from "./db.js";
import { enrichYardMovementEvidence } from "./movement-record-evidence.js";
import { salesStoreLocationIdSql } from "./sales-store.js";
import {
  getActiveReloadCycleForOrder,
  getLatestSalesOrderReattemptForOrder,
  listSalesOrderLoadAttempts
} from "./sales-order-reload-repository.js";
import { RENTAL_YARD } from "./sor-rental-policy.js";

const VALID_DIRECTIONS = new Set(["inbound", "outbound"]);
const VALID_ORDER_TYPES = new Set([
  "sales_order",
  "sor_order",
  "transfer_order",
  "purchase_order",
  "co_order",
  "vrma_order",
  "custom_order",
  "sor_return"
]);
// SOR rental deliveries are sales orders and keep sales-order load history.
const SALES_ORDER_MOVEMENT_TYPES = new Set(["sales_order", "sor_order"]);
// Matches isSorDeliveryRef; collections are the system-managed `<ref>-Return`.
const SOR_DELIVERY_REF_SQL = "'^SOR[0-9]+(-S[0-9]+)?$'";
const SOR_TRANSPORT_REF_SQL = "'^SOR[0-9]+(-S[0-9]+)?(-Return)?$'";
const SOR_RETURN_KIND_SQL = "'sor_rental_return'";
// Match priority of a Driver reference to a dispatch SO split (e.g. SOA10724-S1)
// that was never materialized as its own sales order: it belongs to the parent.
const SPLIT_PARENT_MATCH_PRIORITY = 15;
const UNMATERIALIZED_SO_SPLIT_SQL = (splitRefExpression) => `NOT EXISTS (
  SELECT 1 FROM sales_orders own
   WHERE LOWER(BTRIM(own.tranid)) = LOWER(BTRIM(${splitRefExpression}))
)`;

function salesOrderTypeSql(tranidExpression) {
  return `CASE
    WHEN ${isSorDeliverySql(tranidExpression)} THEN 'sor_order'::text
    ELSE 'sales_order'::text
  END`;
}

function isSorDeliverySql(tranidExpression) {
  return `BTRIM(COALESCE(${tranidExpression}, '')) ~* ${SOR_DELIVERY_REF_SQL}`;
}

// SOR rentals ship from the rental yard; their NetSuite location ("Rental") is not a yard.
function sorUsesRentalYardSql(alias = "o") {
  return `(${isSorDeliverySql(`${alias}.tranid`)} AND NOT EXISTS (
    SELECT 1 FROM mbt_yards yard WHERE yard.dispatch_location_id = ${alias}.outbound_location_id
  ))`;
}

function salesOrderYardLocationIdSql(alias = "o") {
  return `CASE WHEN ${sorUsesRentalYardSql(alias)} THEN ${Number(RENTAL_YARD.locationId)}::bigint
    ELSE ${alias}.outbound_location_id END`;
}

function salesOrderYardLocationSql(alias = "o") {
  return `CASE WHEN ${sorUsesRentalYardSql(alias)} THEN '${RENTAL_YARD.code}'::text
    ELSE ${alias}.outbound_location END`;
}

function salesModuleLocationIdSql(alias = "movement") {
  // SOR rentals and their collections belong to the rental yard's Sales store.
  return `CASE
    WHEN ${alias}.order_type = 'sales_order' THEN ${salesStoreLocationIdSql(`${alias}.tranid`)}
    WHEN ${alias}.order_type IN ('sor_order', 'sor_return') THEN ${Number(RENTAL_YARD.locationId)}::bigint
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

/** @param {string} valueExpression */
function customOrderYardLocationIdSql(valueExpression) {
  /** @type {(expression: string) => string} */
  const normalizedAddress = (expression) =>
    `LOWER(BTRIM(REGEXP_REPLACE(COALESCE(${expression}, ''), '[[:space:]]+', ' ', 'g')))`;
  // Match the configured full address, never just an offsite street number.
  // Inactive yards still identify history; ambiguous addresses grant no yard.
  return `COALESCE(${exactYardCodeLocationIdSql(valueExpression)}, (
    SELECT CASE WHEN COUNT(DISTINCT yard.dispatch_location_id) = 1
      THEN MIN(yard.dispatch_location_id)::bigint ELSE NULL::bigint END
      FROM mbt_yards yard
     WHERE NULLIF(${normalizedAddress("yard.address_line_1")}, '') =
       ${normalizedAddress(valueExpression)}
  ))`;
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
           ${salesOrderTypeSql("o.tranid")} AS order_type,
           o.netsuite_id AS order_id,
           o.tranid,
           o.customer AS party,
           ${salesOrderYardLocationIdSql("o")} AS yard_location_id,
           ${salesOrderYardLocationSql("o")} AS yard_location,
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

function selectedOrderReferencesSql() {
  return [
    ['sales_order', 'sales_orders', 'netsuite_id', 'tranid'],
    ['sor_order', 'sales_orders', 'netsuite_id', 'tranid'],
    ['purchase_order', 'purchase_orders', 'netsuite_id', 'tranid'],
    ['purchase_order', 'purchase_orders', 'netsuite_id', 'dispatch_ref'],
    ['transfer_order', 'transfer_orders', 'netsuite_id', 'tranid'],
    ['co_order', 'local_co_orders', 'id', 'co_ref'],
    ['vrma_order', 'scm_vrma_orders', 'id', 'vrma_ref'],
    ['custom_order', 'dispatch_custom_orders', 'id', 'ref_number'],
    ['sor_return', 'dispatch_custom_orders', 'id', 'ref_number']
  ].map(([type, table, id, reference]) => `SELECT LOWER(BTRIM(${reference})) FROM ${table}
    WHERE $2::text = '${type}' AND ${id} = $3::bigint`).concat(`SELECT LOWER(BTRIM(split.split_ref))
      FROM sales_orders parent
      JOIN dispatch_global_order_splits split
        ON split.order_type = 'SO'
       AND split.definition_kind = 'split'
       AND LOWER(BTRIM(split.parent_order_ref)) = LOWER(BTRIM(parent.tranid))
     WHERE $2::text IN ('sales_order', 'sor_order')
       AND parent.netsuite_id = $3::bigint
       AND ${UNMATERIALIZED_SO_SPLIT_SQL("split.split_ref")}`).join('\nUNION ALL\n');
}

function driverOrderCtes({ fromParam = null, toParam = null, selectedOrder = false } = {}) {
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
             r.status,
             r.started_at,
             r.completed_at,
             r.created_at,
             ref.order_ref,
             ref.ref_index,
             ${driverPhotoCount}::int AS driver_photo_count
        FROM driver_job_records r
        LEFT JOIN dispatch_drivers d
          ON LOWER(BTRIM(d.login)) = LOWER(BTRIM(r.driver_login))
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(COALESCE(r.order_refs, '[]'::jsonb)) = 'array'
              AND jsonb_array_length(COALESCE(r.order_refs, '[]'::jsonb)) > 0
              THEN COALESCE(r.order_refs, '[]'::jsonb)
            -- BIN transport jobs name their SOR source only on the cargo legs.
            WHEN r.job_details->'mbt'->>'actionCode' IN ('cargo_pickup_1', 'cargo_dropoff_1')
              AND BTRIM(COALESCE(r.job_details->'mbt'->>'sourceRef', '')) ~* ${SOR_TRANSPORT_REF_SQL}
              THEN jsonb_build_array(BTRIM(r.job_details->'mbt'->>'sourceRef'))
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS ref(order_ref, ref_index)
       WHERE r.stop_type IN ('pickup', 'dropoff')
         AND r.status IN ('in_progress', 'complete')
         AND BTRIM(ref.order_ref) <> ''
         ${driverWindow}
         ${selectedOrder ? `AND LOWER(BTRIM(ref.order_ref)) IN (${selectedOrderReferencesSql()})` : ''}
    )`,
    `driver_order_matches AS (
      SELECT refs.*,
             'outbound'::text AS direction,
             ${salesOrderTypeSql("o.tranid")} AS order_type,
             o.netsuite_id AS order_id,
             o.tranid,
             o.customer AS party,
             ${salesOrderYardLocationIdSql("o")} AS yard_location_id,
             ${salesOrderYardLocationSql("o")} AS yard_location,
             NULL::text AS source_location,
             o.outbound_location AS destination_location,
             10 AS match_priority
        FROM driver_record_refs refs
        JOIN sales_orders o
          ON LOWER(BTRIM(o.tranid)) = LOWER(BTRIM(refs.order_ref))
      UNION ALL
      -- A Driver delivering an SO split that has no sales order of its own
      -- (the yard loaded the parent) is shown on the parent order's record.
      SELECT refs.*,
             'outbound'::text,
             ${salesOrderTypeSql("o.tranid")},
             o.netsuite_id,
             o.tranid,
             o.customer,
             ${salesOrderYardLocationIdSql("o")},
             ${salesOrderYardLocationSql("o")},
             NULL::text,
             o.outbound_location,
             ${SPLIT_PARENT_MATCH_PRIORITY}
        FROM driver_record_refs refs
        JOIN dispatch_global_order_splits split
          ON split.order_type = 'SO'
         AND split.definition_kind = 'split'
         AND LOWER(BTRIM(split.split_ref)) = LOWER(BTRIM(refs.order_ref))
        JOIN sales_orders o
          ON LOWER(BTRIM(o.tranid)) = LOWER(BTRIM(split.parent_order_ref))
       WHERE ${UNMATERIALIZED_SO_SPLIT_SQL("refs.order_ref")}
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
            LOWER(BTRIM(o.tranid)),
            LOWER(BTRIM(o.dispatch_ref))
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
             ${customOrderYardLocationIdSql("o.pickup_location")},
             o.pickup_location, o.pickup_location, o.dropoff_location,
             60
        FROM driver_record_refs refs
        JOIN dispatch_custom_orders o
          ON LOWER(BTRIM(o.ref_number)) = LOWER(BTRIM(refs.order_ref))
       WHERE o.order_kind <> ${SOR_RETURN_KIND_SQL}
      UNION ALL
      -- An SOR collection brings rental equipment back into its drop-off yard.
      SELECT refs.*,
             'inbound', 'sor_return', o.id, o.ref_number,
             COALESCE(NULLIF(BTRIM(o.sor_customer), ''), o.parent_order_ref),
             ${customOrderYardLocationIdSql("o.dropoff_location")},
             o.dropoff_location, o.pickup_location, o.dropoff_location,
             60
        FROM driver_record_refs refs
        JOIN dispatch_custom_orders o
          ON LOWER(BTRIM(o.ref_number)) = LOWER(BTRIM(refs.order_ref))
       WHERE o.order_kind = ${SOR_RETURN_KIND_SQL}
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
           NULL::text AS stop_type,
           NULL::text AS split_ref
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
           event.stop_type,
           CASE WHEN event.match_priority = ${SPLIT_PARENT_MATCH_PRIORITY}
             THEN BTRIM(event.order_ref) END
      FROM driver_order_events event
  `;
}

function jsonBigintSql(expression) {
  return `CASE WHEN BTRIM(COALESCE(${expression}, '')) ~ '^[0-9]{1,18}$'
    THEN BTRIM(${expression})::bigint END`;
}

function jsonNumericSql(expression) {
  return `CASE WHEN BTRIM(COALESCE(${expression}, '')) ~ '^-?[0-9]{1,15}([.][0-9]{1,6})?$'
    THEN BTRIM(${expression})::numeric END`;
}

function movementLinesSql() {
  const poReceived = receivedSalesSql("l");
  const toReceived = receivedSalesSql("l");
  const coReceived = receivedSalesSql("l", { hasSalesColumn: false });
  const sorLine = (key) => `snapshot.line->>'${key}'`;
  const processedLines = `
    SELECT 'outbound'::text AS direction, ${salesOrderTypeSql("o.tranid")} AS order_type,
           l.sales_order_id AS order_id, l.id, l.line_id, l.item_id, l.item_name, l.sku,
           l.item_description, COALESCE(l.loaded_qty, 0) AS processed_qty,
           COALESCE(NULLIF(l.loaded_uom, ''), l.unit) AS processed_uom,
           l.unit, l.location, l.to_plt, l.to_lyr, l.to_sec, l.to_pcs,
           COALESCE(l.fulfilled_pallet_qty, 0) AS processed_pallet_qty,
           COALESCE(l.fulfilled_layer_qty, 0) AS processed_layer_qty,
           COALESCE(l.fulfilled_section_qty, 0) AS processed_section_qty,
           COALESCE(l.fulfilled_piece_qty, 0) AS processed_piece_qty
      FROM sales_order_lines l
      LEFT JOIN sales_orders o ON o.netsuite_id = l.sales_order_id
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
     WHERE o.order_kind <> ${SOR_RETURN_KIND_SQL}
    UNION ALL
    -- The collection's line snapshot is the rental equipment being returned.
    SELECT 'inbound', 'sor_return', o.id, snapshot.ordinality,
           COALESCE(${jsonBigintSql(sorLine("lineId"))}, snapshot.ordinality),
           ${jsonBigintSql(sorLine("itemId"))},
           COALESCE(NULLIF(${sorLine("itemName")}, ''), ${sorLine("sku")}),
           COALESCE(NULLIF(${sorLine("sku")}, ''), ${sorLine("itemName")}),
           ${sorLine("description")},
           COALESCE(${jsonNumericSql(sorLine("quantity"))}, ${jsonNumericSql(sorLine("salesQty"))}, 0),
           NULLIF(${sorLine("unit")}, ''), NULLIF(${sorLine("unit")}, ''), NULL::text,
           source_line.to_plt, source_line.to_lyr, source_line.to_sec, source_line.to_pcs,
           COALESCE(${jsonNumericSql(sorLine("pallets"))}, 0),
           COALESCE(${jsonNumericSql(sorLine("layers"))}, 0),
           COALESCE(${jsonNumericSql(sorLine("sections"))}, 0),
           COALESCE(${jsonNumericSql(sorLine("pieces"))}, 0)
      FROM dispatch_custom_orders o
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(o.line_snapshot) = 'array' THEN o.line_snapshot ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS snapshot(line, ordinality)
      LEFT JOIN sales_order_lines source_line
        ON source_line.sales_order_id = o.parent_sales_order_id
       AND source_line.id = ${jsonBigintSql(sorLine("lineRowId"))}
     WHERE o.order_kind = ${SOR_RETURN_KIND_SQL}
  `;
  // Drivers take SOR rentals straight out, so nothing is yard-loaded; the order's
  // lines then describe the movement (and make it item-searchable) as ordered quantities.
  return `
    SELECT processed.*, 'processed'::text AS quantity_basis
      FROM (${processedLines}) processed
    UNION ALL
    SELECT 'outbound', 'sor_order', l.sales_order_id, l.id, l.line_id, l.item_id, l.item_name, l.sku,
           l.item_description, COALESCE(l.quantity, 0), l.unit, l.unit, l.location,
           l.to_plt, l.to_lyr, l.to_sec, l.to_pcs,
           COALESCE(l.pallet_qty, 0), COALESCE(l.layer_qty, 0),
           COALESCE(l.section_qty, 0), COALESCE(l.piece_qty, 0),
           'ordered'::text
      FROM sales_order_lines l
      JOIN sales_orders o ON o.netsuite_id = l.sales_order_id
     WHERE ${isSorDeliverySql("o.tranid")}
       AND COALESCE(l.netsuite_active, true)
       AND COALESCE(l.quantity, 0) > 0
       AND NOT EXISTS (
         SELECT 1 FROM sales_order_lines loaded
          WHERE loaded.sales_order_id = l.sales_order_id
            AND COALESCE(loaded.loaded_qty, 0) > 0
       )
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
    SELECT 'outbound'::text AS direction,
           CASE WHEN r.order_family = 'sales_order' THEN ${salesOrderTypeSql("so.tranid")}
             ELSE r.order_family END AS order_type,
           r.order_id, r.id, r.created_at, photo.photo_data_url, r.response, 'yard'::text AS source
      FROM operator_load_records r
      LEFT JOIN sales_orders so ON r.order_family = 'sales_order' AND so.netsuite_id = r.order_id
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
  toParam = null,
  selectedOrder = false
} = {}) {
  const records = movementRecordsSql({ fromParam, toParam });
  const ctes = [
    `movement_records AS (${selectedOrder ? `SELECT selected.* FROM (${records}) selected
      WHERE selected.direction = $1 AND selected.order_type = $2 AND selected.order_id = $3::bigint` : records})`,
    ...driverOrderCtes({ fromParam, toParam, selectedOrder })
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
  // One type per tab; the SO tab asks for "sales_order,sor_order" so SOR rental
  // deliveries are listed with the other sales orders.
  const normalizedTypes = [...new Set(String(orderType || "").split(",")
    .map((type) => type.trim().toLowerCase())
    .filter((type) => VALID_ORDER_TYPES.has(type)))];
  if (normalizedTypes.length === 1) {
    params.push(normalizedTypes[0]);
    clauses.push(`movement.order_type = $${params.length}`);
  } else if (normalizedTypes.length > 1) {
    params.push(normalizedTypes);
    clauses.push(`movement.order_type = ANY($${params.length}::text[])`);
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
    const term = `$${params.length}`;
    // Split and group references are written with and without the hyphen
    // (SOA10724-S1 / SOA10724S1 in GOA-10724S1-10878S1).
    const compact = (expression) => `REPLACE(${expression}, '-', '')`;
    const groupMemberRefs = `SELECT LOWER(BTRIM(member.order_ref))
          FROM dispatch_plan_order_assignments member
         WHERE NULLIF(BTRIM(member.planned_order_ref), '') IS NOT NULL
           AND ${compact("member.planned_order_ref")} ILIKE ${compact(term)}`;
    clauses.push(`(
      movement.tranid ILIKE ${term}
      OR ${compact("movement.tranid")} ILIKE ${compact(term)}
      OR ${compact("COALESCE(movement.split_ref, '')")} ILIKE ${compact(term)}
      OR LOWER(BTRIM(movement.tranid)) IN (${groupMemberRefs})
      OR LOWER(BTRIM(COALESCE(movement.split_ref, ''))) IN (${groupMemberRefs})
      OR COALESCE(movement.party, '') ILIKE $${params.length}
      OR movement.order_id::text ILIKE $${params.length}
      OR COALESCE(movement.source_location, '') ILIKE $${params.length}
      OR COALESCE(movement.destination_location, '') ILIKE $${params.length}
      OR (movement.order_type = 'purchase_order' AND movement.order_id IN (
        SELECT po.netsuite_id
          FROM purchase_orders po
          LEFT JOIN dispatch_scm_po_splits split ON split.split_po_id = po.netsuite_id
          LEFT JOIN purchase_orders parent ON parent.netsuite_id = split.source_po_id
         WHERE COALESCE(po.tranid, '') ILIKE $${params.length}
            OR COALESCE(po.dispatch_ref, '') ILIKE $${params.length}
            OR COALESCE(split.source_po_ref, '') ILIKE $${params.length}
            OR split.source_po_id::text ILIKE $${params.length}
            OR COALESCE(parent.tranid, '') ILIKE $${params.length}
            OR COALESCE(parent.dispatch_ref, '') ILIKE $${params.length}
            OR EXISTS (
              SELECT 1 FROM dispatch_global_order_splits registered
               WHERE registered.order_type = 'PO'
                 AND registered.definition_kind = 'split'
                 AND LOWER(BTRIM(registered.split_ref)) IN (
                   LOWER(BTRIM(COALESCE(po.tranid, ''))),
                   LOWER(BTRIM(COALESCE(po.dispatch_ref, '')))
                 )
                 AND registered.parent_order_ref ILIKE $${params.length}
            )
      ))
    )`);
  }
  // Item search is a condition on movement_lines, applied by listYardMovements as a set
  // intersection (see there), not a per-movement EXISTS.
  let itemWhere = null;
  const itemTerm = String(itemSearch || "").trim();
  if (itemTerm) {
    params.push(`%${itemTerm}%`);
    itemWhere = `(
           COALESCE(line.item_name, '') ILIKE $${params.length}
           OR COALESCE(line.sku, '') ILIKE $${params.length}
           OR COALESCE(line.item_description, '') ILIKE $${params.length}
           OR line.item_id::text ILIKE $${params.length}
         )`;
  }
  const driverLogin = String(driver || "").trim();
  if (driverLogin && driverLogin.toLowerCase() !== "all") {
    params.push(driverLogin);
    clauses.push(`LOWER(BTRIM(COALESCE(movement.driver_login, ''))) = LOWER(BTRIM($${params.length}))`);
  }
  return { params, where: clauses.join("\n       AND "), itemWhere, fromDate, toDate };
}

function movementSummaryColumns(alias = "movement") {
  return `
    ${alias}.direction,
    ${alias}.order_type,
    ${alias}.order_id,
    ARRAY_AGG(DISTINCT ${alias}.event_key) AS record_keys,
    COALESCE(
      ARRAY_AGG(DISTINCT ${alias}.split_ref ORDER BY ${alias}.split_ref)
        FILTER (WHERE ${alias}.split_ref IS NOT NULL),
      ARRAY[]::text[]
    ) AS split_refs,
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

const MOVEMENT_LIST_STATEMENT_TIMEOUT = "30s";

// A runaway list query must not hold database CPU for minutes (2026-11-05: three
// item searches ran 8 minutes and slowed every page); fail it with a clear message.
async function runMovementListQuery(sql, params) {
  if (hasActiveTransaction()) return query(sql, params);
  try {
    return await withTransaction(async () => {
      await query(`SET LOCAL statement_timeout = '${MOVEMENT_LIST_STATEMENT_TIMEOUT}'`);
      return query(sql, params);
    });
  } catch (error) {
    if (error?.code === "57014") {
      throw Object.assign(new Error("The In/Outbound search took too long. Narrow the dates or the search, then try again."), {
        status: 400,
        code: "MOVEMENT_QUERY_TIMEOUT"
      });
    }
    throw error;
  }
}

export async function listYardMovements(filters = {}) {
  const { params, where, itemWhere } = movementFilterParams(filters);
  // record_events has no statistics, so the planner expects one row after any
  // filter. A correlated EXISTS over movement_lines was therefore re-run (whole
  // line union, parallel workers) for every movement; an all-dates item search
  // took minutes. Intersecting two order-key sets computes each side once.
  const result = await runMovementListQuery(
    `${movementCtes({ fromParam: 1, toParam: 2, lines: Boolean(itemWhere) })},
     matching_orders AS (
       SELECT ${itemWhere ? "" : "DISTINCT "}movement.direction, movement.order_type, movement.order_id
         FROM record_events movement
        WHERE ${where}
       ${itemWhere ? `INTERSECT
       SELECT line.direction, line.order_type, line.order_id
         FROM movement_lines line
        WHERE ${itemWhere}` : ""}
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
  return enrichYardMovementEvidence(result.rows);
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
  const identity = String(orderId || '');
  if (!/^-?(0|[1-9]\d*)$/.test(identity) || identity === '-0'
    || BigInt(identity) < -9223372036854775808n || BigInt(identity) > 9223372036854775807n) return null;
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
    `${movementCtes({ lines: false, fromParam: 4, toParam: 5, selectedOrder: true })},
     matching_order AS (
       SELECT DISTINCT movement.direction, movement.order_type, movement.order_id
         FROM record_events movement
        WHERE movement.direction = $1
          AND movement.order_type = $2
          AND movement.order_id = $3::bigint
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
          AND order_id = $3::bigint
        ORDER BY line_id NULLS LAST, id`,
    identityParams
  );
  const readPhotos = () => query(
    `WITH movement_photos AS (${movementPhotosSql()})
       SELECT id, created_at, photo_data_url, response, source
         FROM movement_photos
        WHERE direction = $1
          AND order_type = $2
          AND order_id = $3::bigint
          AND created_at >= $4::date
          AND created_at < ($5::date + interval '1 day')
        ORDER BY created_at DESC, id DESC`,
    detailParams
  );
  const readDriverRecords = () => query(
    `${movementCtes({ lines: false, events: false, fromParam: 4, toParam: 5, selectedOrder: true })}
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
              record.photo_data_urls,
              record.job_details,
              CASE
                WHEN event.status = 'complete' AND event.stop_type = 'dropoff'
                  THEN event.completed_at
                ELSE NULL
              END AS delivery_at,
              'driver'::text AS source
         FROM driver_order_events event
         JOIN driver_job_records record ON record.id = event.driver_record_id
        WHERE event.direction = $1
          AND event.order_type = $2
          AND event.order_id = $3::bigint
        ORDER BY COALESCE(event.completed_at, event.started_at, event.created_at) DESC,
                 event.driver_record_id DESC`,
    detailParams
  );
  const readDriverPhotos = () => query(
    `${movementCtes({ lines: false, events: false, fromParam: 4, toParam: 5, selectedOrder: true })}
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
         JOIN driver_job_records record ON record.id = event.driver_record_id
         CROSS JOIN LATERAL jsonb_array_elements_text(
           CASE
             WHEN jsonb_typeof(COALESCE(record.photo_data_urls, '[]'::jsonb)) = 'array'
               THEN COALESCE(record.photo_data_urls, '[]'::jsonb)
             ELSE '[]'::jsonb
           END
         ) WITH ORDINALITY AS photo(photo_data_url, photo_index)
        WHERE event.direction = $1
          AND event.order_type = $2
          AND event.order_id = $3::bigint
        ORDER BY COALESCE(event.completed_at, event.started_at, event.created_at) DESC,
                 event.driver_record_id DESC,
                 photo.photo_index`,
    detailParams
  );
  const isSalesOrderLoad = normalizedDirection === "outbound"
    && SALES_ORDER_MOVEMENT_TYPES.has(normalizedType)
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
  const [order] = await enrichYardMovementEvidence(orderResult.rows);
  return {
    order,
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
    if (order.direction === "outbound" && SALES_ORDER_MOVEMENT_TYPES.has(order.order_type) && loadAttempts.length) {
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
    for (const line of lines) {
      rows.push({
        ...common,
        ...line,
        ...(line.quantity_basis === "ordered" ? { attempt_quantity_basis: "ordered" } : {})
      });
    }
  }
  return rows;
}
