import { writeAudit } from "./auth-repository.js";
import { closeDb, query, withTransaction } from "./db.js";
import { fetchScmReconciliationOrdersFromNetSuite } from "./netsuite.js";
import {
  mappedAuthoritativeSalesOrderLine,
  mappedSalesOrderHeader
} from "./sales-order-reconciliation-repository.js";

const REPAIR_KEY = "so-reconciliation-canonical-repair-2026-08-11-v2";
const IGNORED_ACTION = "netsuite.order.reconciliation_source_repair_ignored";
const IGNORED_PREFIXES = new Set(["SOR", "SOS", "SOV"]);
const FETCH_BATCH_SIZE = 200;
const WRITE_CONCURRENCY = 6;

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function requestedLimit(args = []) {
  const raw = args.find((argument) => argument.startsWith("--limit="));
  if (!raw) return null;
  const limit = positiveInteger(raw.slice("--limit=".length));
  if (!limit) throw new Error("--limit must be a positive integer.");
  return limit;
}

async function affectedSalesOrders({ limit = null, includeRepaired = false } = {}) {
  const result = await query(
    `WITH affected AS (
       SELECT audit.parent_order_netsuite_id AS netsuite_id,
              max(audit.received_at) AS last_faulty_apply_at,
              count(*) AS faulty_apply_count
         FROM scm_reconciliation_audit_events audit
        WHERE audit.parent_order_kind = 'SO'
          AND audit.event_type = 'order.applied'
          AND audit.parent_order_netsuite_id > 0
        GROUP BY audit.parent_order_netsuite_id
     )
     SELECT affected.netsuite_id,
            sales_order.tranid,
            affected.last_faulty_apply_at,
            affected.faulty_apply_count
       FROM affected
       JOIN sales_orders sales_order
         ON sales_order.netsuite_id = affected.netsuite_id
      WHERE (
        $1::boolean
        OR NOT EXISTS (
          SELECT 1
            FROM delivery_audit_log repair
           WHERE repair.order_id = affected.netsuite_id
             AND repair.action IN (
               'netsuite.order.reconciliation_source_repair',
               'netsuite.order.reconciliation_source_repair_ignored'
             )
             AND repair.details->>'repairKey' = $2
        )
      )
        AND NOT EXISTS (
          SELECT 1
            FROM delivery_audit_log ignored
           WHERE ignored.order_id = affected.netsuite_id
             AND ignored.action = 'netsuite.order.reconciliation_source_repair_ignored'
             AND ignored.details->>'disposition' = 'ignored_by_user'
        )
      ORDER BY affected.netsuite_id
      LIMIT $3`,
    [includeRepaired, REPAIR_KEY, limit]
  );
  return result.rows.map((row) => ({
    id: Number(row.netsuite_id),
    ref: String(row.tranid || "").trim().toUpperCase(),
    lastFaultyApplyAt: row.last_faulty_apply_at,
    faultyApplyCount: Number(row.faulty_apply_count || 0)
  }));
}

function validateFetchedOrder(order, expected) {
  if (!order || order.kind !== "SO" || Number(order.id) !== expected.id) {
    throw new Error(`NetSuite did not return the expected Sales Order ${expected.ref} (${expected.id}).`);
  }
  const ref = String(order.tranid || "").trim().toUpperCase();
  if (!ref || ref !== expected.ref) {
    throw new Error(`NetSuite identity mismatch for ${expected.ref} (${expected.id}); received ${ref || "an empty reference"}.`);
  }
  if (!Array.isArray(order.lines) || !order.lines.length) {
    throw new Error(`NetSuite returned no item lines for ${expected.ref}; refusing to change local line activity.`);
  }
  const lineKeys = order.lines.map((line) => String(line.sourceLineKey || "").trim());
  if (lineKeys.some((lineKey) => !/^\d+$/.test(lineKey) || Number(lineKey) <= 0)) {
    throw new Error(`NetSuite returned an unsafe line identity for ${expected.ref}.`);
  }
  if (new Set(lineKeys).size !== lineKeys.length) {
    throw new Error(`NetSuite returned duplicate line identities for ${expected.ref}.`);
  }
}

function normalizedDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match
    ? `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`
    : null;
}

async function syncAffectedSalesOrderSource(order) {
  const header = mappedSalesOrderHeader(order);
  const headerResult = await query(
    `UPDATE sales_orders
        SET tranid = $2,
            trandate = COALESCE($3::date, trandate),
            customer_id = $4,
            customer = $5,
            status_updated_at = CASE
              WHEN status IS DISTINCT FROM $6
                OR status_text IS DISTINCT FROM $7
              THEN now()
              ELSE status_updated_at
            END,
            status = $6,
            status_text = $7,
            foreign_total = $8,
            expected_delivery_date = COALESCE($9::date, expected_delivery_date),
            order_location_id = $10,
            order_location = $11,
            outbound_location_id = $12,
            outbound_location = $13,
            delivery_method_id = $14,
            sales_order_type = CASE
              WHEN COALESCE(sales_order_type_override, false) THEN sales_order_type
              ELSE COALESCE(NULLIF($15, ''), sales_order_type)
            END,
            netsuite_sales_order_type = COALESCE(NULLIF($15, ''), netsuite_sales_order_type),
            memo = $16,
            netsuite_active = true,
            netsuite_missing_at = NULL,
            synced_at = now()
      WHERE netsuite_id = $1`,
    [
      header.id,
      header.tranid,
      normalizedDate(header.trandate),
      header.customer_id,
      header.customer,
      header.status,
      header.status_text,
      header.foreigntotal,
      normalizedDate(header.expected_delivery_date),
      header.order_location_id,
      header.order_location,
      header.outbound_location_id,
      header.outbound_location,
      header.delivery_method_id,
      header.delivery_method,
      header.memo
    ]
  );
  if (headerResult.rowCount !== 1) {
    throw new Error(`Local Sales Order ${header.tranid} (${header.id}) disappeared during repair.`);
  }

  const lines = order.lines.map(mappedAuthoritativeSalesOrderLine);
  await query(
    `INSERT INTO sales_order_lines (
       sales_order_id, line_id, item_id, item_name, item_type, item_type_text,
       item_description, sku, quantity, unit, item_weight, location_id,
       location, pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs, pack_quantity_source,
       netsuite_committed_qty, netsuite_backordered_qty,
       netsuite_active, synced_at
     )
     SELECT $1,
            source.line_id,
            source.item_id,
            source.item_name,
            source.item_type,
            source.item_type_text,
            source.item_description,
            source.sku,
            source.quantity,
            source.unit,
            source.item_weight,
            source.location_id,
            source.location,
            source.pallet_qty,
            source.layer_qty,
            source.section_qty,
            source.piece_qty,
            source.to_plt,
            source.to_lyr,
            source.to_sec,
            source.to_pcs,
            source.pack_quantity_source,
            COALESCE(source.netsuite_committed_qty, 0),
            COALESCE(source.netsuite_backordered_qty, 0),
            true,
            now()
       FROM jsonb_to_recordset($2::jsonb) AS source(
         line_id bigint,
         item_id bigint,
         item_name text,
         item_type text,
         item_type_text text,
         item_description text,
         sku text,
         quantity numeric,
         unit text,
         item_weight numeric,
         location_id bigint,
         location text,
         pallet_qty numeric,
         layer_qty numeric,
         section_qty numeric,
         piece_qty numeric,
         to_plt numeric,
         to_lyr numeric,
         to_sec numeric,
         to_pcs numeric,
         pack_quantity_source text,
         netsuite_committed_qty numeric,
         netsuite_backordered_qty numeric
       )
     ON CONFLICT (sales_order_id, line_id) DO UPDATE SET
       item_id = EXCLUDED.item_id,
       item_name = COALESCE(NULLIF(EXCLUDED.item_name, ''), sales_order_lines.item_name),
       item_type = COALESCE(NULLIF(EXCLUDED.item_type, ''), sales_order_lines.item_type),
       item_type_text = COALESCE(NULLIF(EXCLUDED.item_type_text, ''), sales_order_lines.item_type_text),
       item_description = EXCLUDED.item_description,
       sku = COALESCE(NULLIF(EXCLUDED.sku, ''), sales_order_lines.sku),
       quantity = EXCLUDED.quantity,
       unit = EXCLUDED.unit,
       item_weight = EXCLUDED.item_weight,
       location_id = EXCLUDED.location_id,
       location = EXCLUDED.location,
       pallet_qty = EXCLUDED.pallet_qty,
       layer_qty = EXCLUDED.layer_qty,
       section_qty = EXCLUDED.section_qty,
       piece_qty = EXCLUDED.piece_qty,
       to_plt = EXCLUDED.to_plt,
       to_lyr = EXCLUDED.to_lyr,
       to_sec = EXCLUDED.to_sec,
       to_pcs = EXCLUDED.to_pcs,
       pack_quantity_source = EXCLUDED.pack_quantity_source,
       netsuite_committed_qty = EXCLUDED.netsuite_committed_qty,
       netsuite_backordered_qty = EXCLUDED.netsuite_backordered_qty,
       sync_exception = CASE
         WHEN COALESCE(sales_order_lines.packed_pallet_qty, 0) > COALESCE(EXCLUDED.pallet_qty, 0)
           OR COALESCE(sales_order_lines.packed_layer_qty, 0) > COALESCE(EXCLUDED.layer_qty, 0)
           OR COALESCE(sales_order_lines.packed_section_qty, 0) > COALESCE(EXCLUDED.section_qty, 0)
           OR COALESCE(sales_order_lines.packed_piece_qty, 0) > COALESCE(EXCLUDED.piece_qty, EXCLUDED.quantity, 0)
         THEN 'qty_reduced'
         ELSE NULL
       END,
       sync_exception_at = CASE
         WHEN COALESCE(sales_order_lines.packed_pallet_qty, 0) > COALESCE(EXCLUDED.pallet_qty, 0)
           OR COALESCE(sales_order_lines.packed_layer_qty, 0) > COALESCE(EXCLUDED.layer_qty, 0)
           OR COALESCE(sales_order_lines.packed_section_qty, 0) > COALESCE(EXCLUDED.section_qty, 0)
           OR COALESCE(sales_order_lines.packed_piece_qty, 0) > COALESCE(EXCLUDED.piece_qty, EXCLUDED.quantity, 0)
         THEN COALESCE(sales_order_lines.sync_exception_at, now())
         ELSE NULL
       END,
       netsuite_active = true,
       synced_at = now()`,
    [header.id, JSON.stringify(lines)]
  );
  await query(
    `UPDATE sales_order_lines
        SET netsuite_active = false,
            sync_exception = CASE
              WHEN COALESCE(packed_pallet_qty, 0)
                 + COALESCE(packed_layer_qty, 0)
                 + COALESCE(packed_section_qty, 0)
                 + COALESCE(packed_piece_qty, 0) > 0
              THEN 'line_deleted'
              ELSE sync_exception
            END,
            sync_exception_at = CASE
              WHEN COALESCE(packed_pallet_qty, 0)
                 + COALESCE(packed_layer_qty, 0)
                 + COALESCE(packed_section_qty, 0)
                 + COALESCE(packed_piece_qty, 0) > 0
              THEN COALESCE(sync_exception_at, now())
              ELSE sync_exception_at
            END,
            synced_at = now()
      WHERE sales_order_id = $1
        AND netsuite_active = true
        AND line_id <> ALL($2::bigint[])`,
    [header.id, lines.map((line) => Number(line.line_id))]
  );
}

