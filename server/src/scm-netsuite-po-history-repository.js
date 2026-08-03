import { writeAudit } from "./auth-repository.js";
import { query, withTransaction } from "./db.js";

function positiveInt(value, fallback = null) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function text(value) {
  return String(value ?? "").trim();
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function sameTimestamp(left, right) {
  const a = new Date(left || 0).getTime();
  const b = new Date(right || 0).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1000;
}

function historyRow(row, lines = []) {
  return {
    id: Number(row.id),
    proposalId: row.proposal_id === null ? null : Number(row.proposal_id),
    purchaseOrderId: Number(row.netsuite_purchase_order_id),
    purchaseOrderRef: row.netsuite_purchase_order_ref,
    createdBy: row.created_by,
    appCreatedAt: row.app_created_at,
    creationSnapshot: row.creation_snapshot || {},
    archived: Boolean(row.archived_at),
    archivedAt: row.archived_at,
    archivedBy: row.archived_by,
    lastSyncedAt: row.last_synced_at || row.canonical_synced_at,
    lastSyncError: row.last_sync_error,
    remoteLastModifiedAt: row.remote_last_modified_at || row.canonical_remote_last_modified_at,
    current: {
      tranid: row.current_tranid || row.netsuite_purchase_order_ref,
      transactionDate: row.trandate,
      netSuiteCreatedAt: row.netsuite_created_at,
      vendorId: row.vendor_id === null ? null : Number(row.vendor_id),
      vendor: row.vendor,
      status: row.status,
      statusText: row.status_text,
      total: row.foreign_total === null ? null : Number(row.foreign_total),
      vendorYard: row.dispatch_vendor_yard || row.source_location,
      vendorReference: row.vendor_reference || "",
      expectedDeliveryDate: row.expected_delivery_date,
      memo: row.memo || "",
      active: row.netsuite_active !== false,
      lines
    }
  };
}

function lineRow(row) {
  const received = Number(row.netsuite_received_qty || 0);
  const closed = row.netsuite_closed === true;
  return {
    lineId: Number(row.line_id),
    itemId: Number(row.item_id),
    itemName: row.item_name,
    description: row.item_description || "",
    quantity: Number(row.quantity || 0),
    receivedQuantity: received,
    unit: row.unit || "",
    rate: row.rate === null ? null : Number(row.rate),
    amount: row.amount === null ? null : Number(row.amount),
    destinationLocationId: row.location_id === null ? null : Number(row.location_id),
    destination: row.location || "",
    closed,
    editable: !closed && received <= 0 && row.netsuite_active !== false
  };
}

const SELECT_HEADER = `
  SELECT h.*,
         po.tranid AS current_tranid, po.trandate, po.netsuite_created_at,
         po.vendor_id, po.vendor, po.status, po.status_text, po.foreign_total,
         po.dispatch_vendor_yard, po.source_location, po.vendor_reference,
         po.expected_delivery_date, po.memo, po.netsuite_active,
         po.synced_at AS canonical_synced_at,
         po.remote_last_modified_at AS canonical_remote_last_modified_at
    FROM scm_netsuite_po_history h
    LEFT JOIN purchase_orders po ON po.netsuite_id = h.netsuite_purchase_order_id`;

async function loadLines(orderIds) {
  if (!orderIds.length) return new Map();
  const result = await query(
    `SELECT * FROM purchase_order_lines
      WHERE purchase_order_id = ANY($1::bigint[])
        AND netsuite_active IS DISTINCT FROM false
      ORDER BY purchase_order_id, line_id, id`,
    [orderIds]
  );
  const grouped = new Map();
  for (const row of result.rows) {
    const id = Number(row.purchase_order_id);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(lineRow(row));
  }
  return grouped;
}

export async function listScmNetSuitePoHistory(filters = {}) {
  const page = positiveInt(filters.page, 1);
  const pageSize = Math.min(100, positiveInt(filters.pageSize || filters.limit, 25));
  const values = [];
  const clauses = [filters.includeUnarchived ? "true" : "h.archived_at IS NOT NULL"];
  const bind = (value) => { values.push(value); return `$${values.length}`; };
  if (text(filters.search)) {
    const p = bind(`%${text(filters.search)}%`);
    clauses.push(`(h.netsuite_purchase_order_ref ILIKE ${p} OR po.vendor ILIKE ${p} OR po.memo ILIKE ${p}
      OR EXISTS (SELECT 1 FROM purchase_order_lines pol WHERE pol.purchase_order_id = h.netsuite_purchase_order_id AND pol.netsuite_active IS DISTINCT FROM false AND (pol.item_name ILIKE ${p} OR pol.location ILIKE ${p})))`);
  }
  if (text(filters.createdFrom)) clauses.push(`h.app_created_at >= ${bind(text(filters.createdFrom))}::date`);
  if (text(filters.createdTo)) clauses.push(`h.app_created_at < (${bind(text(filters.createdTo))}::date + interval '1 day')`);
  if (positiveInt(filters.vendorId)) clauses.push(`po.vendor_id = ${bind(positiveInt(filters.vendorId))}`);
  else if (text(filters.vendor)) clauses.push(`po.vendor ILIKE ${bind(`%${text(filters.vendor)}%`)}`);
  if (text(filters.vendorYard)) clauses.push(`COALESCE(po.dispatch_vendor_yard, po.source_location, '') ILIKE ${bind(`%${text(filters.vendorYard)}%`)}`);
  if (positiveInt(filters.destinationLocationId)) {
    clauses.push(`EXISTS (SELECT 1 FROM purchase_order_lines pol WHERE pol.purchase_order_id = h.netsuite_purchase_order_id AND pol.netsuite_active IS DISTINCT FROM false AND pol.location_id = ${bind(positiveInt(filters.destinationLocationId))})`);
  } else if (text(filters.destinationYard)) {
    clauses.push(`EXISTS (SELECT 1 FROM purchase_order_lines pol WHERE pol.purchase_order_id = h.netsuite_purchase_order_id AND pol.netsuite_active IS DISTINCT FROM false AND pol.location ILIKE ${bind(`%${text(filters.destinationYard)}%`)})`);
  }
  const where = clauses.join(" AND ");
  const count = await query(`SELECT COUNT(*)::integer AS count FROM scm_netsuite_po_history h LEFT JOIN purchase_orders po ON po.netsuite_id = h.netsuite_purchase_order_id WHERE ${where}`, values);
  const offsetBind = bind((page - 1) * pageSize);
  const limitBind = bind(pageSize);
  const result = await query(`${SELECT_HEADER} WHERE ${where} ORDER BY h.archived_at DESC NULLS LAST, h.app_created_at DESC, h.id DESC OFFSET ${offsetBind} LIMIT ${limitBind}`, values);
  const lineMap = await loadLines(result.rows.map((row) => Number(row.netsuite_purchase_order_id)));
  const total = Number(count.rows[0]?.count || 0);
  return {
    records: result.rows.map((row) => historyRow(row, lineMap.get(Number(row.netsuite_purchase_order_id)) || [])),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize))
  };
}

