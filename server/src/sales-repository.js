import { query } from "./db.js";

export const SALES_YARDS = Object.freeze([
  { locationId: 1, yardCode: "3445" },
  { locationId: 28, yardCode: "2967" },
  { locationId: 15, yardCode: "12441" },
  { locationId: 26, yardCode: "150" }
]);

export function normalizeSalesYardLocationIds(values = []) {
  const allowed = new Set(SALES_YARDS.map((yard) => yard.locationId));
  const provided = Array.isArray(values) ? values : [values];
  return [...new Set(provided.map(Number).filter((value) => Number.isInteger(value) && allowed.has(value)))];
}

function printerLocationForLineYard(locationId, yardCode = "") {
  const id = Number(locationId);
  const code = String(yardCode || "").trim();
  if ([1, 14].includes(id) || /(^|[^0-9])3445([^0-9]|$)/.test(code)) return 1;
  if (id === 28 || /(^|[^0-9])2967([^0-9]|$)/.test(code)) return 28;
  if (id === 15 || /(^|[^0-9])12441([^0-9]|$)/.test(code)) return 15;
  if (id === 26 || /(^|[^0-9])150([^0-9]|$)/.test(code)) return 26;
  return null;
}

function publicCandidate(row) {
  const orderingLocationId = Number(row.ordering_location_id);
  const orderingYardCode = row.ordering_yard_code || "";
  const lineYards = (Array.isArray(row.line_yards) ? row.line_yards : [])
    .map((yard) => ({
      locationId: Number(yard.locationId),
      yardCode: String(yard.yardCode || ""),
      printerLocationId: printerLocationForLineYard(yard.locationId, yard.yardCode)
    }))
    .filter((yard) => Number.isInteger(yard.locationId) && yard.locationId > 0 && yard.printerLocationId)
    .sort((left, right) => left.printerLocationId - right.printerLocationId || left.locationId - right.locationId);
  const itemLines = (Array.isArray(row.item_lines) ? row.item_lines : []).map((line) => ({
    lineId: Number(line.lineId),
    itemName: String(line.itemName || line.sku || "Item"),
    sku: String(line.sku || ""),
    quantity: line.quantity === null || line.quantity === undefined ? null : Number(line.quantity),
    unit: String(line.unit || "")
  }));
  return {
    orderId: Number(row.order_id),
    orderRef: row.order_ref || `SO-${row.order_id}`,
    orderDate: row.order_date,
    customer: row.customer || "",
    status: row.status_text || row.status || "",
    salesOrderType: row.sales_order_type || "",
    orderingLocationId,
    orderingYardCode,
    // Keep these aliases while the Sales UI rolls forward from the original API shape.
    locationId: orderingLocationId,
    yardCode: orderingYardCode,
    lineCount: Number(row.line_count || 0),
    printHistoryCount: Number(row.print_history_count || 0),
    lineYards,
    outboundLocationIds: lineYards.map((yard) => yard.locationId),
    outboundYardCodes: lineYards.map((yard) => yard.yardCode),
    itemLines,
    items: row.items || ""
  };
}

const EFFECTIVE_ORDERING_LOCATION_SQL = `COALESCE(
  so.order_location_id,
  CASE LEFT(UPPER(COALESCE(so.tranid, '')), 3)
    WHEN 'SOB' THEN 1
    WHEN 'SOA' THEN 28
    WHEN 'SOM' THEN 26
    ELSE NULL
  END
)`;

const ORDERING_YARD_CODE_SQL = `CASE ${EFFECTIVE_ORDERING_LOCATION_SQL}
  WHEN 1 THEN '3445'
  WHEN 28 THEN '2967'
  WHEN 15 THEN '12441'
  WHEN 26 THEN '150'
  ELSE ''
END`;

const OUTBOUND_YARD_CODE_SQL = `CASE COALESCE(l.location_id, so.outbound_location_id)
  WHEN 1 THEN '3445'
  WHEN 14 THEN '3445 Special'
  WHEN 28 THEN '2967'
  WHEN 15 THEN '12441'
  WHEN 26 THEN '150'
  ELSE COALESCE(NULLIF(l.location, ''), NULLIF(so.outbound_location, ''), '')
END`;

