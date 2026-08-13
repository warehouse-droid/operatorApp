import { query, withTransaction } from "./db.js";
import {
  STOCK_REQUEST_YARDS,
  assertStockRequestDestinationAccess,
  groupStockRequestLinesForTransfer,
  normalizeStockRequestListLimit,
  normalizeStockRequestQuantity,
  normalizeStockRequestYardId,
  stockRequestAvailableQuantity,
  stockRequestBackorder,
  stockRequestBucket,
  stockRequestMemoMarker,
  stockRequestPalletQuantity
} from "./stock-request-domain.js";

const YARD_BY_LOCATION_ID = new Map(STOCK_REQUEST_YARDS.map((yard) => [yard.locationId, yard]));
const EDITABLE_LINE_STATUSES = new Set(["submitted", "changes_requested"]);
const TERMINAL_LINE_STATUSES = new Set(["received", "rejected", "cancelled", "closed"]);

function stockRequestError(message, status = 400, code = "STOCK_REQUEST_INVALID") {
  return Object.assign(new Error(message), { status, code });
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumeric(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredId(value, label = "record") {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw stockRequestError(`A valid ${label} ID is required.`);
  }
  return parsed;
}

function requiredRevision(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw stockRequestError("A positive expectedRevision is required.");
  }
  return parsed;
}

function sourceLocation(value, destinationLocationId) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || !YARD_BY_LOCATION_ID.has(parsed)) {
    throw stockRequestError("Select a supported source yard.");
  }
  if (parsed === Number(destinationLocationId)) {
    throw stockRequestError("Source yard and destination yard must be different.");
  }
  return parsed;
}

function cleanReason(value) {
  const reason = String(value || "").replace(/\s+/g, " ").trim();
  if (!reason) throw stockRequestError("A reason is required for this SCM decision.");
  if (reason.length > 1000) throw stockRequestError("The reason must be 1,000 characters or fewer.");
  return reason;
}

function cleanRemark(value) {
  const remark = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (remark.length > 2000) throw stockRequestError("The request remark must be 2,000 characters or fewer.");
  return remark;
}

function cleanSearch(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function optionalRequestDate(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw stockRequestError("Select a valid request date.");
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw stockRequestError("Select a valid request date.");
  }
  return normalized;
}

function optionalFilterYard(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || !YARD_BY_LOCATION_ID.has(parsed)) {
    throw stockRequestError(`Select a supported ${label} yard.`);
  }
  return parsed;
}

function addStockRequestListFilters({
  clauses,
  params,
  vendor,
  requestDate,
  sourceLocationId,
  destinationLocationId
}) {
  const normalizedVendor = cleanSearch(vendor);
  const normalizedDate = optionalRequestDate(requestDate);
  const normalizedSource = optionalFilterYard(sourceLocationId, "source");
  const normalizedDestination = optionalFilterYard(destinationLocationId, "destination");
  if (normalizedVendor) {
    params.push(normalizedVendor);
    clauses.push(`EXISTS (
      SELECT 1
        FROM sales_stock_request_lines vendor_line
        JOIN inventory_items vendor_item ON vendor_item.item_id = vendor_line.item_id
       WHERE vendor_line.request_id = request.id
         AND LOWER(BTRIM(COALESCE(vendor_item.vendor, ''))) = LOWER($${params.length})
    )`);
  }
  if (normalizedDate) {
    params.push(normalizedDate);
    clauses.push(`(request.created_at AT TIME ZONE 'America/Toronto')::date = $${params.length}::date`);
  }
  if (normalizedSource) {
    params.push(normalizedSource);
    clauses.push(`EXISTS (
      SELECT 1 FROM sales_stock_request_lines source_line
       WHERE source_line.request_id = request.id
         AND source_line.source_location_id = $${params.length}
    )`);
  }
  if (normalizedDestination) {
    params.push(normalizedDestination);
    clauses.push(`request.destination_location_id = $${params.length}`);
  }
}

function mapLine(row = {}) {
  return {
    id: Number(row.id),
    requestId: Number(row.request_id),
    itemId: Number(row.item_id),
    itemName: row.item_name || "",
    itemDescription: row.item_description || "",
    sourceLocationId: Number(row.source_location_id),
    sourceName: row.source_name || "",
    destinationLocationId: Number(row.destination_location_id),
    destinationName: row.destination_name || "",
    salesQty: numeric(row.sales_qty),
    salesUom: row.sales_uom || "",
    quantityMode: row.quantity_mode || "sales",
    pallets: nullableNumeric(row.pallet_qty),
    layers: nullableNumeric(row.layer_qty),
    sections: nullableNumeric(row.section_qty),
    pieces: nullableNumeric(row.piece_qty),
    toPlt: nullableNumeric(row.to_plt),
    toLyr: nullableNumeric(row.to_lyr),
    toSec: nullableNumeric(row.to_sec),
    toPcs: nullableNumeric(row.to_pcs),
    status: row.status || "submitted",
    decisionReason: row.decision_reason || "",
    decidedBy: row.decided_by || null,
    decidedAt: row.decided_at || null,
    resubmittedAt: row.resubmitted_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    transferId: row.transfer_id === null || row.transfer_id === undefined ? null : Number(row.transfer_id),
    transferRef: row.transfer_ref || null,
    netsuiteTransferOrderId: row.netsuite_transfer_order_id === null || row.netsuite_transfer_order_id === undefined
      ? null
      : Number(row.netsuite_transfer_order_id),
    netsuiteTransferOrderRef: row.netsuite_transfer_order_ref || null,
    driverCompleted: row.driver_completed === true,
    dispatchPlanned: row.dispatch_planned === true,
    dispatchPlanDate: row.dispatch_plan_date || null,
    dispatchTruckPlate: row.dispatch_truck_plate || null,
    dispatchLoadName: row.dispatch_load_name || null
  };
}

function mapTransfer(row = {}) {
  return {
    id: Number(row.id),
    transferRef: row.transfer_ref || "",
    requestId: Number(row.request_id),
    sourceLocationId: Number(row.source_location_id),
    sourceName: row.source_name || "",
    destinationLocationId: Number(row.destination_location_id),
    destinationName: row.destination_name || "",
    status: row.status || "pending_local",
    revision: Number(row.revision) || 1,
    palletItemId: row.pallet_item_id === null || row.pallet_item_id === undefined ? null : Number(row.pallet_item_id),
    palletItemName: row.pallet_item_name || null,
    palletQuantity: numeric(row.pallet_quantity),
    palletQuantityRequiresManual: row.pallet_quantity_requires_manual === true,
    palletQuantityManuallyAdjusted: row.pallet_quantity_manually_adjusted === true,
    netsuiteTransferOrderId: row.netsuite_transfer_order_id === null || row.netsuite_transfer_order_id === undefined
      ? null
      : Number(row.netsuite_transfer_order_id),
    netsuiteTransferOrderRef: row.netsuite_transfer_order_ref || null,
    netsuiteStatus: row.netsuite_status || null,
    netsuiteStatusText: row.netsuite_status_text || null,
    netsuiteUpdatedAt: row.netsuite_updated_at || null,
    confirmationStatus: row.confirmation_status || "idle",
    confirmationRequestId: row.confirmation_request_id || null,
    confirmationError: row.confirmation_error || null,
    revisionRequestId: row.revision_request_id || null,
    revisionError: row.revision_error || null,
    printGeneration: Number(row.print_generation) || 0,
    printJobId: row.print_job_id === null || row.print_job_id === undefined ? null : Number(row.print_job_id),
    printStatus: row.print_status || null,
    printInvalidatedAt: row.print_invalidated_at || null,
    confirmedAt: row.confirmed_at || null,
    dispatchPlanned: row.dispatch_planned === true,
    dispatchPlanDate: row.dispatch_plan_date || null,
    dispatchTruckPlate: row.dispatch_truck_plate || null,
    dispatchLoadName: row.dispatch_load_name || null,
    fulfillmentStatus: row.fulfillment_status || null,
    receivingStatus: row.receiving_status || null,
    receivedAt: row.received_at || null,
    driverCompleted: row.driver_completed === true,
    lines: []
  };
}

function mapRequest(row = {}) {
  return {
    id: Number(row.id),
    requestRef: row.request_ref || "",
    requestType: row.request_type || "regular",
    destinationLocationId: Number(row.destination_location_id),
    destinationName: row.destination_name || "",
    status: row.status || "submitted",
    revision: Number(row.revision) || 1,
    remarks: row.remarks || "",
    firstScmDecisionAt: row.first_scm_decision_at || null,
    requestedBy: row.requested_by || null,
    requestedByName: row.requested_by_name || row.requested_by || "",
    cancelledAt: row.cancelled_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    lines: [],
    transfers: [],
    availability: [],
    events: []
  };
}

function assertSalesScope(request, authorizedDestinationLocationIds) {
  if (!request) throw stockRequestError("Stock request was not found.", 404, "STOCK_REQUEST_NOT_FOUND");
  if (authorizedDestinationLocationIds === undefined) return;
  const allowed = new Set((authorizedDestinationLocationIds || []).map(Number));
  if (!allowed.has(Number(request.destination_location_id ?? request.destinationLocationId))) {
    throw stockRequestError("This stock request belongs to a destination yard outside your access.", 403, "STOCK_REQUEST_YARD_FORBIDDEN");
  }
}

async function lockRequest(requestId) {
  const result = await query(
    `SELECT request.*, operator.display_name AS requested_by_name
       FROM sales_stock_requests request
       LEFT JOIN operators operator ON operator.id = request.requested_by
      WHERE request.id = $1
      FOR UPDATE OF request`,
    [requiredId(requestId, "stock request")]
  );
  if (!result.rowCount) throw stockRequestError("Stock request was not found.", 404, "STOCK_REQUEST_NOT_FOUND");
  return result.rows[0];
}