export async function getScmNetSuitePoHistory(historyId, { includeUnarchived = true, forUpdate = false } = {}) {
  const id = positiveInt(historyId);
  if (!id) throw Object.assign(new Error("A valid PO history ID is required."), { status: 400 });
  const result = await query(`${SELECT_HEADER} WHERE h.id = $1 ${includeUnarchived ? "" : "AND h.archived_at IS NOT NULL"} ${forUpdate ? "FOR UPDATE OF h" : ""}`, [id]);
  if (!result.rowCount) throw Object.assign(new Error("The app-created purchase order was not found."), { status: 404 });
  const row = result.rows[0];
  const lines = await loadLines([Number(row.netsuite_purchase_order_id)]);
  return historyRow(row, lines.get(Number(row.netsuite_purchase_order_id)) || []);
}

async function proposalCreationSnapshot(proposalId, purchaseOrderId, purchaseOrderRef) {
  const result = await query(
    `SELECT p.*,
            COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM scm_smart_proposal_lines l WHERE l.proposal_id = p.id), '[]'::jsonb) AS snapshot_lines
       FROM scm_smart_proposals p WHERE p.id = $1`,
    [proposalId]
  );
  const p = result.rows[0];
  if (!p) return { proposalId, purchaseOrderId, purchaseOrderRef, lines: [] };
  return {
    proposalId: Number(p.id), purchaseOrderId, purchaseOrderRef,
    vendor: p.vendor, vendorReadyDate: p.vendor_ready_date,
    vendorReference: p.vendor_reference, routeStops: p.route_stops || [],
    lines: p.snapshot_lines || []
  };
}