// Only stock-bearing lines determine which yard owns the picking ticket. NetSuite
// accounting/display lines (discounts, subtotals, services, charges, and
// non-inventory items) can carry a different location and must not redirect it.
// The blank-type fallback preserves older webhook rows whose item type was not
// supplied, provided they still reference a real NetSuite item.
const INVENTORY_LINE_SQL = `(
  UPPER(TRIM(COALESCE(l.item_type, ''))) IN ('INVTPART', 'KIT', 'ASSEMBLY')
  OR UPPER(TRIM(COALESCE(l.item_type_text, ''))) IN (
    'INVENTORY ITEM',
    'INVTPART',
    'KIT/PACKAGE',
    'KIT',
    'ASSEMBLY ITEM',
    'ASSEMBLY/BILL OF MATERIALS'
  )
  OR (
    COALESCE(l.item_id, 0) > 0
    AND TRIM(COALESCE(l.item_type, '')) = ''
    AND TRIM(COALESCE(l.item_type_text, '')) = ''
  )
)`;

export async function listSalesOrderPrintCandidates({ search = "", orderingLocationIds = [], locationIds = [], limit = 100 } = {}) {
  const yards = normalizeSalesYardLocationIds(orderingLocationIds.length ? orderingLocationIds : locationIds);
  if (!yards.length) return [];
  const term = String(search || "").trim().toLowerCase();
  const max = Math.min(5000, Math.max(1, Number(limit) || 100));
  const result = await query(
    `WITH order_scope AS (
       SELECT so.netsuite_id AS order_id,
              so.tranid AS order_ref,
              so.trandate AS order_date,
              so.customer,
              so.status,
              so.status_text,
              so.sales_order_type,
              ${EFFECTIVE_ORDERING_LOCATION_SQL} AS ordering_location_id,
              ${ORDERING_YARD_CODE_SQL} AS ordering_yard_code,
              l.id AS line_pk,
              l.sku,
              l.item_name,
              l.item_description,
              l.quantity,
              l.unit,
              COALESCE(l.location_id, so.outbound_location_id) AS outbound_location_id,
              ${OUTBOUND_YARD_CODE_SQL} AS outbound_yard_code
         FROM sales_orders so
         JOIN sales_order_lines l
           ON l.sales_order_id = so.netsuite_id
          AND l.netsuite_active = true
          AND ${INVENTORY_LINE_SQL}
        WHERE so.netsuite_active = true
          AND lower(trim(COALESCE(so.sales_order_type, ''))) = 'delivery'
     )
     SELECT scope.order_id,
            scope.order_ref,
            scope.order_date,
            scope.customer,
            scope.status,
            scope.status_text,
            scope.sales_order_type,
            scope.ordering_location_id,
            scope.ordering_yard_code,
            COUNT(DISTINCT scope.line_pk) AS line_count,
            (
              SELECT COUNT(*)::integer
                FROM scm_print_jobs history
               WHERE history.source_order_id = scope.order_id
                 AND history.document_type = 'sales_order_picking_ticket'
            ) AS print_history_count,
            COALESCE(
              jsonb_agg(DISTINCT jsonb_build_object(
                'locationId', scope.outbound_location_id,
                'yardCode', scope.outbound_yard_code
              )) FILTER (WHERE scope.outbound_location_id IS NOT NULL),
              '[]'::jsonb
            ) AS line_yards,
            COALESCE(
              jsonb_agg(jsonb_build_object(
                'lineId', scope.line_pk,
                'sku', scope.sku,
                'itemName', scope.item_name,
                'quantity', scope.quantity,
                'unit', scope.unit
              ) ORDER BY scope.line_pk),
              '[]'::jsonb
            ) AS item_lines,
            string_agg(DISTINCT trim(concat_ws(' ', NULLIF(scope.sku, ''), NULLIF(scope.item_name, ''))), ', ')
              FILTER (WHERE COALESCE(scope.sku, scope.item_name, '') <> '') AS items
      FROM order_scope scope
      WHERE scope.ordering_location_id = ANY($1::bigint[])
        AND ($2 <> '' OR NOT EXISTS (
          SELECT 1
            FROM scm_print_jobs printed
           WHERE printed.source_order_id = scope.order_id
             AND printed.document_type = 'sales_order_picking_ticket'
             AND (LOWER(COALESCE(printed.status, '')) = 'printed' OR printed.printed_at IS NOT NULL)
        ))
        AND ($2 = '' OR lower(concat_ws(
          ' ',
          scope.order_ref,
          scope.customer,
          scope.status_text,
          scope.sku,
          scope.item_name,
          scope.item_description,
          scope.ordering_yard_code,
          scope.outbound_yard_code
        )) LIKE '%' || $2 || '%')
      GROUP BY scope.order_id, scope.order_ref, scope.order_date, scope.customer, scope.status,
               scope.status_text, scope.sales_order_type, scope.ordering_location_id, scope.ordering_yard_code
      ORDER BY scope.order_date DESC NULLS LAST, scope.order_ref DESC
      LIMIT $3`,
    [yards, term, max]
  );
  return result.rows.map(publicCandidate);
}

