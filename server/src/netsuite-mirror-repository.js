import crypto from "node:crypto";
import { config } from "./config.js";
import { query } from "./db.js";

const ORDER_ENTITY_TYPES = new Set(["sales_order", "purchase_order", "transfer_order"]);

function numericId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function eventEnvelope(row) {
  return {
    sequence: Number(row.sequence_id),
    eventUuid: row.event_uuid,
    entityType: row.entity_type,
    entityId: row.entity_id,
    changeType: row.change_type,
    source: row.source,
    payload: row.payload || {},
    createdAt: row.created_at
  };
}

export function isNetSuiteMirrorSource() {
  return config.netSuiteMirror?.role === "source";
}

export function isNetSuiteMirrorConsumer() {
  return config.netSuiteMirror?.role === "consumer";
}

export async function enqueueNetSuiteMirrorEvent({
  entityType,
  entityId,
  changeType = "upsert",
  source = "netsuite-sync",
  payload = {}
} = {}) {
  if (!isNetSuiteMirrorSource()) return null;
  if (![...ORDER_ENTITY_TYPES, "inventory"].includes(entityType)) {
    throw new Error(`Unsupported NetSuite mirror entity type: ${entityType}`);
  }
  const normalizedId = String(entityId || "").trim();
  if (!normalizedId) throw new Error("NetSuite mirror entity ID is required.");
  const inserted = await query(
    `WITH allocated AS (
       UPDATE netsuite_mirror_sequence
          SET last_sequence = last_sequence + 1
        WHERE singleton_id = 1
       RETURNING last_sequence
     ), inserted AS (
       INSERT INTO netsuite_mirror_events (
         sequence_id, event_uuid, entity_type, entity_id, change_type, source, payload
       ) SELECT allocated.last_sequence, $1, $2, $3, $4, $5, $6::jsonb
           FROM allocated
       RETURNING *
     ), stored_high_water AS (
       INSERT INTO netsuite_mirror_state (state_key, state_value, updated_at)
       SELECT 'source_high_water', jsonb_build_object('sequence', sequence_id, 'observedAt', now()), now()
         FROM inserted
       ON CONFLICT (state_key) DO UPDATE
         SET state_value = EXCLUDED.state_value, updated_at = now()
       RETURNING state_key
     )
     SELECT * FROM inserted`,
    [crypto.randomUUID(), entityType, normalizedId, changeType, source, JSON.stringify(payload || {})]
  );
  return eventEnvelope(inserted.rows[0]);
}

export function enqueueNetSuiteMirrorOrderEvent(entityType, entityId, options = {}) {
  return enqueueNetSuiteMirrorEvent({ entityType, entityId, ...options });
}

export async function enqueueNetSuiteMirrorInventoryEvent(itemIds = [], options = {}) {
  const ids = [...new Set((itemIds || []).map(numericId).filter(Boolean))];
  if (!ids.length || !isNetSuiteMirrorSource()) return null;
  return enqueueNetSuiteMirrorEvent({
    entityType: "inventory",
    entityId: `batch:${crypto.randomUUID()}`,
    payload: { itemIds: ids },
    ...options
  });
}

export async function listNetSuiteMirrorEvents({ after = 0, limit = 100 } = {}) {
  const safeAfter = Math.max(0, Number(after) || 0);
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const [events, bounds] = await Promise.all([
    query(
      `SELECT *
         FROM netsuite_mirror_events
        WHERE sequence_id > $1
        ORDER BY sequence_id
        LIMIT $2`,
      [safeAfter, safeLimit]
    ),
    query(
      `SELECT COALESCE(MIN(sequence_id), 0) AS oldest_sequence,
              GREATEST(
                COALESCE(MAX(sequence_id), 0),
                COALESCE((SELECT (state_value->>'sequence')::bigint FROM netsuite_mirror_state
                           WHERE state_key = 'source_high_water'), 0)
              ) AS high_water_sequence
         FROM netsuite_mirror_events`
    )
  ]);
  const oldestSequence = Number(bounds.rows[0]?.oldest_sequence || 0);
  const highWaterSequence = Number(bounds.rows[0]?.high_water_sequence || 0);
  return {
    contract: "netsuite-mirror/v1",
    events: events.rows.map(eventEnvelope),
    oldestSequence,
    highWaterSequence,
    cursorExpired: oldestSequence > safeAfter + 1 || (oldestSequence === 0 && highWaterSequence > safeAfter)
  };
}

