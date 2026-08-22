import { query } from "./db.js";

const ORDER_TABLES = Object.freeze({
  sales_order: "sales_orders",
  purchase_order: "purchase_orders",
  transfer_order: "transfer_orders"
});

const PENDING_APPROVAL_SQL = `(
  upper(COALESCE(status, '')) = 'A'
  OR COALESCE(status_text, '') ~* '^[[:space:]]*((sales|purchase|transfer)[[:space:]]+order[[:space:]]*:[[:space:]]*)?pending([[:space:]]+supervisor)?[[:space:]]+approval[[:space:]]*$'
)`;

function orderTable(orderType) {
  const table = ORDER_TABLES[String(orderType || "")];
  if (!table) {throw new Error("A valid Pending Approval order type is required.");}
  return table;
}

function numericNetSuiteId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("A valid numeric NetSuite order ID is required.");
  }
  return id;
}

function statusValue(value, label, maximumLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maximumLength || /[\0\r\n]/.test(text)) {
    throw new Error(`A valid NetSuite ${label} is required.`);
  }
  return text;
}

async function listOrderFamily(table) {
  const result = await query(
    `SELECT netsuite_id::text AS "netsuiteId",
            tranid,
            status,
            status_text AS "statusText"
       FROM ${table}
      WHERE netsuite_id > 0
        AND ${PENDING_APPROVAL_SQL}
      ORDER BY netsuite_id`
  );
  return result.rows;
}

export async function listPendingApprovalCandidates() {
  const salesOrders = await listOrderFamily(ORDER_TABLES.sales_order);
  const purchaseOrders = await listOrderFamily(ORDER_TABLES.purchase_order);
  const transferOrders = await listOrderFamily(ORDER_TABLES.transfer_order);
  return {
    sales_order: salesOrders,
    purchase_order: purchaseOrders,
    transfer_order: transferOrders
  };
}

export async function applyPendingApprovalStatusIfStillPending({
  orderType,
  netsuiteId,
  status,
  statusText,
  netsuiteActive
} = {}) {
  const table = orderTable(orderType);
  const id = numericNetSuiteId(netsuiteId);
  const nextStatus = statusValue(status, "status code", 64);
  const nextStatusText = statusValue(statusText, "status text", 512);
  if (typeof netsuiteActive !== "boolean") {
    throw new Error("A NetSuite active classification is required.");
  }
  const result = await query(
    `UPDATE ${table}
        SET status = $2,
            status_text = $3,
            netsuite_active = $4,
            netsuite_missing_at = NULL,
            status_updated_at = now(),
            synced_at = now()
      WHERE netsuite_id = $1
        AND ${PENDING_APPROVAL_SQL}
    RETURNING netsuite_id::text AS "netsuiteId",
              tranid,
              status,
              status_text AS "statusText",
              netsuite_active AS "netsuiteActive",
              status_updated_at AS "statusUpdatedAt"`,
    [id, nextStatus, nextStatusText, netsuiteActive]
  );
  return result.rows[0] || null;
}