async function requestLines(requestId, { forUpdate = false } = {}) {
  const result = await query(
    `SELECT line.*
       FROM sales_stock_request_lines line
      WHERE line.request_id = $1
      ORDER BY line.id
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [Number(requestId)]
  );
  return result.rows;
}

async function inventoryItems(itemIds, { forShare = false } = {}) {
  const ids = [...new Set((itemIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length) throw stockRequestError("At least one inventory item is required.");
  const result = await query(
    `SELECT item_id, item_name, display_name, item_description, stock_unit, vendor,
            to_plt, to_lyr, to_sec, to_pcs
       FROM inventory_items
      WHERE item_id = ANY($1::bigint[])
      ${forShare ? "FOR SHARE" : ""}`,
    [ids]
  );
  if (result.rowCount !== ids.length) throw stockRequestError("One or more inventory items were not found.", 404, "STOCK_REQUEST_ITEM_NOT_FOUND");
  return new Map(result.rows.map((row) => [Number(row.item_id), row]));
}

async function activeReservationTotals(itemIds = [], locationIds = []) {
  const items = [...new Set(itemIds.map(Number))];
  const locations = [...new Set(locationIds.map(Number))];
  if (!items.length || !locations.length) return new Map();
  const result = await query(
    `SELECT item_id, source_location_id, SUM(quantity)::numeric AS reserved
       FROM (
         SELECT item_id, source_location_id, reserved_sales_quantity AS quantity
           FROM sales_stock_transfer_reservations
          WHERE status = 'active'
            AND item_id = ANY($1::bigint[])
            AND source_location_id = ANY($2::bigint[])
         UNION ALL
         SELECT item_id, source_location_id, reserved_sales_quantity AS quantity
           FROM scm_smart_inventory_reservations
          WHERE status = 'active'
            AND item_id = ANY($1::bigint[])
            AND source_location_id = ANY($2::bigint[])
       ) reservation
      GROUP BY item_id, source_location_id`,
    [items, locations]
  );
  return new Map(result.rows.map((row) => [`${row.item_id}:${row.source_location_id}`, numeric(row.reserved)]));
}

async function assertCachedAvailability(lines, { allowOverAvailability = false } = {}) {
  const pairs = new Map();
  for (const line of lines) {
    const key = `${line.itemId}:${line.sourceLocationId}`;
    pairs.set(key, (pairs.get(key) || 0) + line.salesQty);
  }
  const itemIds = [...new Set(lines.map((line) => line.itemId))];
  const locationIds = [...new Set(lines.map((line) => line.sourceLocationId))];
  const balanceResult = await query(
    `SELECT item_id, location_id, quantity_available, synced_at
       FROM inventory_balances
      WHERE item_id = ANY($1::bigint[])
        AND location_id = ANY($2::bigint[])`,
    [itemIds, locationIds]
  );
  const reservations = await activeReservationTotals(itemIds, locationIds);
  const balances = new Map(balanceResult.rows.map((row) => [`${row.item_id}:${row.location_id}`, row]));
  for (const [key, requested] of pairs) {
    const balance = balances.get(key);
    if (!balance) throw stockRequestError("Inventory availability is not loaded for a selected source yard.", 409, "STOCK_REQUEST_AVAILABILITY_MISSING");
    const available = stockRequestAvailableQuantity({
      liveAvailable: balance.quantity_available,
      activeReserved: reservations.get(key) || 0
    });
    if (allowOverAvailability !== true && requested > available + 1e-9) {
      throw stockRequestError(
        `Requested quantity ${requested} exceeds requestable availability ${available}.`,
        409,
        "STOCK_REQUEST_AVAILABILITY_EXCEEDED"
      );
    }
  }
}

function normalizeLineInput(input, item, destinationLocationId) {
  const normalizedDestinationLocationId = normalizeStockRequestYardId(destinationLocationId, "destination yard");
  const sourceLocationId = sourceLocation(input.sourceLocationId, normalizedDestinationLocationId);
  const quantity = normalizeStockRequestQuantity(input, {
    stockUnit: item.stock_unit,
    toPlt: item.to_plt,
    toLyr: item.to_lyr,
    toSec: item.to_sec,
    toPcs: item.to_pcs
  });
  return {
    id: input.id === undefined || input.id === null ? null : requiredId(input.id, "stock-request line"),
    itemId: Number(item.item_id),
    itemName: item.item_name || item.display_name || String(item.item_id),
    itemDescription: item.item_description || "",
    sourceLocationId,
    sourceName: YARD_BY_LOCATION_ID.get(sourceLocationId).yardCode,
    destinationLocationId: normalizedDestinationLocationId,
    destinationName: YARD_BY_LOCATION_ID.get(normalizedDestinationLocationId).yardCode,
    salesQty: quantity.salesQty,
    salesUom: quantity.salesUom,
    quantityMode: quantity.mode,
    pallets: quantity.pallets,
    layers: quantity.layers,
    sections: quantity.sections,
    pieces: quantity.pieces,
    toPlt: nullableNumeric(item.to_plt),
    toLyr: nullableNumeric(item.to_lyr),
    toSec: nullableNumeric(item.to_sec),
    toPcs: nullableNumeric(item.to_pcs)
  };
}

async function normalizeLines(lines, destinationLocationId, { allowOverAvailability = false } = {}) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) {
    throw stockRequestError("A stock request requires between 1 and 100 lines.");
  }
  const items = await inventoryItems(lines.map((line) => line.itemId), { forShare: true });
  const normalized = lines.map((line) => {
    const item = items.get(Number(line.itemId));
    if (!item) throw stockRequestError("Inventory item was not found.", 404, "STOCK_REQUEST_ITEM_NOT_FOUND");
    return normalizeLineInput(line, item, destinationLocationId);
  });
  await assertCachedAvailability(normalized, { allowOverAvailability });
  return normalized;
}

async function insertLine(requestId, line, { status = "submitted" } = {}) {
  const result = await query(
    `INSERT INTO sales_stock_request_lines (
       request_id, item_id, item_name, item_description,
       source_location_id, source_name, destination_location_id, destination_name,
       sales_qty, sales_uom, quantity_mode,
       pallet_qty, layer_qty, section_qty, piece_qty,
       to_plt, to_lyr, to_sec, to_pcs, status
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
       $12,$13,$14,$15,$16,$17,$18,$19,$20
     ) RETURNING *`,
    [
      requestId, line.itemId, line.itemName, line.itemDescription,
      line.sourceLocationId, line.sourceName, line.destinationLocationId, line.destinationName,
      line.salesQty, line.salesUom, line.quantityMode,
      line.pallets, line.layers, line.sections, line.pieces,
      line.toPlt, line.toLyr, line.toSec, line.toPcs, status
    ]
  );
  return result.rows[0];
}

async function recordEvent({ requestId, requestLineId = null, transferId = null, eventType, actorId = null, details = {} }) {
  await query(
    `INSERT INTO sales_stock_request_events (
       request_id, request_line_id, transfer_id, event_type, actor_id, details
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [requestId, requestLineId, transferId, eventType, actorId || null, JSON.stringify(details || {})]
  );
}

async function requestDetailRows(requestId) {
  const requestResult = await query(
    `SELECT request.*, operator.display_name AS requested_by_name
       FROM sales_stock_requests request
       LEFT JOIN operators operator ON operator.id = request.requested_by
      WHERE request.id = $1`,
    [Number(requestId)]
  );
  if (!requestResult.rowCount) return null;
  const request = mapRequest(requestResult.rows[0]);
  const lineResult = await query(
      `SELECT line.*,
              transfer.id AS transfer_id,
              transfer.transfer_ref,
              transfer.netsuite_transfer_order_id,
              transfer.netsuite_transfer_order_ref,
              canonical.dispatch_planned,
              canonical.dispatch_plan_date,
              canonical.dispatch_truck_plate,
              canonical.dispatch_load_name,
              CASE
                WHEN transfer.netsuite_transfer_order_ref IS NULL THEN false
                ELSE EXISTS (
                  SELECT 1
                    FROM driver_job_records job
                   WHERE LOWER(BTRIM(COALESCE(job.status, ''))) IN ('complete', 'completed')
                     AND job.order_refs ? transfer.netsuite_transfer_order_ref
                )
              END AS driver_completed
         FROM sales_stock_request_lines line
         LEFT JOIN sales_stock_transfer_lines transfer_line ON transfer_line.request_line_id = line.id
         LEFT JOIN sales_stock_transfers transfer ON transfer.id = transfer_line.transfer_id
         LEFT JOIN transfer_orders canonical ON canonical.netsuite_id = transfer.netsuite_transfer_order_id
        WHERE line.request_id = $1
        ORDER BY line.id`,
      [request.id]
    );
  const transferResult = await query(
      `SELECT transfer.*,
              print_job.status AS print_status,
              canonical.dispatch_planned,
              canonical.dispatch_plan_date,
              canonical.dispatch_truck_plate,
              canonical.dispatch_load_name,
              canonical.fulfillment_status,
              canonical.receiving_status,
              canonical.received_at,
              CASE
                WHEN transfer.netsuite_transfer_order_ref IS NULL THEN false
                ELSE EXISTS (
                  SELECT 1
                    FROM driver_job_records job
                   WHERE LOWER(BTRIM(COALESCE(job.status, ''))) IN ('complete', 'completed')
                     AND job.order_refs ? transfer.netsuite_transfer_order_ref
                )
              END AS driver_completed
         FROM sales_stock_transfers transfer
         LEFT JOIN scm_print_jobs print_job ON print_job.id = transfer.print_job_id
         LEFT JOIN transfer_orders canonical ON canonical.netsuite_id = transfer.netsuite_transfer_order_id
        WHERE transfer.request_id = $1
        ORDER BY transfer.id`,
      [request.id]
    );
  const eventResult = await query(
      `SELECT event.*, operator.display_name AS actor_name
         FROM sales_stock_request_events event
         LEFT JOIN operators operator ON operator.id = event.actor_id
        WHERE event.request_id = $1
        ORDER BY event.created_at DESC, event.id DESC
        LIMIT 100`,
      [request.id]
    );
  request.lines = lineResult.rows.map(mapLine);
  request.transfers = transferResult.rows.map(mapTransfer);
  const transferLines = new Map();
  for (const line of request.lines) {
    if (!line.transferId) continue;
    if (!transferLines.has(line.transferId)) transferLines.set(line.transferId, []);
    transferLines.get(line.transferId).push(line);
  }
  for (const transfer of request.transfers) transfer.lines = transferLines.get(transfer.id) || [];
  request.events = eventResult.rows.map((row) => ({
    id: Number(row.id),
    eventType: row.event_type,
    requestLineId: row.request_line_id === null ? null : Number(row.request_line_id),
    transferId: row.transfer_id === null ? null : Number(row.transfer_id),
    actorId: row.actor_id || null,
    actorName: row.actor_name || row.actor_id || "System",
    details: row.details || {},
    createdAt: row.created_at
  }));
  request.bucket = stockRequestBucket(request);
  return request;
}

export async function searchStockRequestItems({ search = "", limit = 30 } = {}) {
  const normalized = cleanSearch(search);
  if (normalized.length < 2) return [];
  const boundedLimit = normalizeStockRequestListLimit(limit, { defaultLimit: 30, maximum: 50 });
  const result = await query(
    `SELECT item_id, item_name, display_name, item_description, stock_unit, vendor,
            to_plt, to_lyr, to_sec, to_pcs, synced_at
       FROM inventory_items
      WHERE item_name ILIKE $1 ESCAPE '\\'
         OR COALESCE(display_name, '') ILIKE $1 ESCAPE '\\'
         OR COALESCE(item_description, '') ILIKE $1 ESCAPE '\\'
      ORDER BY CASE WHEN LOWER(item_name) = LOWER($2) THEN 0
                    WHEN LOWER(item_name) LIKE LOWER($2) || '%' THEN 1
                    ELSE 2 END,
               item_name
      LIMIT $3`,
    [`%${normalized.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, normalized, boundedLimit]
  );
  return result.rows.map((row) => ({
    itemId: Number(row.item_id),
    itemCode: row.item_name,
    displayName: row.display_name || row.item_name,
    description: row.item_description || "",
    vendor: row.vendor || "",
    salesUom: row.stock_unit || "",
    toPlt: nullableNumeric(row.to_plt),
    toLyr: nullableNumeric(row.to_lyr),
    toSec: nullableNumeric(row.to_sec),
    toPcs: nullableNumeric(row.to_pcs),
    syncedAt: row.synced_at || null
  }));
}

export async function getStockRequestItemAvailability(itemId) {
  const id = requiredId(itemId, "inventory item");
  const items = await inventoryItems([id]);
  const item = items.get(id);
  const locationIds = STOCK_REQUEST_YARDS.map((yard) => yard.locationId);
  const [balanceResult, reservations] = await Promise.all([
    query(
      `SELECT location_id, location, quantity_on_hand, quantity_available, synced_at
         FROM inventory_balances
        WHERE item_id = $1
          AND location_id = ANY($2::bigint[])`,
      [id, locationIds]
    ),
    activeReservationTotals([id], locationIds)
  ]);
  const balanceByLocation = new Map(balanceResult.rows.map((row) => [Number(row.location_id), row]));
  return {
    item: {
      itemId: id,
      itemCode: item.item_name,
      displayName: item.display_name || item.item_name,
      description: item.item_description || "",
      vendor: item.vendor || "",
      salesUom: item.stock_unit || "",
      toPlt: nullableNumeric(item.to_plt),
      toLyr: nullableNumeric(item.to_lyr),
      toSec: nullableNumeric(item.to_sec),
      toPcs: nullableNumeric(item.to_pcs)
    },
    yards: STOCK_REQUEST_YARDS.map((yard) => {
      const balance = balanceByLocation.get(yard.locationId);
      const activeReserved = reservations.get(`${id}:${yard.locationId}`) || 0;
      const liveAvailable = numeric(balance?.quantity_available);
      return {
        locationId: yard.locationId,
        yardCode: yard.yardCode,
        onHand: numeric(balance?.quantity_on_hand),
        liveAvailable,
        activeReserved,
        requestableAvailable: stockRequestAvailableQuantity({ liveAvailable, activeReserved }),
        syncedAt: balance?.synced_at || null
      };
    })
  };
}

export async function createSalesStockRequest(input = {}, {
  operatorId,
  authorizedDestinationLocationIds,
  allowOverAvailability = false
} = {}) {
  if (!operatorId) throw stockRequestError("A staff Sales operator is required.", 403);
  return withTransaction(async () => {
    const destinationLocationId = assertStockRequestDestinationAccess(
      input.destinationLocationId,
      authorizedDestinationLocationIds
    );
    const remarks = cleanRemark(input.remarks);
    const lines = await normalizeLines(input.lines, destinationLocationId, { allowOverAvailability });
    const inserted = await query(
      `INSERT INTO sales_stock_requests (
         destination_location_id, destination_name, requested_by, remarks
       ) VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [destinationLocationId, YARD_BY_LOCATION_ID.get(destinationLocationId).yardCode, operatorId, remarks]
    );
    const request = inserted.rows[0];
    for (const line of lines) await insertLine(request.id, line);
    await recordEvent({
      requestId: request.id,
      eventType: "request_submitted",
      actorId: operatorId,
      details: {
        lineCount: lines.length,
        destinationLocationId,
        allowOverAvailability: allowOverAvailability === true
      }
    });
    return requestDetailRows(request.id);
  });
}

