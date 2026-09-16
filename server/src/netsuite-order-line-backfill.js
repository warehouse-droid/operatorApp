import { query, withTransaction } from "./db.js";
import { readNetSuiteOrderLine } from "./netsuite-order-line.js";

const TABLES = Object.freeze({
  SO: ["sales_order_lines", "sales_order_id"],
  PO: ["purchase_order_lines", "purchase_order_id"],
  TO: ["transfer_order_lines", "transfer_order_id"]
});

function tableFor(kind) {
  const table = TABLES[kind];
  if (!table) {throw new Error("An SO, PO, or TO source is required.");}
  return table;
}

export function selectIncompleteNetSuiteOrders(rows) {
  return rows.flatMap(row => {
    const kind = { SalesOrd: "SO", PurchOrd: "PO", TrnfrOrd: "TO" }[row.type];
    const status = String(row.status_text || "").split(":").at(-1).trim().toLowerCase();
    if (!kind || !Number.isSafeInteger(Number(row.id)) || Number(row.id) <= 0) {return [];}
    if (kind === "SO" && String(row.tranid).toUpperCase().startsWith("SOT")) {return [];}
    if (!/pending|partially/u.test(status) || /^(pending bill(?:ing)?)$/u.test(status)) {return [];}
    return [{ ...row, kind }];
  });
}

function matchingOrderLine(remote, row) {
  if (remote && String(remote.item_id) === String(row.item_id) && Number(remote.item_id) > 0) {
    try {return readNetSuiteOrderLine({ netsuite_order_line: remote.netsuite_order_line });}
    catch { /* Invalid evidence is reported, never guessed. */ }
  }
  return null;
}

export function planNetSuiteOrderLineBackfill(localRows, remoteRows) {
  const byKey = new Map();
  for (const row of remoteRows) {
    const key = `${row.order_id}:${row.line_id}`;
    const matches = byKey.get(key) || [];
    matches.push(row);
    byKey.set(key, matches);
  }
  const result = { updates: [], unchanged: [], unresolved: [], excluded: [] };
  for (const row of localRows) {
    if (String(row.item_type).toLowerCase() === "subtotal" || Number(row.item_id) === -2) {
      result.excluded.push({ ...row, reason: "subtotal_not_fulfillable" });
      continue;
    }
    const matches = byKey.get(`${row.order_id}:${row.line_id}`) || [];
    if (row.netsuite_active === false && matches.length === 0) {
      result.excluded.push({ ...row, reason: "inactive_historical_line" });
      continue;
    }
    const remote = matches.length === 1 ? matches[0] : null;
    const value = matchingOrderLine(remote, row);
    if (value === null) {
      result.unresolved.push({ ...row, reason: "missing_or_ambiguous_source_identity" });
    } else if (Number(row.netsuite_order_line) === value) {
      result.unchanged.push(row);
    } else {
      result.updates.push({ id: row.id, order_id: row.order_id, line_id: row.line_id, item_id: row.item_id,
        netsuite_order_line: value, expected_order_line: row.netsuite_order_line,
        expected_order_line_synced_at: row.netsuite_order_line_synced_at, expected_synced_at: row.synced_at,
        expected_active: row.netsuite_active });
    }
  }
  return result;
}

export async function readOrderLineBackfillRows(kind, ids) {
  const [table, parent] = tableFor(kind);
  return (await query(`SELECT id,${parent} AS order_id,line_id,item_id,item_type,netsuite_active,netsuite_order_line,
      netsuite_order_line_synced_at::text,netsuite_order_line_synced_at IS NOT NULL AS observed,
      synced_at::text FROM ${table}
    WHERE ${parent}=ANY($1::bigint[]) AND ${parent}>0 ORDER BY ${parent},id`, [ids])).rows;
}

export async function applyOrderLineBackfill(kind, updates) {
  const [table, parent] = tableFor(kind);
  return withTransaction(async () => {
    const result = { updated: [], conflicts: [] };
    for (const row of updates) {
      const value = readNetSuiteOrderLine({ netsuite_order_line: row.netsuite_order_line });
      if (value === null) {throw new Error("An explicit NetSuite orderLine is required.");}
      const applied = await query(`UPDATE ${table}
        SET netsuite_order_line=$1,netsuite_order_line_synced_at=clock_timestamp()
        WHERE id=$2 AND ${parent}=$3 AND ${parent}>0 AND line_id=$4 AND item_id=$5
          AND netsuite_order_line IS NOT DISTINCT FROM $6::bigint
          AND netsuite_order_line_synced_at IS NOT DISTINCT FROM $7::timestamptz
          AND synced_at IS NOT DISTINCT FROM $8::timestamptz
          AND netsuite_active IS NOT DISTINCT FROM $9::boolean RETURNING id`,
      [value, row.id, row.order_id, row.line_id, row.item_id, row.expected_order_line,
        row.expected_order_line_synced_at, row.expected_synced_at, row.expected_active]);
      result[applied.rowCount === 1 ? "updated" : "conflicts"].push(row.id);
    }
    return result;
  });
}