export async function recordScmNetSuitePoCreation({ proposalId, purchaseOrderId, purchaseOrderRef, creationSnapshot = null } = {}, operatorId = null) {
  const poId = positiveInt(purchaseOrderId);
  const proposal = positiveInt(proposalId);
  if (!poId || !text(purchaseOrderRef)) throw Object.assign(new Error("A real NetSuite PO ID and reference are required."), { status: 400 });
  const snapshot = creationSnapshot && typeof creationSnapshot === "object"
    ? creationSnapshot
    : await proposalCreationSnapshot(proposal, poId, text(purchaseOrderRef));
  const result = await query(
    `INSERT INTO scm_netsuite_po_history (
       proposal_id, netsuite_purchase_order_id, netsuite_purchase_order_ref,
       created_by, creation_snapshot, last_synced_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, now())
     ON CONFLICT (netsuite_purchase_order_id) DO UPDATE SET
       netsuite_purchase_order_ref = EXCLUDED.netsuite_purchase_order_ref,
       proposal_id = COALESCE(scm_netsuite_po_history.proposal_id, EXCLUDED.proposal_id),
       updated_at = now()
     RETURNING id`,
    [proposal, poId, text(purchaseOrderRef), operatorId, JSON.stringify(snapshot)]
  );
  const historyId = Number(result.rows[0].id);
  await query(
    `INSERT INTO scm_netsuite_po_history_changes (history_id, actor_operator_id, source, requested_changes, resulting_snapshot)
     VALUES ($1, $2, 'creation', '{}'::jsonb, $3::jsonb)
     ON CONFLICT (history_id) WHERE source = 'creation' DO NOTHING`,
    [historyId, operatorId, JSON.stringify(snapshot)]
  );
  return getScmNetSuitePoHistory(historyId);
}

export async function setScmNetSuitePoHistoryArchived(historyId, archived, operatorId = null) {
  const changed = await withTransaction(async () => {
    const result = await query(
      `UPDATE scm_netsuite_po_history
          SET archived_at = CASE WHEN $2 THEN COALESCE(archived_at, now()) ELSE NULL END,
              archived_by = CASE WHEN $2 THEN $3 ELSE NULL END,
              updated_at = now()
        WHERE id = $1
        RETURNING id, proposal_id, netsuite_purchase_order_id`,
      [positiveInt(historyId), archived === true, operatorId]
    );
    if (!result.rowCount) throw Object.assign(new Error("The app-created purchase order was not found."), { status: 404 });
    const row = result.rows[0];
    await query(
      `UPDATE scm_smart_vendor_workflows
          SET archived_at = CASE WHEN $3 THEN COALESCE(archived_at, now()) ELSE NULL END,
              archived_by = CASE WHEN $3 THEN $4 ELSE NULL END,
              archive_reason = CASE WHEN $3 THEN 'manual_history' ELSE NULL END,
              version = version + 1,
              updated_at = now()
        WHERE netsuite_purchase_order_id = $1
           OR review_proposal_id = $2
           OR source_proposal_id = $2`,
      [Number(row.netsuite_purchase_order_id), row.proposal_id, archived === true, operatorId]
    );
    return row;
  });
  await writeAudit({ actorOperatorId: operatorId, source: "smart_scm", action: archived ? "smart_scm.netsuite_po.archived" : "smart_scm.netsuite_po.unarchived", orderId: Number(changed.netsuite_purchase_order_id), details: { historyId: Number(changed.id), proposalId: changed.proposal_id } });
  return getScmNetSuitePoHistory(changed.id);
}