async function restoreFaultyDispatchDerivations() {
  const result = await query(
    `WITH repaired AS (
       SELECT DISTINCT order_id
         FROM delivery_audit_log
        WHERE action = 'netsuite.order.reconciliation_source_repair'
          AND details->>'repairKey' = $1
     ), latest_fault AS (
       SELECT DISTINCT ON (event.parent_order_netsuite_id)
              event.parent_order_netsuite_id AS order_id,
              audit.details->'changes' AS changes
         FROM scm_reconciliation_audit_events event
         JOIN delivery_audit_log audit
           ON audit.order_id = event.parent_order_netsuite_id
          AND audit.created_at = event.received_at
          AND audit.action = 'netsuite.order.update'
         JOIN repaired
           ON repaired.order_id = event.parent_order_netsuite_id
        WHERE event.parent_order_kind = 'SO'
          AND event.event_type = 'order.applied'
          AND COALESCE(audit.details->'changes', '{}'::jsonb) ?| ARRAY[
            'dispatch_address', 'dispatch_window_start', 'dispatch_window_end',
            'dispatch_instructions', 'dispatch_parse_source', 'dispatch_note_hash'
          ]
        ORDER BY event.parent_order_netsuite_id, event.received_at DESC
     )
     UPDATE sales_orders sales_order
        SET dispatch_address = CASE
              WHEN latest_fault.changes ? 'dispatch_address'
               AND sales_order.dispatch_address IS NOT DISTINCT FROM latest_fault.changes->'dispatch_address'->>'after'
              THEN latest_fault.changes->'dispatch_address'->>'before'
              ELSE sales_order.dispatch_address
            END,
            dispatch_window_start = CASE
              WHEN latest_fault.changes ? 'dispatch_window_start'
               AND sales_order.dispatch_window_start IS NOT DISTINCT FROM latest_fault.changes->'dispatch_window_start'->>'after'
              THEN latest_fault.changes->'dispatch_window_start'->>'before'
              ELSE sales_order.dispatch_window_start
            END,
            dispatch_window_end = CASE
              WHEN latest_fault.changes ? 'dispatch_window_end'
               AND sales_order.dispatch_window_end IS NOT DISTINCT FROM latest_fault.changes->'dispatch_window_end'->>'after'
              THEN latest_fault.changes->'dispatch_window_end'->>'before'
              ELSE sales_order.dispatch_window_end
            END,
            dispatch_instructions = CASE
              WHEN latest_fault.changes ? 'dispatch_instructions'
               AND sales_order.dispatch_instructions IS NOT DISTINCT FROM latest_fault.changes->'dispatch_instructions'->>'after'
              THEN latest_fault.changes->'dispatch_instructions'->>'before'
              ELSE sales_order.dispatch_instructions
            END,
            dispatch_parse_source = CASE
              WHEN latest_fault.changes ? 'dispatch_parse_source'
               AND sales_order.dispatch_parse_source IS NOT DISTINCT FROM latest_fault.changes->'dispatch_parse_source'->>'after'
              THEN latest_fault.changes->'dispatch_parse_source'->>'before'
              ELSE sales_order.dispatch_parse_source
            END,
            dispatch_note_hash = CASE
              WHEN latest_fault.changes ? 'dispatch_note_hash'
               AND sales_order.dispatch_note_hash IS NOT DISTINCT FROM latest_fault.changes->'dispatch_note_hash'->>'after'
              THEN latest_fault.changes->'dispatch_note_hash'->>'before'
              ELSE sales_order.dispatch_note_hash
            END
       FROM latest_fault
      WHERE sales_order.netsuite_id = latest_fault.order_id`,
    [REPAIR_KEY]
  );
  return result.rowCount;
}