export async function listPendingNetSuiteMirrorEvents(limit = 100) {
  const result = await query(
    `SELECT *
       FROM netsuite_mirror_events
      WHERE status IN ('pending', 'failed')
        AND next_attempt_at <= now()
      ORDER BY sequence_id
      LIMIT $1`,
    [Math.min(500, Math.max(1, Number(limit) || 100))]
  );
  return result.rows.map(eventEnvelope);
}

export async function markNetSuiteMirrorEventsDelivered(eventUuids = []) {
  if (!eventUuids.length) return;
  await query(
    `UPDATE netsuite_mirror_events
        SET status = 'delivered', delivered_at = now(), last_error = null, updated_at = now()
      WHERE event_uuid = ANY($1::uuid[])`,
    [eventUuids]
  );
}

export async function markNetSuiteMirrorEventsFailed(eventUuids = [], error = "Relay failed") {
  if (!eventUuids.length) return;
  await query(
    `UPDATE netsuite_mirror_events
        SET status = 'failed',
            attempts = attempts + 1,
            last_error = left($2, 2000),
            next_attempt_at = now() + LEAST(interval '5 minutes', interval '5 seconds' * power(2, LEAST(attempts, 6))),
            updated_at = now()
      WHERE event_uuid = ANY($1::uuid[])`,
    [eventUuids, String(error || "Relay failed")]
  );
}

export async function retryNetSuiteMirrorFailures() {
  const result = await query(
    `UPDATE netsuite_mirror_events
        SET status = 'pending', next_attempt_at = now(), last_error = null, updated_at = now()
      WHERE status = 'failed'
      RETURNING event_uuid`
  );
  const inbox = await query(
    `UPDATE netsuite_mirror_inbox
        SET status = 'pending', last_error = null, updated_at = now()
      WHERE status = 'failed'
      RETURNING event_uuid`
  );
  return { sourceRetried: result.rowCount, consumerRetried: inbox.rowCount };
}

export async function pruneNetSuiteMirrorEvents() {
  const result = await query(
    `DELETE FROM netsuite_mirror_events
      WHERE status = 'delivered'
        AND delivered_at < now() - interval '30 days'`
  );
  return result.rowCount;
}

function mapOrderLine(row) {
  return {
    line_id: row.line_id,
    item_id: row.item_id,
    item_name: row.item_name,
    sku: row.sku,
    item_description: row.item_description,
    item_type: row.item_type,
    item_type_text: row.item_type_text,
    quantity: row.quantity,
    unit: row.unit,
    item_weight: row.item_weight,
    location_id: row.location_id,
    location: row.location,
    pallet_qty: row.pallet_qty,
    layer_qty: row.layer_qty,
    section_qty: row.section_qty,
    piece_qty: row.piece_qty,
    to_plt: row.to_plt,
    to_lyr: row.to_lyr,
    to_sec: row.to_sec,
    to_pcs: row.to_pcs,
    netsuite_committed_qty: row.netsuite_committed_qty,
    netsuite_backordered_qty: row.netsuite_backordered_qty,
    netsuite_received_qty: row.netsuite_received_qty,
    pack_quantity_source: row.pack_quantity_source,
    raw: row.raw || {}
  };
}