export async function persistScmNetSuitePoSnapshot(historyId, snapshot, { source = "reconciliation", operatorId = null, requestedChanges = {} } = {}) {
  const allowedSource = ["application", "netsuite_webhook", "reconciliation"].includes(source) ? source : "reconciliation";
  return withTransaction(async () => {
    const current = await getScmNetSuitePoHistory(historyId, { forUpdate: true });
    const remote = iso(snapshot.lastModifiedAt);
    const isReconciliationHeartbeat = allowedSource === "reconciliation"
      && remote
      && current.remoteLastModifiedAt
      && sameTimestamp(remote, current.remoteLastModifiedAt)
      && (!requestedChanges || Object.keys(requestedChanges).length === 0);
    if (isReconciliationHeartbeat) {
      await query(`UPDATE purchase_orders SET synced_at = now() WHERE netsuite_id = $1`, [current.purchaseOrderId]);
      await query(
        `UPDATE scm_netsuite_po_history
            SET last_synced_at = now(), last_sync_error = NULL, updated_at = now()
          WHERE id = $1`,
        [current.id]
      );
      return getScmNetSuitePoHistory(current.id);
    }
    await query(
      `UPDATE purchase_orders
          SET netsuite_created_at = COALESCE($2, netsuite_created_at),
              remote_last_modified_at = COALESCE($3, remote_last_modified_at),
              vendor_reference = $4,
              synced_at = now()
        WHERE netsuite_id = $1`,
      [current.purchaseOrderId, iso(snapshot.createdAt), remote, text(snapshot.vendorReference)]
    );
    for (const line of snapshot.lines || []) {
      await query(
        `UPDATE purchase_order_lines
            SET rate = $3, amount = $4, netsuite_closed = $5, raw = COALESCE(raw, '{}'::jsonb) || $6::jsonb, synced_at = now()
          WHERE purchase_order_id = $1 AND line_id = $2`,
        [current.purchaseOrderId, positiveInt(line.lineId), line.rate ?? null, line.amount ?? null, line.closed === true, JSON.stringify({ rate: line.rate ?? null, amount: line.amount ?? null, closed: line.closed === true })]
      );
    }
    await query(
      `UPDATE scm_netsuite_po_history SET last_synced_at = now(), last_sync_error = NULL,
              remote_last_modified_at = COALESCE($2, remote_last_modified_at), updated_at = now()
        WHERE id = $1`,
      [current.id, remote]
    );
    await query(
      `INSERT INTO scm_netsuite_po_history_changes (
         history_id, actor_operator_id, source, remote_last_modified_before,
         remote_last_modified_after, requested_changes, resulting_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
      [current.id, operatorId, allowedSource, current.remoteLastModifiedAt, remote, JSON.stringify(requestedChanges || {}), JSON.stringify(snapshot || {})]
    );
    return getScmNetSuitePoHistory(current.id);
  });
}

export async function markScmNetSuitePoHistorySyncError(historyId, error) {
  await query(`UPDATE scm_netsuite_po_history SET last_sync_error = $2, updated_at = now() WHERE id = $1`, [positiveInt(historyId), text(error?.message || error).slice(0, 2000)]);
}

export async function findScmNetSuitePoHistoryByNetSuiteId(purchaseOrderId) {
  const result = await query(`SELECT id FROM scm_netsuite_po_history WHERE netsuite_purchase_order_id = $1`, [positiveInt(purchaseOrderId)]);
  return result.rowCount ? getScmNetSuitePoHistory(result.rows[0].id) : null;
}

export async function listScmNetSuitePoHistoryReconciliationCandidates({
  preferredHistoryId = null,
  limit = 25,
  staleBefore = new Date(Date.now() - 55_000)
} = {}) {
  const preferred = positiveInt(preferredHistoryId);
  const boundedLimit = Math.min(50, positiveInt(limit, 25));
  const result = await query(
    `SELECT id, netsuite_purchase_order_id
       FROM scm_netsuite_po_history
      WHERE ($1::bigint IS NOT NULL AND id = $1)
         OR (archived_at IS NOT NULL AND COALESCE(last_synced_at, '-infinity'::timestamptz) < $2::timestamptz)
      ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END,
               COALESCE(last_synced_at, '-infinity'::timestamptz), id
      LIMIT $3`,
    [preferred, iso(staleBefore) || new Date(Date.now() - 55_000).toISOString(), boundedLimit]
  );
  return result.rows.map((row) => ({
    historyId: Number(row.id),
    purchaseOrderId: Number(row.netsuite_purchase_order_id)
  }));
}

export async function listScmNetSuitePoHistoryFilterOptions() {
  const [vendors, vendorYards, destinations] = await Promise.all([
    query(`SELECT DISTINCT po.vendor_id AS id, po.vendor AS name FROM scm_netsuite_po_history h JOIN purchase_orders po ON po.netsuite_id = h.netsuite_purchase_order_id WHERE h.archived_at IS NOT NULL AND NULLIF(po.vendor, '') IS NOT NULL ORDER BY po.vendor`),
    query(`SELECT DISTINCT COALESCE(po.dispatch_vendor_yard, po.source_location) AS name FROM scm_netsuite_po_history h JOIN purchase_orders po ON po.netsuite_id = h.netsuite_purchase_order_id WHERE h.archived_at IS NOT NULL AND NULLIF(COALESCE(po.dispatch_vendor_yard, po.source_location), '') IS NOT NULL ORDER BY name`),
    query(`WITH candidates AS (
             SELECT pol.location_id AS id, pol.location AS name, 0 AS priority
               FROM scm_netsuite_po_history h
               JOIN purchase_order_lines pol ON pol.purchase_order_id = h.netsuite_purchase_order_id
              WHERE h.archived_at IS NOT NULL
                AND pol.netsuite_active IS DISTINCT FROM false
                AND pol.location_id IS NOT NULL
                AND NULLIF(pol.location, '') IS NOT NULL
             UNION ALL
             SELECT * FROM (VALUES
               (1::bigint, '3445'::text, 1),
               (15::bigint, '12441'::text, 1),
               (28::bigint, '2967'::text, 1),
               (26::bigint, '150'::text, 1)
             ) fallback(id, name, priority)
           ), chosen AS (
             SELECT DISTINCT ON (id) id, name
               FROM candidates
              ORDER BY id, priority, name
           )
           SELECT id, name FROM chosen
           ORDER BY CASE id WHEN 1 THEN 1 WHEN 15 THEN 2 WHEN 28 THEN 3 WHEN 26 THEN 4 ELSE 5 END, name, id`)
  ]);
  return { vendors: vendors.rows.map((row) => ({ id: Number(row.id), name: row.name })), vendorYards: vendorYards.rows.map((row) => row.name), destinations: destinations.rows.map((row) => ({ id: Number(row.id), name: row.name })) };
}