export async function getSalesStockRequest(requestId, { authorizedDestinationLocationIds } = {}) {
  const detail = await requestDetailRows(requiredId(requestId, "stock request"));
  if (!detail) throw stockRequestError("Stock request was not found.", 404, "STOCK_REQUEST_NOT_FOUND");
  assertSalesScope(detail, authorizedDestinationLocationIds);
  const itemIds = [...new Set(detail.lines.map((line) => line.itemId))];
  detail.availability = await Promise.all(itemIds.map(getStockRequestItemAvailability));
  return detail;
}

export async function listSalesStockRequests({
  authorizedDestinationLocationIds,
  bucket = "",
  search = "",
  vendor = "",
  requestDate = "",
  sourceLocationId = "",
  limit = 40,
  offset = 0
} = {}) {
  const yards = [...new Set((authorizedDestinationLocationIds || []).map(Number).filter((id) => YARD_BY_LOCATION_ID.has(id)))];
  if (!yards.length) return [];
  const requestedBucket = String(bucket || "").trim().toLowerCase();
  if (requestedBucket && !["pending", "accepted", "completed"].includes(requestedBucket)) {
    throw stockRequestError("Sales stock-request bucket must be Pending, Accepted, or Completed.");
  }
  const normalizedSearch = cleanSearch(search);
  const boundedLimit = normalizeStockRequestListLimit(limit);
  const boundedOffset = Math.min(Math.max(Math.trunc(Number(offset)) || 0, 0), 10_000);
  const params = [yards];
  const clauses = ["request.destination_location_id = ANY($1::bigint[])"];
  if (requestedBucket === "pending") {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM sales_stock_transfers bucket_transfer
       WHERE bucket_transfer.request_id = request.id
    )`);
    clauses.push(`EXISTS (
      SELECT 1 FROM sales_stock_request_lines bucket_line
       WHERE bucket_line.request_id = request.id
         AND bucket_line.status IN ('submitted', 'changes_requested')
    )`);
  } else if (requestedBucket === "accepted") {
    clauses.push(`EXISTS (
      SELECT 1 FROM sales_stock_transfers bucket_transfer
       WHERE bucket_transfer.request_id = request.id
         AND (
           bucket_transfer.status <> 'cancelled'
           OR bucket_transfer.netsuite_transfer_order_id IS NOT NULL
         )
    )`);
  } else if (requestedBucket === "completed") {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM sales_stock_request_lines bucket_line
       WHERE bucket_line.request_id = request.id
         AND bucket_line.status NOT IN ('received', 'rejected', 'cancelled', 'closed')
    )`);
  }
  if (normalizedSearch) {
    params.push(`%${normalizedSearch}%`);
    clauses.push(`(request.request_ref ILIKE $${params.length} OR EXISTS (
      SELECT 1 FROM sales_stock_request_lines search_line
       WHERE search_line.request_id = request.id
         AND (search_line.item_name ILIKE $${params.length} OR search_line.item_description ILIKE $${params.length})
    ))`);
  }
  addStockRequestListFilters({
    clauses,
    params,
    vendor,
    requestDate,
    sourceLocationId,
    destinationLocationId: null
  });
  params.push(Math.min(200, boundedLimit * 3), boundedOffset);
  const result = await query(
    `SELECT request.*, operator.display_name AS requested_by_name
       FROM sales_stock_requests request
       LEFT JOIN operators operator ON operator.id = request.requested_by
      WHERE ${clauses.join(" AND ")}
      ORDER BY EXISTS (
        SELECT 1 FROM sales_stock_request_lines priority_line
         WHERE priority_line.request_id = request.id
           AND priority_line.status = 'changes_requested'
      ) DESC,
      request.updated_at DESC, request.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  const details = await Promise.all(result.rows.map((row) => requestDetailRows(row.id)));
  return details.filter((detail) => !requestedBucket
    || detail.bucket === requestedBucket
    || requestedBucket === "accepted").slice(0, boundedLimit);
}

export async function updateSalesStockRequest(requestId, input = {}, {
  operatorId,
  authorizedDestinationLocationIds,
  allowOverAvailability = false
} = {}) {
  return withTransaction(async () => {
    const request = await lockRequest(requestId);
    assertSalesScope(request, authorizedDestinationLocationIds);
    const expected = requiredRevision(input.expectedRevision);
    if (Number(request.revision) !== expected) {
      throw stockRequestError("This stock request changed after the screen loaded. Reload and try again.", 409, "STOCK_REQUEST_REVISION_CONFLICT");
    }
    if (request.status === "cancelled" || request.status === "completed") {
      throw stockRequestError("This stock request is no longer editable.", 409, "STOCK_REQUEST_LOCKED");
    }
    const existing = await requestLines(request.id, { forUpdate: true });
    const hasDecision = Boolean(request.first_scm_decision_at);
    const destinationLocationId = hasDecision
      ? Number(request.destination_location_id)
      : assertStockRequestDestinationAccess(
        input.destinationLocationId ?? request.destination_location_id,
        authorizedDestinationLocationIds
      );
    const normalized = await normalizeLines(input.lines, destinationLocationId, { allowOverAvailability });
    const existingById = new Map(existing.map((line) => [Number(line.id), line]));
    if (hasDecision) {
      for (const line of normalized) {
        const current = existingById.get(line.id);
        if (!current || current.status !== "changes_requested") {
          throw stockRequestError("Only lines returned by SCM can be edited after an SCM decision.", 409, "STOCK_REQUEST_LINE_LOCKED");
        }
      }
    }
    const touched = new Set();
    for (const line of normalized) {
      if (!line.id) {
        await insertLine(request.id, line);
        continue;
      }
      const current = existingById.get(line.id);
      if (!current) throw stockRequestError("A submitted stock-request line was not found.", 404);
      touched.add(line.id);
      await query(
        `UPDATE sales_stock_request_lines
            SET item_id = $3, item_name = $4, item_description = $5,
                source_location_id = $6, source_name = $7,
                destination_location_id = $8, destination_name = $9,
                sales_qty = $10, sales_uom = $11, quantity_mode = $12,
                pallet_qty = $13, layer_qty = $14, section_qty = $15, piece_qty = $16,
                to_plt = $17, to_lyr = $18, to_sec = $19, to_pcs = $20,
                updated_at = now()
          WHERE id = $1 AND request_id = $2`,
        [
          line.id, request.id, line.itemId, line.itemName, line.itemDescription,
          line.sourceLocationId, line.sourceName, line.destinationLocationId, line.destinationName,
          line.salesQty, line.salesUom, line.quantityMode,
          line.pallets, line.layers, line.sections, line.pieces,
          line.toPlt, line.toLyr, line.toSec, line.toPcs
        ]
      );
    }
    if (!hasDecision) {
      const removed = existing.filter((line) => !touched.has(Number(line.id))).map((line) => Number(line.id));
      if (removed.length) await query("DELETE FROM sales_stock_request_lines WHERE id = ANY($1::bigint[])", [removed]);
    }
    const remarks = hasDecision ? (request.remarks || "") : cleanRemark(input.remarks ?? request.remarks);
    await query(
      `UPDATE sales_stock_requests
          SET destination_location_id = $2, destination_name = $3,
              remarks = $4,
              revision = revision + 1, updated_at = now()
        WHERE id = $1`,
      [request.id, destinationLocationId, YARD_BY_LOCATION_ID.get(destinationLocationId).yardCode, remarks]
    );
    await recordEvent({
      requestId: request.id,
      eventType: "request_edited",
      actorId: operatorId,
      details: {
        previousRevision: expected,
        returnedLinesOnly: hasDecision,
        allowOverAvailability: allowOverAvailability === true
      }
    });
    return requestDetailRows(request.id);
  });
}

export async function cancelSalesStockRequest(requestId, input = {}, {
  operatorId,
  authorizedDestinationLocationIds
} = {}) {
  return withTransaction(async () => {
    const request = await lockRequest(requestId);
    assertSalesScope(request, authorizedDestinationLocationIds);
    const expected = requiredRevision(input.expectedRevision);
    if (Number(request.revision) !== expected) {
      throw stockRequestError("This stock request changed after the screen loaded. Reload and try again.", 409, "STOCK_REQUEST_REVISION_CONFLICT");
    }
    if (request.first_scm_decision_at) {
      throw stockRequestError("A stock request cannot be cancelled after the first SCM decision.", 409, "STOCK_REQUEST_LOCKED");
    }
    if (request.status !== "submitted") throw stockRequestError("This stock request cannot be cancelled.", 409);
    await query(
      `UPDATE sales_stock_requests
          SET status = 'cancelled', revision = revision + 1,
              cancelled_by = $2, cancelled_at = now(), updated_at = now()
        WHERE id = $1`,
      [request.id, operatorId]
    );
    await query(
      `UPDATE sales_stock_request_lines
          SET status = 'cancelled', updated_at = now()
        WHERE request_id = $1 AND status IN ('submitted', 'changes_requested')`,
      [request.id]
    );
    await recordEvent({ requestId: request.id, eventType: "request_cancelled", actorId: operatorId });
    return requestDetailRows(request.id);
  });
}

export async function resubmitSalesStockRequest(requestId, input = {}, {
  operatorId,
  authorizedDestinationLocationIds
} = {}) {
  return withTransaction(async () => {
    const request = await lockRequest(requestId);
    assertSalesScope(request, authorizedDestinationLocationIds);
    const expected = requiredRevision(input.expectedRevision);
    if (Number(request.revision) !== expected) {
      throw stockRequestError("This stock request changed after the screen loaded. Reload and try again.", 409, "STOCK_REQUEST_REVISION_CONFLICT");
    }
    const updated = await query(
      `UPDATE sales_stock_request_lines
          SET status = 'submitted', resubmitted_at = now(), updated_at = now()
        WHERE request_id = $1 AND status = 'changes_requested'
        RETURNING id`,
      [request.id]
    );
    if (!updated.rowCount) throw stockRequestError("This request has no returned lines to resubmit.", 409);
    await query(
      `UPDATE sales_stock_requests
          SET status = 'active', revision = revision + 1, updated_at = now()
        WHERE id = $1`,
      [request.id]
    );
    await recordEvent({
      requestId: request.id,
      eventType: "request_resubmitted",
      actorId: operatorId,
      details: { lineIds: updated.rows.map((row) => Number(row.id)) }
    });
    return requestDetailRows(request.id);
  });
}

async function updateStoredRequestStatus(requestId) {
  const result = await query(
    `SELECT status FROM sales_stock_request_lines WHERE request_id = $1`,
    [requestId]
  );
  const statuses = result.rows.map((row) => row.status);
  const status = statuses.length && statuses.every((lineStatus) => TERMINAL_LINE_STATUSES.has(lineStatus))
    ? "completed"
    : statuses.some((lineStatus) => lineStatus === "converted")
      ? "active"
      : "active";
  await query("UPDATE sales_stock_requests SET status = $2, updated_at = now() WHERE id = $1", [requestId, status]);
  return status;
}

export async function decideSalesStockRequestLines(requestId, input = {}, { operatorId } = {}) {
  return withTransaction(async () => {
    const request = await lockRequest(requestId);
    const expected = requiredRevision(input.expectedRevision);
    if (Number(request.revision) !== expected) {
      throw stockRequestError("This stock request changed after the screen loaded. Reload and try again.", 409, "STOCK_REQUEST_REVISION_CONFLICT");
    }
    const decision = String(input.decision || "").trim().toLowerCase();
    if (!new Set(["reject", "request_changes"]).has(decision)) {
      throw stockRequestError("SCM decision must be Reject or Request Changes.");
    }
    const reason = cleanReason(input.reason);
    const lineIds = [...new Set((input.lineIds || []).map((id) => requiredId(id, "stock-request line")))];
    if (!lineIds.length) throw stockRequestError("Select at least one stock-request line.");
    const locked = await query(
      `SELECT * FROM sales_stock_request_lines
        WHERE request_id = $1 AND id = ANY($2::bigint[])
        FOR UPDATE`,
      [request.id, lineIds]
    );
    const allowedStatuses = decision === "reject"
      ? new Set(["submitted", "changes_requested"])
      : new Set(["submitted"]);
    if (locked.rowCount !== lineIds.length || locked.rows.some((line) => !allowedStatuses.has(line.status))) {
      throw stockRequestError(
        decision === "reject"
          ? "Only submitted or returned lines can be rejected."
          : "Only currently submitted lines can be returned for changes.",
        409,
        "STOCK_REQUEST_LINE_LOCKED"
      );
    }
    const nextStatus = decision === "reject" ? "rejected" : "changes_requested";
    await query(
      `UPDATE sales_stock_request_lines
          SET status = $3, decision_reason = $4, decided_by = $5,
              decided_at = now(), updated_at = now()
        WHERE request_id = $1 AND id = ANY($2::bigint[])`,
      [request.id, lineIds, nextStatus, reason, operatorId]
    );
    await query(
      `UPDATE sales_stock_requests
          SET revision = revision + 1,
              first_scm_decision_at = COALESCE(first_scm_decision_at, now()),
              updated_at = now()
        WHERE id = $1`,
      [request.id]
    );
    await updateStoredRequestStatus(request.id);
    await recordEvent({
      requestId: request.id,
      eventType: decision === "reject" ? "lines_rejected" : "changes_requested",
      actorId: operatorId,
      details: { lineIds, reason }
    });
    return requestDetailRows(request.id);
  });
}

async function lockInventoryPairs(lines) {
  const pairs = [...new Map(lines.map((line) => [
    `${line.item_id}:${line.source_location_id}`,
    { itemId: Number(line.item_id), sourceLocationId: Number(line.source_location_id) }
  ])).values()].sort((left, right) => left.itemId - right.itemId || left.sourceLocationId - right.sourceLocationId);
  for (const pair of pairs) {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`stock-request:${pair.itemId}:${pair.sourceLocationId}`]);
  }
  return pairs;
}

async function conversionAvailabilitySnapshot(lines, { ownReservations = new Map() } = {}) {
  const pairs = await lockInventoryPairs(lines);
  const requested = new Map();
  for (const line of lines) {
    const key = `${line.item_id}:${line.source_location_id}`;
    requested.set(key, (requested.get(key) || 0) + numeric(line.sales_qty));
  }
  const itemIds = [...new Set(pairs.map((pair) => pair.itemId))];
  const locationIds = [...new Set(pairs.map((pair) => pair.sourceLocationId))];
  const balanceResult = await query(
    `SELECT item_id, location_id, quantity_available
       FROM inventory_balances
      WHERE item_id = ANY($1::bigint[])
        AND location_id = ANY($2::bigint[])
      FOR UPDATE`,
    [itemIds, locationIds]
  );
  const reservations = await activeReservationTotals(itemIds, locationIds);
  const balances = new Map(balanceResult.rows.map((row) => [`${row.item_id}:${row.location_id}`, numeric(row.quantity_available)]));
  const snapshot = [];
  for (const pair of pairs) {
    const key = `${pair.itemId}:${pair.sourceLocationId}`;
    if (!balances.has(key)) throw stockRequestError("Live inventory is missing for a selected route.", 409, "STOCK_REQUEST_AVAILABILITY_MISSING");
    const backorder = stockRequestBackorder({
      requestedQuantity: requested.get(key) || 0,
      liveAvailable: balances.get(key),
      activeReserved: reservations.get(key) || 0,
      ownReserved: ownReservations.get(key) || 0
    });
    snapshot.push({
      itemId: pair.itemId,
      sourceLocationId: pair.sourceLocationId,
      requestedSalesQty: backorder.requestedQuantity,
      requestableAvailable: backorder.requestableAvailable,
      backorderSalesQty: backorder.backorderQuantity
    });
  }
  return snapshot;
}

async function localPalletItem() {
  const result = await query(
    `SELECT item_id, item_name
       FROM inventory_items
      WHERE UPPER(BTRIM(item_name)) = 'PALLET'
         OR UPPER(BTRIM(COALESCE(display_name, ''))) = 'PALLET'
      ORDER BY CASE WHEN UPPER(BTRIM(item_name)) = 'PALLET' THEN 0 ELSE 1 END, item_id
      LIMIT 1`
  );
  return result.rows[0] || null;
}

export async function convertSalesStockRequestLines(requestId, input = {}, { operatorId } = {}) {
  return withTransaction(async () => {
    const request = await lockRequest(requestId);
    const expected = requiredRevision(input.expectedRevision);
    if (Number(request.revision) !== expected) {
      throw stockRequestError("This stock request changed after the screen loaded. Reload and try again.", 409, "STOCK_REQUEST_REVISION_CONFLICT");
    }
    const lineIds = [...new Set((input.lineIds || []).map((id) => requiredId(id, "stock-request line")))];
    if (!lineIds.length) throw stockRequestError("Select at least one stock-request line to convert.");
    const locked = await query(
      `SELECT * FROM sales_stock_request_lines
        WHERE request_id = $1 AND id = ANY($2::bigint[])
        ORDER BY id
        FOR UPDATE`,
      [request.id, lineIds]
    );
    if (locked.rowCount !== lineIds.length || locked.rows.some((line) => !EDITABLE_LINE_STATUSES.has(line.status))) {
      throw stockRequestError("Only submitted or returned lines can be converted.", 409, "STOCK_REQUEST_LINE_LOCKED");
    }
    const availability = await conversionAvailabilitySnapshot(locked.rows);
    const groups = groupStockRequestLinesForTransfer(locked.rows.map((line) => ({
      ...line,
      id: Number(line.id),
      sourceLocationId: Number(line.source_location_id),
      destinationLocationId: Number(line.destination_location_id)
    })));
    const palletItem = await localPalletItem();
    const transfers = [];
    for (const group of groups) {
      const pallet = stockRequestPalletQuantity(group.lines);
      const transferResult = await query(
        `INSERT INTO sales_stock_transfers (
           request_id, source_location_id, source_name,
           destination_location_id, destination_name,
           pallet_item_id, pallet_item_name, pallet_quantity,
           pallet_quantity_requires_manual, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          request.id,
          group.sourceLocationId,
          YARD_BY_LOCATION_ID.get(group.sourceLocationId).yardCode,
          group.destinationLocationId,
          YARD_BY_LOCATION_ID.get(group.destinationLocationId).yardCode,
          palletItem?.item_id || null,
          palletItem?.item_name || null,
          pallet.automaticQuantity,
          pallet.requiresManualQuantity,
          operatorId
        ]
      );
      const transfer = transferResult.rows[0];
      for (const line of group.lines) {
        const insertedLine = await query(
          `INSERT INTO sales_stock_transfer_lines (
             transfer_id, request_line_id, item_id, item_name,
             sales_qty, sales_uom, quantity_mode,
             pallet_qty, layer_qty, section_qty, piece_qty,
             to_plt, to_lyr, to_sec, to_pcs
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
           ) RETURNING id`,
          [
            transfer.id, line.id, line.item_id, line.item_name,
            line.sales_qty, line.sales_uom, line.quantity_mode,
            line.pallet_qty, line.layer_qty, line.section_qty, line.piece_qty,
            line.to_plt, line.to_lyr, line.to_sec, line.to_pcs
          ]
        );
        await query(
          `INSERT INTO sales_stock_transfer_reservations (
             transfer_line_id, item_id, source_location_id, reserved_sales_quantity
           ) VALUES ($1,$2,$3,$4)`,
          [insertedLine.rows[0].id, line.item_id, line.source_location_id, line.sales_qty]
        );
        await query(
          `UPDATE sales_stock_request_lines
              SET status = 'converted', decided_by = $2,
                  decided_at = COALESCE(decided_at, now()), updated_at = now()
            WHERE id = $1`,
          [line.id, operatorId]
        );
      }
      await recordEvent({
        requestId: request.id,
        transferId: transfer.id,
        eventType: "local_transfer_created",
        actorId: operatorId,
        details: {
          transferRef: transfer.transfer_ref,
          lineIds: group.lines.map((line) => Number(line.id)),
          sourceLocationId: group.sourceLocationId,
          destinationLocationId: group.destinationLocationId,
          marker: stockRequestMemoMarker(transfer.id),
          availability: availability.filter((entry) => entry.sourceLocationId === group.sourceLocationId
            && group.lines.some((line) => Number(line.item_id) === entry.itemId)),
          backorderSalesQty: availability
            .filter((entry) => entry.sourceLocationId === group.sourceLocationId
              && group.lines.some((line) => Number(line.item_id) === entry.itemId))
            .reduce((sum, entry) => sum + entry.backorderSalesQty, 0)
        }
      });
      transfers.push(mapTransfer(transfer));
    }
    await query(
      `UPDATE sales_stock_requests
          SET status = 'active', revision = revision + 1,
              first_scm_decision_at = COALESCE(first_scm_decision_at, now()),
              updated_at = now()
        WHERE id = $1`,
      [request.id]
    );
    const detail = await requestDetailRows(request.id);
    return { request: detail, transfers: detail.transfers };
  });
}