export async function getNetSuiteMirrorOrderSnapshot(entityType, entityId) {
  const orderId = numericId(entityId);
  if (!ORDER_ENTITY_TYPES.has(entityType) || !orderId) return null;

  if (entityType === "sales_order") {
    const [header, lines] = await Promise.all([
      query(
        `SELECT netsuite_id AS id, tranid, trandate, customer_id, customer, status, status_text,
                foreign_total AS foreigntotal, order_location_id, order_location,
                outbound_location_id, outbound_location, delivery_method_id,
                COALESCE(netsuite_sales_order_type, sales_order_type) AS delivery_method,
                memo, expected_delivery_date, netsuite_active, netsuite_missing_at, synced_at
           FROM sales_orders WHERE netsuite_id = $1`,
        [orderId]
      ),
      query(
        `SELECT line_id, item_id, item_name, sku, item_description, item_type, item_type_text,
                quantity, unit, item_weight, location_id, location, pallet_qty, layer_qty,
                section_qty, piece_qty, to_plt, to_lyr, to_sec, to_pcs,
                netsuite_committed_qty, netsuite_backordered_qty, null::numeric AS netsuite_received_qty,
                pack_quantity_source, '{}'::jsonb AS raw, netsuite_active
           FROM sales_order_lines
          WHERE sales_order_id = $1
          ORDER BY line_id, id`,
        [orderId]
      )
    ]);
    if (!header.rowCount) return null;
    return {
      contract: "netsuite-mirror/v1",
      entityType,
      header: header.rows[0],
      stages: {
        outbound: lines.rows.filter((row) => row.netsuite_active).map(mapOrderLine)
      }
    };
  }

  if (entityType === "purchase_order") {
    const [header, lines] = await Promise.all([
      query(
        `SELECT netsuite_id AS id, tranid, trandate, vendor_id, vendor, vendor_address,
                status, status_text, foreign_total AS foreigntotal, memo,
                source_location_id, source_location, destination_location_id,
                destination_location, expected_delivery_date, netsuite_active,
                netsuite_missing_at, synced_at
           FROM purchase_orders WHERE netsuite_id = $1`,
        [orderId]
      ),
      query(
        `SELECT line_id, item_id, item_name, sku, item_description, item_type, item_type_text,
                quantity, unit, item_weight, location_id, location, pallet_qty, layer_qty,
                section_qty, piece_qty, to_plt, to_lyr, to_sec, to_pcs,
                null::numeric AS netsuite_committed_qty, null::numeric AS netsuite_backordered_qty,
                netsuite_received_qty, pack_quantity_source, raw, netsuite_active
           FROM purchase_order_lines
          WHERE purchase_order_id = $1
          ORDER BY line_id, id`,
        [orderId]
      )
    ]);
    if (!header.rowCount) return null;
    return {
      contract: "netsuite-mirror/v1",
      entityType,
      header: header.rows[0],
      stages: {
        receiving: lines.rows.filter((row) => row.netsuite_active).map(mapOrderLine)
      }
    };
  }

  const [header, lines] = await Promise.all([
    query(
      `SELECT netsuite_id AS id, tranid, trandate, status, status_text, memo,
              from_location_id AS source_location_id, from_location AS source_location,
              to_location_id AS destination_location_id, to_location AS destination_location,
              expected_delivery_date, netsuite_active, netsuite_missing_at, synced_at,
              (outbound_operator_status IS NOT NULL OR EXISTS (
                SELECT 1 FROM transfer_order_lines line
                 WHERE line.transfer_order_id = transfer_orders.netsuite_id AND line.line_stage = 'outbound'
              )) AS has_outbound,
              (receiving_status IS NOT NULL OR EXISTS (
                SELECT 1 FROM transfer_order_lines line
                 WHERE line.transfer_order_id = transfer_orders.netsuite_id AND line.line_stage = 'receiving'
              )) AS has_receiving
         FROM transfer_orders WHERE netsuite_id = $1`,
      [orderId]
    ),
    query(
      `SELECT line_stage, line_id, item_id, item_name, sku, item_description, item_type, item_type_text,
              quantity, unit, item_weight, location_id, location, pallet_qty, layer_qty,
              section_qty, piece_qty, to_plt, to_lyr, to_sec, to_pcs,
              null::numeric AS netsuite_committed_qty, null::numeric AS netsuite_backordered_qty,
              CASE WHEN line_stage = 'receiving' THEN netsuite_received_qty ELSE null::numeric END AS netsuite_received_qty,
              pack_quantity_source, raw, netsuite_active
         FROM transfer_order_lines
        WHERE transfer_order_id = $1
        ORDER BY line_stage, line_id, id`,
      [orderId]
    )
  ]);
  if (!header.rowCount) return null;
  const activeLines = lines.rows.filter((row) => row.netsuite_active);
  return {
    contract: "netsuite-mirror/v1",
    entityType,
    header: header.rows[0],
    stages: {
      outbound: activeLines.filter((row) => row.line_stage === "outbound").map(mapOrderLine),
      receiving: activeLines.filter((row) => row.line_stage === "receiving").map(mapOrderLine)
    }
  };
}