export async function getSalesOrderPrintCandidate({ orderId, allowedOrderingLocationIds = [], allowedLocationIds = [] } = {}) {
  const id = Number(orderId);
  const allowed = normalizeSalesYardLocationIds(
    allowedOrderingLocationIds.length ? allowedOrderingLocationIds : allowedLocationIds
  );
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error("Select a valid Sales Order."), { status: 400 });
  }
  if (!allowed.length) {
    throw Object.assign(new Error("No Sales Order locations are assigned to this account."), { status: 403 });
  }
  const result = await query(
    `WITH order_scope AS (
       SELECT so.netsuite_id AS order_id,
              so.tranid AS order_ref,
              so.trandate AS order_date,
              so.customer,
              so.status,
              so.status_text,
              so.sales_order_type,
              ${EFFECTIVE_ORDERING_LOCATION_SQL} AS ordering_location_id,
              ${ORDERING_YARD_CODE_SQL} AS ordering_yard_code,
              l.id AS line_pk,
              l.sku,
              l.item_name,
              l.quantity,
              l.unit,
              COALESCE(l.location_id, so.outbound_location_id) AS outbound_location_id,
              ${OUTBOUND_YARD_CODE_SQL} AS outbound_yard_code
         FROM sales_orders so
         JOIN sales_order_lines l
           ON l.sales_order_id = so.netsuite_id
          AND l.netsuite_active = true
          AND ${INVENTORY_LINE_SQL}
        WHERE so.netsuite_id = $1
          AND so.netsuite_active = true
          AND lower(trim(COALESCE(so.sales_order_type, ''))) = 'delivery'
     )
     SELECT scope.order_id,
            scope.order_ref,
            scope.order_date,
            scope.customer,
            scope.status,
            scope.status_text,
            scope.sales_order_type,
            scope.ordering_location_id,
            scope.ordering_yard_code,
            COUNT(DISTINCT scope.line_pk) AS line_count,
            (
              SELECT COUNT(*)::integer
                FROM scm_print_jobs history
               WHERE history.source_order_id = scope.order_id
                 AND history.document_type = 'sales_order_picking_ticket'
            ) AS print_history_count,
            COALESCE(
              jsonb_agg(DISTINCT jsonb_build_object(
                'locationId', scope.outbound_location_id,
                'yardCode', scope.outbound_yard_code
              )) FILTER (WHERE scope.outbound_location_id IS NOT NULL),
              '[]'::jsonb
            ) AS line_yards,
            COALESCE(
              jsonb_agg(jsonb_build_object(
                'lineId', scope.line_pk,
                'sku', scope.sku,
                'itemName', scope.item_name,
                'quantity', scope.quantity,
                'unit', scope.unit
              ) ORDER BY scope.line_pk),
              '[]'::jsonb
            ) AS item_lines,
            string_agg(DISTINCT trim(concat_ws(' ', NULLIF(scope.sku, ''), NULLIF(scope.item_name, ''))), ', ')
              FILTER (WHERE COALESCE(scope.sku, scope.item_name, '') <> '') AS items
       FROM order_scope scope
      WHERE scope.ordering_location_id = ANY($2::bigint[])
      GROUP BY scope.order_id, scope.order_ref, scope.order_date, scope.customer, scope.status,
               scope.status_text, scope.sales_order_type, scope.ordering_location_id, scope.ordering_yard_code`,
    [id, allowed]
  );
  if (!result.rowCount || Number(result.rows[0].line_count || 0) <= 0) {
    throw Object.assign(new Error("This Sales Order was not found in your assigned ordering location."), { status: 404 });
  }
  return publicCandidate(result.rows[0]);
}