export async function listScmStockRequests({
  queue = "request",
  search = "",
  vendor = "",
  requestDate = "",
  sourceLocationId = "",
  destinationLocationId = "",
  limit = 40,
  offset = 0
} = {}) {
  const normalizedQueue = String(queue || "request").trim().toLowerCase();
  if (!new Set(["request", "pending_to", "rejected", "closed"]).has(normalizedQueue)) {
    throw stockRequestError("SCM stock-request queue must be Request, Pending TO, Rejected, or Closed.");
  }
  const boundedLimit = normalizeStockRequestListLimit(limit);
  const boundedOffset = Math.min(Math.max(Math.trunc(Number(offset)) || 0, 0), 10_000);
  const normalizedSearch = cleanSearch(search);
  const params = [];
  const clauses = ["request.request_type = 'regular'"];
  if (normalizedQueue === "request") {
    clauses.push(`EXISTS (
      SELECT 1 FROM sales_stock_request_lines line
       WHERE line.request_id = request.id
         AND line.status IN ('submitted', 'changes_requested')
    )`);
  } else if (normalizedQueue === "pending_to") {
    clauses.push(`EXISTS (
      SELECT 1 FROM sales_stock_transfers transfer
       WHERE transfer.request_id = request.id
         AND transfer.status NOT IN ('received', 'cancelled', 'closed')
    )`);
  } else if (normalizedQueue === "rejected") {
    clauses.push(`EXISTS (
      SELECT 1 FROM sales_stock_request_lines line
       WHERE line.request_id = request.id
         AND line.status = 'rejected'
    )`);
  } else {
    clauses.push(`EXISTS (
      SELECT 1 FROM sales_stock_transfers transfer
       WHERE transfer.request_id = request.id
         AND transfer.status = 'closed'
    )`);
  }
  if (normalizedSearch) {
    params.push(`%${normalizedSearch}%`);
    clauses.push(`(request.request_ref ILIKE $${params.length} OR EXISTS (
      SELECT 1 FROM sales_stock_request_lines search_line
       WHERE search_line.request_id = request.id
         AND (search_line.item_name ILIKE $${params.length} OR search_line.item_description ILIKE $${params.length})
    ))`);
  }
  addStockRequestListFilters({
    clauses,
    params,
    vendor,
    requestDate,
    sourceLocationId,
    destinationLocationId
  });
  params.push(boundedLimit, boundedOffset);
  const result = await query(
    `SELECT request.id
       FROM sales_stock_requests request
      WHERE ${clauses.join(" AND ")}
      ORDER BY request.updated_at DESC, request.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return Promise.all(result.rows.map((row) => requestDetailRows(row.id)));
}

export async function listStockRequestFilterOptions({ authorizedDestinationLocationIds } = {}) {
  const params = [];
  const clauses = ["NULLIF(BTRIM(COALESCE(item.vendor, '')), '') IS NOT NULL"];
  const authorized = authorizedDestinationLocationIds === undefined
    ? null
    : [...new Set((authorizedDestinationLocationIds || []).map(Number).filter((id) => YARD_BY_LOCATION_ID.has(id)))];
  if (authorized !== null) {
    if (!authorized.length) {
      return { vendors: [], sourceYards: STOCK_REQUEST_YARDS, destinationYards: [] };
    }
    params.push(authorized);
    clauses.push(`request.destination_location_id = ANY($${params.length}::bigint[])`);
  }
  const result = await query(
    `SELECT DISTINCT BTRIM(item.vendor) AS vendor
       FROM sales_stock_request_lines line
       JOIN sales_stock_requests request ON request.id = line.request_id
       JOIN inventory_items item ON item.item_id = line.item_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY vendor`,
    params
  );
  return {
    vendors: result.rows.map((row) => row.vendor),
    sourceYards: STOCK_REQUEST_YARDS,
    destinationYards: authorized === null
      ? STOCK_REQUEST_YARDS
      : STOCK_REQUEST_YARDS.filter((yard) => authorized.includes(yard.locationId))
  };
}

export async function getScmStockRequest(requestId) {
  const detail = await requestDetailRows(requiredId(requestId, "stock request"));
  if (!detail) throw stockRequestError("Stock request was not found.", 404, "STOCK_REQUEST_NOT_FOUND");
  const itemIds = [...new Set(detail.lines.map((line) => line.itemId))];
  detail.availability = await Promise.all(itemIds.map(getStockRequestItemAvailability));
  return detail;
}

export async function getStockTransfer(transferId, { forUpdate = false } = {}) {
  const result = await query(
    `SELECT transfer.*,
            print_job.status AS print_status,
            canonical.dispatch_planned,
            canonical.dispatch_plan_date,
            canonical.dispatch_truck_plate,
            canonical.dispatch_load_name,
            canonical.fulfillment_status,
            canonical.receiving_status,
            canonical.received_at
       FROM sales_stock_transfers transfer
       LEFT JOIN scm_print_jobs print_job ON print_job.id = transfer.print_job_id
       LEFT JOIN transfer_orders canonical ON canonical.netsuite_id = transfer.netsuite_transfer_order_id
      WHERE transfer.id = $1
      ${forUpdate ? "FOR UPDATE OF transfer" : ""}`,
    [requiredId(transferId, "stock transfer")]
  );
  if (!result.rowCount) throw stockRequestError("Stock transfer was not found.", 404, "STOCK_TRANSFER_NOT_FOUND");
  const transfer = mapTransfer(result.rows[0]);
  const lines = await query(
    `SELECT request_line.*, transfer_line.id AS transfer_line_id,
            transfer_line.fulfilled_qty, transfer_line.received_qty
       FROM sales_stock_transfer_lines transfer_line
       JOIN sales_stock_request_lines request_line ON request_line.id = transfer_line.request_line_id
      WHERE transfer_line.transfer_id = $1
      ORDER BY transfer_line.id`,
    [transfer.id]
  );
  transfer.lines = lines.rows.map((row) => ({
    ...mapLine(row),
    transferLineId: Number(row.transfer_line_id),
    fulfilledQty: numeric(row.fulfilled_qty),
    receivedQty: numeric(row.received_qty)
  }));
  transfer.marker = stockRequestMemoMarker(transfer.id);
  return transfer;
}

export async function rejectPendingStockTransfer(transferId, input = {}, { operatorId } = {}) {
  return withTransaction(async () => {
    const transfer = await getStockTransfer(transferId, { forUpdate: true });
    const request = await lockRequest(transfer.requestId);
    const expectedTransferRevision = requiredRevision(input.expectedRevision);
    const expectedRequestRevision = requiredRevision(input.expectedRequestRevision);
    if (transfer.revision !== expectedTransferRevision) {
      throw stockRequestError(
        "This pending Transfer Order changed after the screen loaded. Reload and try again.",
        409,
        "STOCK_TRANSFER_REVISION_CONFLICT"
      );
    }
    if (Number(request.revision) !== expectedRequestRevision) {
      throw stockRequestError(
        "This stock request changed after the screen loaded. Reload and try again.",
        409,
        "STOCK_REQUEST_REVISION_CONFLICT"
      );
    }
    const reason = cleanReason(input.reason);
    const isPristineLocalTransfer = transfer.status === "pending_local"
      && transfer.confirmationStatus === "idle"
      && !transfer.confirmationRequestId
      && !transfer.netsuiteTransferOrderId
      && !transfer.netsuiteTransferOrderRef
      && !transfer.printJobId
      && transfer.printGeneration === 0;
    if (!isPristineLocalTransfer) {
      throw stockRequestError(
        "Only a local Pending TO can be rejected before Confirm TO + Print.",
        409,
        "STOCK_TRANSFER_ALREADY_CONFIRMED"
      );
    }
    await query(
      `UPDATE sales_stock_transfers
          SET status = 'cancelled', revision = revision + 1, updated_at = now()
        WHERE id = $1`,
      [transfer.id]
    );
    await query(
      `UPDATE sales_stock_transfer_reservations reservation
          SET status = 'released', updated_at = now()
         FROM sales_stock_transfer_lines transfer_line
        WHERE transfer_line.id = reservation.transfer_line_id
          AND transfer_line.transfer_id = $1
          AND reservation.status = 'active'`,
      [transfer.id]
    );
    const rejected = await query(
      `UPDATE sales_stock_request_lines request_line
          SET status = 'rejected', decision_reason = $2,
              decided_by = $3, decided_at = now(), updated_at = now()
         FROM sales_stock_transfer_lines transfer_line
        WHERE transfer_line.request_line_id = request_line.id
          AND transfer_line.transfer_id = $1
          AND request_line.status = 'converted'
        RETURNING request_line.id`,
      [transfer.id, reason, operatorId || null]
    );
    if (!rejected.rowCount) {
      throw stockRequestError("This pending TO no longer has rejectable request lines.", 409, "STOCK_TRANSFER_NOT_REJECTABLE");
    }
    await query(
      `UPDATE sales_stock_requests
          SET revision = revision + 1,
              first_scm_decision_at = COALESCE(first_scm_decision_at, now()),
              updated_at = now()
        WHERE id = $1`,
      [transfer.requestId]
    );
    await updateStoredRequestStatus(transfer.requestId);
    await recordEvent({
      requestId: transfer.requestId,
      transferId: transfer.id,
      eventType: "pending_transfer_rejected",
      actorId: operatorId,
      details: { reason, lineIds: rejected.rows.map((row) => Number(row.id)) }
    });
    return {
      request: await requestDetailRows(transfer.requestId),
      transfer: await getStockTransfer(transfer.id)
    };
  });
}

export async function recordStockRequestEvent(values) {
  return recordEvent(values);
}

export async function updateScmStockRequestLine(requestId, lineId, input = {}, { operatorId } = {}) {
  return withTransaction(async () => {
    const request = await lockRequest(requestId);
    const expected = requiredRevision(input.expectedRevision);
    if (Number(request.revision) !== expected) {
      throw stockRequestError("This stock request changed after the screen loaded. Reload and try again.", 409, "STOCK_REQUEST_REVISION_CONFLICT");
    }
    const currentResult = await query(
      `SELECT * FROM sales_stock_request_lines
        WHERE request_id = $1 AND id = $2
        FOR UPDATE`,
      [request.id, requiredId(lineId, "stock-request line")]
    );
    if (!currentResult.rowCount) throw stockRequestError("Stock-request line was not found.", 404);
    const current = currentResult.rows[0];
    if (!EDITABLE_LINE_STATUSES.has(current.status)) {
      throw stockRequestError("This stock-request line is no longer editable.", 409, "STOCK_REQUEST_LINE_LOCKED");
    }
    const itemId = input.itemId ?? current.item_id;
    const items = await inventoryItems([itemId], { forShare: true });
    const item = items.get(Number(itemId));
    const normalized = normalizeLineInput({ ...input, id: current.id }, item, request.destination_location_id);
    await assertCachedAvailability([normalized], { allowOverAvailability: true });
    await query(
      `UPDATE sales_stock_request_lines
          SET item_id = $3, item_name = $4, item_description = $5,
              source_location_id = $6, source_name = $7,
              sales_qty = $8, sales_uom = $9, quantity_mode = $10,
              pallet_qty = $11, layer_qty = $12, section_qty = $13, piece_qty = $14,
              to_plt = $15, to_lyr = $16, to_sec = $17, to_pcs = $18,
              decided_by = $19, decided_at = COALESCE(decided_at, now()), updated_at = now()
        WHERE request_id = $1 AND id = $2`,
      [
        request.id, current.id, normalized.itemId, normalized.itemName, normalized.itemDescription,
        normalized.sourceLocationId, normalized.sourceName,
        normalized.salesQty, normalized.salesUom, normalized.quantityMode,
        normalized.pallets, normalized.layers, normalized.sections, normalized.pieces,
        normalized.toPlt, normalized.toLyr, normalized.toSec, normalized.toPcs, operatorId
      ]
    );
    await query(
      `UPDATE sales_stock_requests
          SET status = 'active', revision = revision + 1,
              first_scm_decision_at = COALESCE(first_scm_decision_at, now()),
              updated_at = now()
        WHERE id = $1`,
      [request.id]
    );
    await recordEvent({
      requestId: request.id,
      requestLineId: Number(current.id),
      eventType: "line_adjusted_by_scm",
      actorId: operatorId,
      details: {
        previousSourceLocationId: Number(current.source_location_id),
        sourceLocationId: normalized.sourceLocationId,
        previousSalesQty: numeric(current.sales_qty),
        salesQty: normalized.salesQty
      }
    });
    return requestDetailRows(request.id);
  });
}

export async function claimStockTransferConfirmation(transferId, input = {}, { operatorId } = {}) {
  return withTransaction(async () => {
    const transfer = await getStockTransfer(transferId, { forUpdate: true });
    const expected = requiredRevision(input.expectedRevision);
    const requestId = String(input.requestId || "").trim();
    if (!requestId || requestId.length > 200) throw stockRequestError("A stable requestId is required to confirm a Transfer Order.");
    const sameAttempt = transfer.confirmationRequestId === requestId;
    if (!sameAttempt && transfer.revision !== expected) {
      throw stockRequestError("This pending Transfer Order changed after the screen loaded. Reload and try again.", 409, "STOCK_TRANSFER_REVISION_CONFLICT");
    }
    if (transfer.palletQuantityRequiresManual && !transfer.palletQuantityManuallyAdjusted) {
      throw stockRequestError("Set the final PALLET item quantity before confirming this TO.", 409, "STOCK_TRANSFER_PALLET_REQUIRED");
    }
    if (transfer.confirmationRequestId
        && !sameAttempt
        && !["complete", "attention"].includes(transfer.confirmationStatus)) {
      throw stockRequestError("Another confirm-and-print attempt already owns this Transfer Order.", 409, "STOCK_TRANSFER_CONFIRMATION_IN_PROGRESS");
    }
    if (!sameAttempt && !["pending_local", "attention"].includes(transfer.status)) {
      throw stockRequestError("This Transfer Order has already been confirmed.", 409, "STOCK_TRANSFER_ALREADY_CONFIRMED");
    }
    await query(
      `UPDATE sales_stock_transfers
          SET confirmation_status = CASE
                WHEN confirmation_status = 'complete' THEN confirmation_status
                ELSE 'creating'
              END,
              confirmation_request_id = $2,
              confirmation_started_at = COALESCE(confirmation_started_at, now()),
              confirmation_error = NULL,
              status = CASE
                WHEN netsuite_transfer_order_id IS NULL THEN 'creating'
                ELSE status
              END,
              updated_at = now()
        WHERE id = $1`,
      [transfer.id, requestId]
    );
    await recordEvent({
      requestId: transfer.requestId,
      transferId: transfer.id,
      eventType: sameAttempt ? "transfer_confirmation_retried" : "transfer_confirmation_started",
      actorId: operatorId,
      details: { requestId }
    });
    return getStockTransfer(transfer.id);
  });
}

export async function recordStockTransferRemote(transferId, remote = {}, { operatorId } = {}) {
  return withTransaction(async () => {
    const transfer = await getStockTransfer(transferId, { forUpdate: true });
    const remoteId = requiredId(remote.id ?? remote.remoteId, "NetSuite Transfer Order");
    const remoteRef = String(remote.tranid ?? remote.remoteRef ?? transfer.netsuiteTransferOrderRef ?? `TO-${remoteId}`).trim();
    await query(
      `UPDATE sales_stock_transfers
          SET netsuite_transfer_order_id = $2,
              netsuite_transfer_order_ref = $3,
              netsuite_status = COALESCE($4, netsuite_status),
              netsuite_status_text = COALESCE($5, netsuite_status_text),
              netsuite_updated_at = COALESCE($6::timestamptz, netsuite_updated_at, now()),
              status = 'pending_approval', confirmation_status = 'approving',
              confirmation_error = NULL, updated_at = now()
        WHERE id = $1`,
      [
        transfer.id, remoteId, remoteRef,
        remote.status || null, remote.statusText ?? remote.status_text ?? null,
        remote.updatedAt ?? remote.updated_at ?? null
      ]
    );
    await recordEvent({
      requestId: transfer.requestId,
      transferId: transfer.id,
      eventType: "netsuite_transfer_linked",
      actorId: operatorId,
      details: { remoteId, remoteRef, recovered: remote.recovered === true }
    });
    return getStockTransfer(transfer.id);
  });
}

export async function recordStockTransferApproved(transferId, remote = {}, { operatorId } = {}) {
  return withTransaction(async () => {
    const transfer = await getStockTransfer(transferId, { forUpdate: true });
    await query(
      `UPDATE sales_stock_transfers
          SET netsuite_transfer_order_ref = COALESCE(NULLIF($2, ''), netsuite_transfer_order_ref),
              netsuite_status = COALESCE(NULLIF($3, ''), netsuite_status, 'B'),
              netsuite_status_text = COALESCE(NULLIF($4, ''), netsuite_status_text, 'Pending Fulfillment'),
              netsuite_updated_at = now(), status = 'pending_fulfillment',
              confirmation_status = 'hydrating', confirmation_error = NULL,
              confirmed_by = COALESCE(confirmed_by, $5),
              confirmed_at = COALESCE(confirmed_at, now()), updated_at = now()
        WHERE id = $1`,
      [
        transfer.id,
        String(remote.tranid || remote.remoteRef || ""),
        String(remote.status || ""),
        String(remote.statusText ?? remote.status_text ?? ""),
        operatorId || null
      ]
    );
    await recordEvent({
      requestId: transfer.requestId,
      transferId: transfer.id,
      eventType: "netsuite_transfer_approved",
      actorId: operatorId,
      details: { remoteId: transfer.netsuiteTransferOrderId, remoteRef: remote.tranid || transfer.netsuiteTransferOrderRef }
    });
    return getStockTransfer(transfer.id);
  });
}

export async function claimStockTransferPrint(transferId, { operatorId = null } = {}) {
  return withTransaction(async () => {
    const transfer = await getStockTransfer(transferId, { forUpdate: true });
    if (!transfer.netsuiteTransferOrderId || !transfer.netsuiteTransferOrderRef) {
      throw stockRequestError("A real NetSuite Transfer Order is required before printing.", 409);
    }
    const result = await query(
      `UPDATE sales_stock_transfers
          SET print_generation = print_generation + 1,
              confirmation_status = 'printing',
              confirmation_error = NULL, updated_at = now()
        WHERE id = $1
        RETURNING print_generation`,
      [transfer.id]
    );
    await recordEvent({
      requestId: transfer.requestId,
      transferId: transfer.id,
      eventType: "transfer_print_requested",
      actorId: operatorId,
      details: { generation: Number(result.rows[0].print_generation) }
    });
    return { generation: Number(result.rows[0].print_generation), transfer: await getStockTransfer(transfer.id) };
  });
}

export async function completeStockTransferPrint(transferId, { printJobId, operatorId = null } = {}) {
  return withTransaction(async () => {
    const transfer = await getStockTransfer(transferId, { forUpdate: true });
    await query(
      `UPDATE sales_stock_transfers
          SET print_job_id = $2, print_invalidated_at = NULL,
              confirmation_status = 'complete', confirmation_error = NULL,
              status = CASE WHEN status IN ('creating', 'pending_approval', 'attention') THEN 'pending_fulfillment' ELSE status END,
              updated_at = now()
        WHERE id = $1`,
      [transfer.id, requiredId(printJobId, "print job")]
    );
    await recordEvent({
      requestId: transfer.requestId,
      transferId: transfer.id,
      eventType: "transfer_print_queued",
      actorId: operatorId,
      details: { printJobId: Number(printJobId), generation: transfer.printGeneration }
    });
    return getStockTransfer(transfer.id);
  });
}

export async function failStockTransferConfirmation(transferId, failure = {}, { operatorId = null } = {}) {
  return withTransaction(async () => {
    const transfer = await getStockTransfer(transferId, { forUpdate: true });
    const message = String(failure.error?.message || failure.error || failure.message || "Transfer confirmation failed.").slice(0, 2000);
    const remoteId = failure.remoteId ? Number(failure.remoteId) : transfer.netsuiteTransferOrderId;
    const remoteRef = String(failure.remoteRef || transfer.netsuiteTransferOrderRef || "").trim() || null;
    await query(
      `UPDATE sales_stock_transfers
          SET netsuite_transfer_order_id = COALESCE($2, netsuite_transfer_order_id),
              netsuite_transfer_order_ref = COALESCE($3, netsuite_transfer_order_ref),
              confirmation_status = 'attention', confirmation_error = $4,
              status = 'attention', updated_at = now()
        WHERE id = $1`,
      [transfer.id, remoteId || null, remoteRef, message]
    );
    await recordEvent({
      requestId: transfer.requestId,
      transferId: transfer.id,
      eventType: "transfer_confirmation_attention",
      actorId: operatorId,
      details: { remoteId: remoteId || null, remoteRef, error: message }
    });
    return getStockTransfer(transfer.id);
  });
}

async function currentTransferReservationTotals(transferId) {
  const result = await query(
    `SELECT reservation.item_id, reservation.source_location_id,
            SUM(reservation.reserved_sales_quantity)::numeric AS reserved
       FROM sales_stock_transfer_reservations reservation
       JOIN sales_stock_transfer_lines line ON line.id = reservation.transfer_line_id
      WHERE line.transfer_id = $1 AND reservation.status = 'active'
      GROUP BY reservation.item_id, reservation.source_location_id`,
    [transferId]
  );
  return new Map(result.rows.map((row) => [`${row.item_id}:${row.source_location_id}`, numeric(row.reserved)]));
}

export async function reviseStockTransferQuantities(transferId, input = {}, { operatorId = null } = {}) {
  return withTransaction(async () => {
    const transfer = await getStockTransfer(transferId, { forUpdate: true });
    const expected = requiredRevision(input.expectedRevision);
    if (transfer.revision !== expected) {
      throw stockRequestError("This pending Transfer Order changed after the screen loaded. Reload and try again.", 409, "STOCK_TRANSFER_REVISION_CONFLICT");
    }
    const revisionRequestId = String(input.requestId || "").trim();
    if (!revisionRequestId || revisionRequestId.length > 200) throw stockRequestError("A stable requestId is required for a TO quantity revision.");
    if (transfer.revisionRequestId && transfer.revisionRequestId === revisionRequestId) return transfer;
    const inputs = Array.isArray(input.lines) ? input.lines : [];
    if (inputs.length !== transfer.lines.length) {
      throw stockRequestError("A quantity revision must include every material line on this pending TO.");
    }
    const byRequestLineId = new Map(transfer.lines.map((line) => [line.id, line]));
    const normalized = inputs.map((lineInput) => {
      const current = byRequestLineId.get(requiredId(lineInput.requestLineId ?? lineInput.id, "request line"));
      if (!current) throw stockRequestError("A pending TO material line was not found.", 404);
      const quantity = normalizeStockRequestQuantity(lineInput, {
        stockUnit: current.salesUom,
        toPlt: current.toPlt,
        toLyr: current.toLyr,
        toSec: current.toSec,
        toPcs: current.toPcs
      });
      return { ...current, ...quantity };
    });
    const pairs = normalized.map((line) => ({
      item_id: line.itemId,
      source_location_id: transfer.sourceLocationId,
      sales_qty: line.salesQty
    }));
    const availability = await conversionAvailabilitySnapshot(pairs, {
      ownReservations: await currentTransferReservationTotals(transfer.id)
    });
    for (const line of normalized) {
      await query(
        `UPDATE sales_stock_request_lines
            SET sales_qty = $2, sales_uom = $3, quantity_mode = $4,
                pallet_qty = $5, layer_qty = $6, section_qty = $7, piece_qty = $8,
                updated_at = now()
          WHERE id = $1`,
        [line.id, line.salesQty, line.salesUom, line.mode, line.pallets, line.layers, line.sections, line.pieces]
      );
      await query(
        `UPDATE sales_stock_transfer_lines
            SET sales_qty = $2, sales_uom = $3, quantity_mode = $4,
                pallet_qty = $5, layer_qty = $6, section_qty = $7, piece_qty = $8,
                updated_at = now()
          WHERE transfer_id = $9 AND request_line_id = $1`,
        [line.id, line.salesQty, line.salesUom, line.mode, line.pallets, line.layers, line.sections, line.pieces, transfer.id]
      );
      await query(
        `UPDATE sales_stock_transfer_reservations reservation
            SET reserved_sales_quantity = $2, updated_at = now()
           FROM sales_stock_transfer_lines transfer_line
          WHERE transfer_line.id = reservation.transfer_line_id
            AND transfer_line.transfer_id = $3
            AND transfer_line.request_line_id = $1
            AND reservation.status = 'active'`,
        [line.id, line.salesQty, transfer.id]
      );
    }
    const pallet = stockRequestPalletQuantity(normalized.map((line) => ({
      itemId: line.itemId,
      salesQty: line.salesQty,
      toPlt: line.toPlt
    })));
    const hasPalletInput = Object.hasOwn(input, "palletQuantity");
    const requestedPallet = hasPalletInput ? Number(input.palletQuantity) : null;
    if (hasPalletInput && (!Number.isFinite(requestedPallet) || requestedPallet < 0 || requestedPallet > 1_000_000_000)) {
      throw stockRequestError("PALLET item quantity must be a finite non-negative number.");
    }
    const palletQuantity = hasPalletInput ? requestedPallet : pallet.automaticQuantity;
    await query(
      `UPDATE sales_stock_transfers
          SET pallet_quantity = $2,
              pallet_quantity_requires_manual = $3,
              pallet_quantity_manually_adjusted = CASE WHEN $4 THEN true ELSE pallet_quantity_manually_adjusted END,
              revision = revision + 1, revision_request_id = $5, revision_error = NULL,
              print_invalidated_at = CASE WHEN print_job_id IS NOT NULL THEN now() ELSE print_invalidated_at END,
              print_job_id = NULL, confirmation_status = CASE WHEN netsuite_transfer_order_id IS NULL THEN confirmation_status ELSE 'attention' END,
              confirmation_error = CASE WHEN netsuite_transfer_order_id IS NULL THEN confirmation_error ELSE 'Quantity changed; NetSuite sync and re-print are required.' END,
              updated_at = now()
        WHERE id = $1`,
      [transfer.id, palletQuantity, pallet.requiresManualQuantity, hasPalletInput, revisionRequestId]
    );
    await query("UPDATE sales_stock_requests SET revision = revision + 1, updated_at = now() WHERE id = $1", [transfer.requestId]);
    await recordEvent({
      requestId: transfer.requestId,
      transferId: transfer.id,
      eventType: "transfer_quantities_revised",
      actorId: operatorId,
      details: {
        revisionRequestId,
        previousRevision: expected,
        palletQuantity,
        availability,
        backorderSalesQty: availability.reduce((sum, entry) => sum + entry.backorderSalesQty, 0)
      }
    });
    return getStockTransfer(transfer.id);
  });
}

export async function recordStockTransferRevisionResult(transferId, {
  succeeded,
  error = null,
  remote = null,
  operatorId = null
} = {}) {
  return withTransaction(async () => {
    const transfer = await getStockTransfer(transferId, { forUpdate: true });
    const message = error ? String(error.message || error).slice(0, 2000) : null;
    await query(
      `UPDATE sales_stock_transfers
          SET revision_error = $2,
              confirmation_status = CASE WHEN $3 THEN 'complete' ELSE 'attention' END,
              confirmation_error = CASE WHEN $3 THEN NULL ELSE $2 END,
              netsuite_status = COALESCE($4, netsuite_status),
              netsuite_status_text = COALESCE($5, netsuite_status_text),
              netsuite_updated_at = CASE WHEN $3 THEN now() ELSE netsuite_updated_at END,
              updated_at = now()
        WHERE id = $1`,
      [transfer.id, message, Boolean(succeeded), remote?.status || null, remote?.statusText ?? remote?.status_text ?? null]
    );
    await recordEvent({
      requestId: transfer.requestId,
      transferId: transfer.id,
      eventType: succeeded ? "transfer_revision_synced" : "transfer_revision_attention",
      actorId: operatorId,
      details: { error: message }
    });
    return getStockTransfer(transfer.id);
  });
}

function projectedWebhookTransferStatus(canonical = {}, payload = {}) {
  const status = String(canonical.status || payload.status || "").trim();
  const statusText = String(canonical.status_text || payload.status_text || payload.statusText || "").trim();
  const receivingStatus = String(canonical.receiving_status || payload.receiving_status || "").trim();
  const fulfillmentStatus = String(canonical.fulfillment_status || payload.fulfillment_status || "").trim();
  if (canonical.received_at || /received|complete/i.test(receivingStatus)) return "received";
  if (/\bclosed\b/i.test(`${status} ${statusText}`)) return "closed";
  if (/cancel(?:led)?/i.test(`${status} ${statusText}`)) return "cancelled";
  if (/pending receipt|partially received/i.test(`${statusText} ${receivingStatus}`)) return "pending_receipt";
  if (/partially fulfilled|in transit|fulfilled/i.test(`${statusText} ${fulfillmentStatus}`)) return "partially_fulfilled";
  if (/pending fulfillment/i.test(statusText) || status.toUpperCase() === "B") return "pending_fulfillment";
  return null;
}

export async function reconcileStockRequestTransferWebhook(payload = {}) {
  const remoteId = Number(payload.id ?? payload.netsuite_id ?? payload.netsuiteId);
  if (!Number.isInteger(remoteId) || remoteId <= 0) return { matched: false };
  return withTransaction(async () => {
    const transferResult = await query(
      `SELECT * FROM sales_stock_transfers
        WHERE netsuite_transfer_order_id = $1
        FOR UPDATE`,
      [remoteId]
    );
    if (!transferResult.rowCount) return { matched: false };
    const transfer = mapTransfer(transferResult.rows[0]);
    const canonicalResult = await query(
      `SELECT status, status_text, fulfillment_status, receiving_status,
              received_at, status_updated_at, synced_at
         FROM transfer_orders
        WHERE netsuite_id = $1`,
      [remoteId]
    );
    const canonical = canonicalResult.rows[0] || {};
    const incomingAt = new Date(
      canonical.status_updated_at
      || payload.status_updated_at
      || payload.lastModifiedDate
      || payload.lastmodifieddate
      || canonical.synced_at
      || Date.now()
    );
    const currentAt = transfer.netsuiteUpdatedAt ? new Date(transfer.netsuiteUpdatedAt) : null;
    if (currentAt && Number.isFinite(incomingAt.getTime()) && incomingAt < currentAt) {
      return { matched: true, stale: true, transferId: transfer.id, requestId: transfer.requestId };
    }
    const projected = projectedWebhookTransferStatus(canonical, payload);
    if (!projected) return { matched: true, ignored: true, transferId: transfer.id, requestId: transfer.requestId };
    if (transfer.status === "closed" && projected !== "closed") {
      return { matched: true, stale: true, terminal: true, transferId: transfer.id, requestId: transfer.requestId };
    }
    await query(
      `UPDATE sales_stock_transfers
          SET status = $2,
              netsuite_status = COALESCE($3, netsuite_status),
              netsuite_status_text = COALESCE($4, netsuite_status_text),
              netsuite_updated_at = $5,
              confirmation_status = CASE WHEN $2 = 'pending_fulfillment' THEN 'complete' ELSE confirmation_status END,
              updated_at = now()
        WHERE id = $1`,
      [
        transfer.id, projected,
        canonical.status || payload.status || null,
        canonical.status_text || payload.status_text || payload.statusText || null,
        Number.isFinite(incomingAt.getTime()) ? incomingAt.toISOString() : new Date().toISOString()
      ]
    );
    if (["received", "cancelled", "closed"].includes(projected)) {
      await query(
        `UPDATE sales_stock_transfer_reservations reservation
            SET status = $2, updated_at = now()
           FROM sales_stock_transfer_lines transfer_line
          WHERE transfer_line.id = reservation.transfer_line_id
            AND transfer_line.transfer_id = $1
            AND reservation.status = 'active'`,
        [transfer.id, projected === "received" ? "executed" : "released"]
      );
      await query(
        `UPDATE sales_stock_request_lines request_line
            SET status = $2, updated_at = now()
           FROM sales_stock_transfer_lines transfer_line
          WHERE transfer_line.request_line_id = request_line.id
            AND transfer_line.transfer_id = $1`,
        [transfer.id, projected]
      );
      await updateStoredRequestStatus(transfer.requestId);
    }
    await recordEvent({
      requestId: transfer.requestId,
      transferId: transfer.id,
      eventType: "netsuite_transfer_webhook",
      details: { projectedStatus: projected, remoteId }
    });
    return { matched: true, stale: false, transferId: transfer.id, requestId: transfer.requestId, status: projected };
  });
}

export { stockRequestError };