export async function getNetSuiteMirrorInventorySnapshot(itemIds = []) {
  const ids = [...new Set((itemIds || []).map(numericId).filter(Boolean))];
  if (!ids.length) return { contract: "netsuite-mirror/v1", rows: [] };
  const result = await query(
    `SELECT item.item_id, item.item_name, item.display_name, item.item_description,
            item.item_type, item.item_type_text, item.stock_unit, item.item_weight,
            item.to_plt, item.to_lyr, item.to_sec, item.to_pcs, item.raw,
            balance.location_id, balance.location, balance.quantity_on_hand,
            balance.quantity_available
       FROM inventory_items item
       JOIN inventory_balances balance ON balance.item_id = item.item_id
      WHERE item.item_id = ANY($1::bigint[])
      ORDER BY item.item_id, balance.location_id`,
    [ids]
  );
  return { contract: "netsuite-mirror/v1", rows: result.rows };
}

export async function acceptNetSuiteMirrorEvents(events = []) {
  let accepted = 0;
  for (const event of events || []) {
    const sequence = Number(event.sequence);
    if (
      !Number.isSafeInteger(sequence)
      || sequence <= 0
      || !event.eventUuid
      || ![...ORDER_ENTITY_TYPES, "inventory"].includes(event.entityType)
    ) continue;
    const result = await query(
      `INSERT INTO netsuite_mirror_inbox (
         event_uuid, source_sequence, entity_type, entity_id, change_type, source, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT DO NOTHING`,
      [event.eventUuid, sequence, event.entityType, String(event.entityId), event.changeType || "upsert", event.source || "netsuite-sync", JSON.stringify(event.payload || {})]
    );
    accepted += result.rowCount;
  }
  return { accepted };
}

export async function getNetSuiteMirrorCursor() {
  const result = await query(
    `SELECT COALESCE((state_value->>'sequence')::bigint, 0) AS sequence,
            state_value->>'lastAppliedAt' AS last_applied_at,
            state_value->>'lastReconciledAt' AS last_reconciled_at
       FROM netsuite_mirror_state
      WHERE state_key = 'consumer_cursor'`
  );
  return {
    sequence: Number(result.rows[0]?.sequence || 0),
    lastAppliedAt: result.rows[0]?.last_applied_at || null,
    lastReconciledAt: result.rows[0]?.last_reconciled_at || null
  };
}

export async function initializeNetSuiteMirrorCursor(
  sequence,
  { scrub = false, lastReconciledAt = new Date().toISOString() } = {}
) {
  const safeSequence = Math.max(0, Number(sequence) || 0);
  if (scrub) {
    await query("DELETE FROM netsuite_tokens");
    await query("DELETE FROM operator_sessions");
    await query("TRUNCATE netsuite_mirror_inbox, netsuite_mirror_events");
  }
  await query(
    `INSERT INTO netsuite_mirror_state (state_key, state_value, updated_at)
     VALUES ('consumer_cursor', jsonb_build_object('sequence', $1::bigint, 'lastAppliedAt', now(), 'lastReconciledAt', $2::timestamptz), now())
     ON CONFLICT (state_key) DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = now()`,
    [safeSequence, lastReconciledAt]
  );
  await query(
    `INSERT INTO netsuite_mirror_state (state_key, state_value, updated_at)
     VALUES ('source_high_water', jsonb_build_object('sequence', $1::bigint, 'observedAt', now()), now())
     ON CONFLICT (state_key) DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = now()`,
    [safeSequence]
  );
  return getNetSuiteMirrorCursor();
}