function publicPrintHistory(row) {
  const lineLocationId = Number(row.line_location_id);
  const printerNames = (Array.isArray(row.printer_names) ? row.printer_names : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return {
    jobId: Number(row.id),
    orderId: Number(row.source_order_id),
    orderRef: row.source_order_ref || "",
    lineLocationId,
    lineYardCode: row.line_yard_code || "",
    printerLocationId: Number(row.location_id),
    printerYardCode: row.printer_yard_code || "",
    printerName: printerNames.join(" + ") || row.printer_name || "",
    printerNames,
    requestedBy: row.requested_by || row.queued_by_operator_id || "System",
    requestedAt: row.queued_at,
    status: row.status || "",
    attempts: Number(row.attempts || 0),
    printedAt: row.printed_at,
    lastError: row.last_error || "",
    documentName: row.document_name || "",
    documentSha256: row.document_sha256 || ""
  };
}

const SALES_PRINT_HISTORY_SELECT = `
  SELECT job.*,
         printer.yard_code AS printer_yard_code,
         printer.printer_name,
         COALESCE(NULLIF(operator.display_name, ''), NULLIF(operator.username, ''), job.queued_by_operator_id, 'System') AS requested_by,
         CASE job.line_location_id
           WHEN 1 THEN '3445'
           WHEN 14 THEN '3445 Special'
           WHEN 28 THEN '2967'
           WHEN 15 THEN '12441'
           WHEN 26 THEN '150'
           ELSE COALESCE(job.line_location_id::text, '')
         END AS line_yard_code
    FROM scm_print_jobs job
    JOIN scm_yard_printers printer ON printer.location_id = job.location_id
    LEFT JOIN operators operator ON operator.id = job.queued_by_operator_id
`;

export async function listSalesOrderPrintHistory(orderId) {
  const id = Number(orderId);
  if (!Number.isInteger(id) || id <= 0) {
    throw Object.assign(new Error("Select a valid Sales Order."), { status: 400 });
  }
  const result = await query(
    `${SALES_PRINT_HISTORY_SELECT}
      WHERE job.source_order_id = $1
        AND job.document_type = 'sales_order_picking_ticket'
      ORDER BY job.queued_at DESC, job.id DESC`,
    [id]
  );
  return result.rows.map(publicPrintHistory);
}

export async function getSalesOrderPrintSnapshot({ orderId, jobId } = {}) {
  const id = Number(orderId);
  const printJobId = Number(jobId);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(printJobId) || printJobId <= 0) {
    throw Object.assign(new Error("Select a valid picking-ticket snapshot."), { status: 400 });
  }
  const result = await query(
    `${SALES_PRINT_HISTORY_SELECT}
      WHERE job.id = $1
        AND job.source_order_id = $2
        AND job.document_type = 'sales_order_picking_ticket'
      LIMIT 1`,
    [printJobId, id]
  );
  if (!result.rowCount) {
    throw Object.assign(new Error("The picking-ticket snapshot was not found for this Sales Order."), { status: 404 });
  }
  return {
    ...publicPrintHistory(result.rows[0]),
    documentPath: result.rows[0].document_path
  };
}