async function repairOrder(order, expected) {
  validateFetchedOrder(order, expected);
  await withTransaction(async () => {
    await syncAffectedSalesOrderSource(order);
    await writeAudit({
      actorType: "system",
      source: "reconciliation-repair",
      action: "netsuite.order.reconciliation_source_repair",
      orderId: expected.id,
      details: {
        repairKey: REPAIR_KEY,
        orderRef: expected.ref,
        orderType: "sales_order",
        lineCount: order.lines.length,
        faultyApplyCount: expected.faultyApplyCount,
        lastFaultyApplyAt: expected.lastFaultyApplyAt,
        reason: "Restore authoritative Sales Order source fields after the legacy reconciliation calculation write path."
      }
    });
  });
}

async function acknowledgeIgnoredOrder(expected) {
  const prefix = expected.ref.slice(0, 3);
  if (!IGNORED_PREFIXES.has(prefix)) {
    throw new Error(`Refusing to ignore non-exempt Sales Order ${expected.ref} (${expected.id}).`);
  }
  await withTransaction(async () => {
    await writeAudit({
      actorType: "system",
      source: "reconciliation-repair",
      action: IGNORED_ACTION,
      orderId: expected.id,
      details: {
        repairKey: REPAIR_KEY,
        orderRef: expected.ref,
        orderType: "sales_order",
        prefix,
        disposition: "ignored_by_user",
        faultyApplyCount: expected.faultyApplyCount,
        lastFaultyApplyAt: expected.lastFaultyApplyAt,
        reason: "NetSuite no longer returns this historical SOR/SOS/SOV order; user explicitly excluded these prefixes from source repair."
      }
    });
  });
}