export async function getNextNetSuiteMirrorInboxEvent() {
  const cursor = await getNetSuiteMirrorCursor();
  const result = await query(
    `SELECT * FROM netsuite_mirror_inbox
      WHERE source_sequence = $1
        AND status IN ('pending', 'failed')
      LIMIT 1`,
    [cursor.sequence + 1]
  );
  return { cursor, event: result.rows[0] || null };
}

export async function markNetSuiteMirrorInboxFailed(eventUuid, error) {
  await query(
    `UPDATE netsuite_mirror_inbox
        SET status = 'failed', attempts = attempts + 1, last_error = left($2, 2000), updated_at = now()
      WHERE event_uuid = $1`,
    [eventUuid, String(error || "Apply failed")]
  );
}

export async function markNetSuiteMirrorInboxApplied(event) {
  await query(
    `UPDATE netsuite_mirror_inbox
        SET status = 'applied', applied_at = now(), last_error = null, updated_at = now()
      WHERE event_uuid = $1`,
    [event.event_uuid]
  );
  await query(
    `INSERT INTO netsuite_mirror_state (state_key, state_value, updated_at)
     VALUES ('consumer_cursor', jsonb_build_object('sequence', $1::bigint, 'lastAppliedAt', now()), now())
     ON CONFLICT (state_key) DO UPDATE
       SET state_value = netsuite_mirror_state.state_value || EXCLUDED.state_value,
           updated_at = now()`,
    [event.source_sequence]
  );
}

export async function markMirroredOrderInactive(entityType, entityId) {
  const id = numericId(entityId);
  if (!id || !ORDER_ENTITY_TYPES.has(entityType)) return;
  const mapping = {
    sales_order: { table: "sales_orders", lineTable: "sales_order_lines", orderColumn: "sales_order_id" },
    purchase_order: { table: "purchase_orders", lineTable: "purchase_order_lines", orderColumn: "purchase_order_id" },
    transfer_order: { table: "transfer_orders", lineTable: "transfer_order_lines", orderColumn: "transfer_order_id" }
  }[entityType];
  await query(
    `UPDATE ${mapping.lineTable}
        SET netsuite_active = false, sync_exception = COALESCE(sync_exception, 'line_deleted'),
            sync_exception_at = COALESCE(sync_exception_at, now()), synced_at = now()
      WHERE ${mapping.orderColumn} = $1 AND netsuite_active = true`,
    [id]
  );
  await query(
    `UPDATE ${mapping.table}
        SET netsuite_active = false, netsuite_missing_at = COALESCE(netsuite_missing_at, now()), synced_at = now()
      WHERE netsuite_id = $1`,
    [id]
  );
}


export async function listNetSuiteMirrorManifest({ cursor = "", limit = 100, updatedAfter = null } = {}) {
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const parsedUpdatedAfter = updatedAfter && Number.isFinite(Date.parse(updatedAfter))
    ? new Date(updatedAfter).toISOString()
    : null;
  const result = await query(
    `WITH entities AS (
       SELECT 'sales_order'::text AS entity_type,
              netsuite_id::text AS entity_id,
              synced_at,
              'sales_order:' || lpad(netsuite_id::text, 24, '0') AS entity_key
         FROM sales_orders
        WHERE netsuite_id > 0
       UNION ALL
       SELECT 'purchase_order', netsuite_id::text, synced_at,
              'purchase_order:' || lpad(netsuite_id::text, 24, '0')
         FROM purchase_orders
        WHERE netsuite_id > 0
       UNION ALL
       SELECT 'transfer_order', netsuite_id::text, synced_at,
              'transfer_order:' || lpad(netsuite_id::text, 24, '0')
         FROM transfer_orders
        WHERE netsuite_id > 0
       UNION ALL
       SELECT 'inventory', item_id::text, synced_at,
              'inventory:' || lpad(item_id::text, 24, '0')
         FROM inventory_items
        WHERE item_id > 0
     )
     SELECT entity_type, entity_id, synced_at, entity_key
       FROM entities
      WHERE entity_key > $1
        AND ($2::timestamptz IS NULL OR synced_at >= $2::timestamptz)
      ORDER BY entity_key
      LIMIT $3`,
    [String(cursor || ""), parsedUpdatedAfter, safeLimit + 1]
  );
  const hasMore = result.rows.length > safeLimit;
  const rows = result.rows.slice(0, safeLimit);
  return {
    contract: "netsuite-mirror/v1",
    generatedAt: new Date().toISOString(),
    entities: rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      syncedAt: row.synced_at
    })),
    nextCursor: hasMore ? rows.at(-1)?.entity_key || "" : "",
    hasMore
  };
}

export async function markNetSuiteMirrorReconciled(at = new Date().toISOString()) {
  await query(
    `INSERT INTO netsuite_mirror_state (state_key, state_value, updated_at)
     VALUES ('consumer_cursor', jsonb_build_object('sequence', 0, 'lastReconciledAt', $1::timestamptz), now())
     ON CONFLICT (state_key) DO UPDATE
       SET state_value = netsuite_mirror_state.state_value || jsonb_build_object('lastReconciledAt', $1::timestamptz),
           updated_at = now()`,
    [at]
  );
}
export async function recordNetSuiteMirrorSourceHighWater(sequence) {
  const safeSequence = Math.max(0, Number(sequence) || 0);
  await query(
    `INSERT INTO netsuite_mirror_state (state_key, state_value, updated_at)
     VALUES ('source_high_water', jsonb_build_object('sequence', $1::bigint, 'observedAt', now()), now())
     ON CONFLICT (state_key) DO UPDATE
       SET state_value = jsonb_build_object(
             'sequence', GREATEST(COALESCE((netsuite_mirror_state.state_value->>'sequence')::bigint, 0), $1::bigint),
             'observedAt', now()
           ), updated_at = now()`,
    [safeSequence]
  );
}

export async function getNetSuiteMirrorStatus() {
  const [source, inbox, cursor, observedSource] = await Promise.all([
    query(
      `SELECT COALESCE(MAX(sequence_id), 0) AS high_water_sequence,
              COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
              MAX(delivered_at) AS last_delivered_at,
              MAX(last_error) FILTER (WHERE status = 'failed') AS last_error
         FROM netsuite_mirror_events`
    ),
    query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
              MAX(applied_at) AS last_applied_at,
              MAX(last_error) FILTER (WHERE status = 'failed') AS last_error
         FROM netsuite_mirror_inbox`
    ),
    getNetSuiteMirrorCursor(),
    query(
      `SELECT COALESCE((state_value->>'sequence')::bigint, 0) AS sequence
         FROM netsuite_mirror_state
        WHERE state_key = 'source_high_water'`
    )
  ]);
  const sourceRow = source.rows[0] || {};
  const inboxRow = inbox.rows[0] || {};
  const observedHighWater = Number(observedSource.rows[0]?.sequence || 0);
  const sourceHighWater = Math.max(Number(sourceRow.high_water_sequence || 0), observedHighWater);
  return {
    contract: "netsuite-mirror/v1",
    role: config.netSuiteMirror?.role || "disabled",
    configured: Boolean(config.netSuiteMirror?.sharedSecret),
    sourceUrlConfigured: Boolean(config.netSuiteMirror?.sourceBaseUrl),
    consumerUrlConfigured: Boolean(config.netSuiteMirror?.consumerBaseUrl),
    directNetSuiteAccessEnabled: Boolean(config.netsuite?.directAccessEnabled),
    source: {
      highWaterSequence: sourceHighWater,
      pending: Number(sourceRow.pending || 0),
      failed: Number(sourceRow.failed || 0),
      lastDeliveredAt: sourceRow.last_delivered_at || null,
      lastError: sourceRow.last_error || null
    },
    consumer: {
      appliedSequence: cursor.sequence,
      pending: Number(inboxRow.pending || 0),
      lag: Math.max(0, sourceHighWater - cursor.sequence),
      failed: Number(inboxRow.failed || 0),
      lastAppliedAt: cursor.lastAppliedAt || inboxRow.last_applied_at || null,
      lastError: inboxRow.last_error || null
    }
  };
}