async function run() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const acknowledgeIgnored = args.includes("--acknowledge-ignored");
  const includeRepaired = args.includes("--include-repaired");
  const limit = requestedLimit(args);
  const affected = await affectedSalesOrders({ limit, includeRepaired });
  console.log(JSON.stringify({
    repairKey: REPAIR_KEY,
    mode: apply ? acknowledgeIgnored ? "acknowledge-ignored" : "apply" : "inventory",
    affectedOrders: affected.length,
    firstOrder: affected[0] || null,
    lastOrder: affected.at(-1) || null
  }));
  if (!apply || !affected.length) return;

  if (acknowledgeIgnored) {
    const invalid = affected.filter((order) => !IGNORED_PREFIXES.has(order.ref.slice(0, 3)));
    if (invalid.length) {
      throw new Error(`Refusing to acknowledge ${invalid.length} non-exempt affected Sales Order(s).`);
    }
    let acknowledged = 0;
    for (let offset = 0; offset < affected.length; offset += WRITE_CONCURRENCY) {
      const batch = affected.slice(offset, offset + WRITE_CONCURRENCY);
      await Promise.all(batch.map(acknowledgeIgnoredOrder));
      acknowledged += batch.length;
    }
    console.log(JSON.stringify({
      repairKey: REPAIR_KEY,
      acknowledged,
      prefixes: [...IGNORED_PREFIXES].sort()
    }));
    return;
  }

  const failures = [];
  let repaired = 0;
  for (let offset = 0; offset < affected.length; offset += FETCH_BATCH_SIZE) {
    const batch = affected.slice(offset, offset + FETCH_BATCH_SIZE);
    let fetched;
    try {
      fetched = await fetchScmReconciliationOrdersFromNetSuite({
        orderIds: batch.map((order) => order.id),
        kind: "SO",
        includeOpen: false,
        targetOnly: true
      });
    } catch (error) {
      failures.push(...batch.map((order) => ({
        id: order.id,
        ref: order.ref,
        error: `Batch fetch failed: ${error?.message || error}`
      })));
      console.error(JSON.stringify({
        batch: Math.floor(offset / FETCH_BATCH_SIZE) + 1,
        fetched: 0,
        repaired,
        failed: failures.length,
        error: error?.message || String(error)
      }));
      continue;
    }
    const fetchedById = new Map((fetched || []).map((order) => [Number(order.id), order]));
    for (let writeOffset = 0; writeOffset < batch.length; writeOffset += WRITE_CONCURRENCY) {
      const writeBatch = batch.slice(writeOffset, writeOffset + WRITE_CONCURRENCY);
      await Promise.all(writeBatch.map(async (expected) => {
        try {
          await repairOrder(fetchedById.get(expected.id), expected);
          repaired += 1;
        } catch (error) {
          failures.push({
            id: expected.id,
            ref: expected.ref,
            error: error?.message || String(error)
          });
        }
      }));
    }
    console.log(JSON.stringify({
      batch: Math.floor(offset / FETCH_BATCH_SIZE) + 1,
      batches: Math.ceil(affected.length / FETCH_BATCH_SIZE),
      attempted: Math.min(offset + batch.length, affected.length),
      repaired,
      failed: failures.length
    }));
  }

  const restoredDispatchOrders = await restoreFaultyDispatchDerivations();

  console.log(JSON.stringify({
    repairKey: REPAIR_KEY,
    attempted: affected.length,
    repaired,
    failed: failures.length,
    restoredDispatchOrders,
    failures: failures.slice(0, 100)
  }));
  if (failures.length) process.exitCode = 1;
}

try {
  await run();
} finally {
  await closeDb();
}
