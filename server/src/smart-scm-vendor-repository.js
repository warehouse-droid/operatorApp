import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import {
  getSmartScmProposal,
  listSmartScmProposals,
  recordSmartScmVendorResponses
} from "./smart-scm-planning-repository.js";

const EPSILON = 0.000001;
const VENDOR_REPLY_LOAD_STATUSES = Object.freeze([
  "order_requested",
  "vendor_replied",
  "executing",
  "attention",
  "failed",
  "completed"
]);

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback = 0) {
  return Math.max(0, number(value, fallback));
}

function text(value) {
  return String(value ?? "").trim();
}

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}

function validIsoDate(value) {
  const candidate = text(value);
  if (!candidate) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
    throw Object.assign(new Error("Ready date must use YYYY-MM-DD."), { status: 400 });
  }
  const parsed = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw Object.assign(new Error("Ready date is invalid."), { status: 400 });
  return candidate;
}

function ensureEditableVendorLoad(proposal) {
  if (!proposal) throw Object.assign(new Error("Smart SCM PO load was not found."), { status: 404 });
  if (proposal.proposalType !== "PO") throw Object.assign(new Error("Vendor replies are only available for PO loads."), { status: 400 });
  if (!["order_requested", "vendor_replied"].includes(proposal.status)) {
    throw Object.assign(new Error("This PO load must be marked Order Requested before a vendor reply can be edited."), { status: 409 });
  }
  if (proposal.netsuitePurchaseOrderId || proposal.netsuitePurchaseOrderRef) {
    throw Object.assign(new Error("This load already has a purchase-order reference and is locked."), { status: 409 });
  }
}

function aggregateReplyStatus(responses = []) {
  const statuses = responses.map((response) => text(response.responseStatus));
  if (statuses.includes("credit_hold")) return "credit_hold";
  if (statuses.includes("production_eta")) return "production_eta";
  if (statuses.length && statuses.every((status) => status === "confirmed")) return "confirmed";
  if (statuses.length && statuses.every((status) => ["out_of_stock", "cancelled"].includes(status))) return "out_of_stock";
  if (statuses.some((status) => ["confirmed", "partial", "out_of_stock", "cancelled"].includes(status))) return "partial";
  return "awaiting";
}

function normalizedLineReply(line, input = {}) {
  const requested = positive(line.proposedPallets);
  const confirmed = positive(input.confirmedPallets);
  const requestedStatus = text(input.responseStatus || input.status || "");
  let responseStatus;
  if (["production_eta", "credit_hold", "cancelled"].includes(requestedStatus)) {
    responseStatus = requestedStatus;
  } else if (requestedStatus === "awaiting") {
    responseStatus = "awaiting";
  } else if (confirmed <= EPSILON) {
    responseStatus = "out_of_stock";
  } else if (confirmed + EPSILON < requested) {
    responseStatus = "partial";
  } else {
    responseStatus = "confirmed";
  }
  if (["out_of_stock", "credit_hold", "cancelled"].includes(responseStatus) && confirmed > EPSILON) {
    responseStatus = confirmed + EPSILON < requested ? "partial" : "confirmed";
  }
  return {
    proposalLineId: line.id,
    responseStatus,
    confirmedPallets: confirmed,
    unavailablePallets: Math.max(0, requested - confirmed)
  };
}

async function settingsRow() {
  const result = await query("SELECT * FROM scm_smart_settings WHERE id = 1");
  if (!result.rowCount) throw new Error("Smart SCM settings are missing. Run migrations first.");
  return result.rows[0];
}

async function vendorIdentityForProposal(proposalId, { confirmedOnly = false } = {}) {
  const result = await query(
    `SELECT ARRAY_REMOVE(ARRAY_AGG(DISTINCT i.vendor_id), NULL) AS vendor_ids,
            ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(i.vendor, '')), NULL) AS vendor_names
       FROM scm_smart_proposal_lines l
       JOIN inventory_items i ON i.item_id = l.item_id
      WHERE l.proposal_id = $1
        AND ($2::boolean = false OR l.confirmed_pallets > 0)`,
    [Number(proposalId), Boolean(confirmedOnly)]
  );
  const vendorIds = result.rows[0]?.vendor_ids || [];
  if (!vendorIds.length) {
    throw Object.assign(new Error("The load items do not have a NetSuite vendor ID. Refresh Item Master before continuing."), { status: 409 });
  }
  if (vendorIds.length !== 1) {
    throw Object.assign(new Error("A PO load can contain items from only one NetSuite vendor."), { status: 409 });
  }
  return {
    vendorId: Number(vendorIds[0]),
    vendorName: result.rows[0]?.vendor_names?.[0] || ""
  };
}

async function recalculateProposalTotals(proposalId, { confirmed = false } = {}) {
  await query(
    `WITH totals AS (
       SELECT COALESCE(SUM(${confirmed ? "confirmed_pallets" : "proposed_pallets"}), 0) AS pallets,
              COALESCE(SUM(${confirmed ? "confirmed_pallets" : "proposed_pallets"} * COALESCE(pallet_weight_lbs, 0)), 0) AS weight
         FROM scm_smart_proposal_lines
        WHERE proposal_id = $1
     ), settings AS (
       SELECT truck_capacity_lbs FROM scm_smart_settings WHERE id = 1
     )
     UPDATE scm_smart_proposals p
        SET total_pallets = totals.pallets,
            total_weight_lbs = totals.weight,
            utilization = CASE WHEN settings.truck_capacity_lbs > 0 THEN totals.weight / settings.truck_capacity_lbs ELSE 0 END,
            updated_at = now()
       FROM totals, settings
      WHERE p.id = $1`,
    [Number(proposalId)]
  );
}

async function recordStructuralRevision(runId, reason, diff, operatorId) {
  const updated = await query(
    "UPDATE scm_smart_planning_runs SET revision = revision + 1 WHERE id = $1 RETURNING revision",
    [Number(runId)]
  );
  await query(
    `INSERT INTO scm_smart_plan_revisions
       (run_id, revision, reason, before_snapshot, after_snapshot, diff, created_by)
     VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, $4::jsonb, $5)`,
    [Number(runId), Number(updated.rows[0].revision), reason, JSON.stringify(diff || {}), operatorId]
  );
}

export async function listSmartScmVendorReplyLoads({ search = "", limit = 500 } = {}) {
  return listSmartScmProposals({
    type: "PO",
    statuses: VENDOR_REPLY_LOAD_STATUSES,
    requestedOnly: true,
    vendorQueue: true,
    search,
    limit: Math.min(1000, Math.max(1, Number(limit) || 500))
  });
}

export async function searchSmartScmVendorAlternatives(proposalId, { search = "", lineId = null, limit = 12 } = {}) {
  const proposal = await getSmartScmProposal(proposalId);
  ensureEditableVendorLoad(proposal);
  const vendor = await vendorIdentityForProposal(proposal.id);
  const baseLine = lineId ? proposal.lines.find((line) => Number(line.id) === Number(lineId)) : null;
  const baseResult = baseLine
    ? await query("SELECT series, brand, product_type FROM inventory_items WHERE item_id = $1", [baseLine.itemId])
    : { rows: [] };
  const base = baseResult.rows[0] || {};
  const term = text(search);
  const result = await query(
    `SELECT i.item_id, i.item_name, i.display_name, i.item_description, i.stock_unit,
            i.vendor_id, i.vendor, i.series, i.brand, i.product_type,
            i.to_plt, i.to_lyr, i.to_sec, i.to_pcs, i.item_weight,
            CASE
              WHEN NULLIF($3, '') IS NOT NULL AND LOWER(COALESCE(i.series, '')) = LOWER($3) THEN 4
              WHEN NULLIF($4, '') IS NOT NULL AND LOWER(COALESCE(i.brand, '')) = LOWER($4) THEN 2
              WHEN NULLIF($5, '') IS NOT NULL AND LOWER(COALESCE(i.product_type, '')) = LOWER($5) THEN 1
              ELSE 0
            END AS compatibility_score
       FROM inventory_items i
      WHERE i.vendor_id = $1
        AND COALESCE(i.to_plt, 0) > 0
        AND COALESCE(i.item_weight, 0) > 0
        AND NOT EXISTS (
          SELECT 1 FROM scm_smart_proposal_lines existing
           WHERE existing.proposal_id = $2 AND existing.item_id = i.item_id
        )
        AND ($6 = '' OR i.item_id::text ILIKE '%' || $6 || '%'
          OR i.item_name ILIKE '%' || $6 || '%'
          OR COALESCE(i.display_name, '') ILIKE '%' || $6 || '%'
          OR COALESCE(i.item_description, '') ILIKE '%' || $6 || '%'
          OR COALESCE(i.series, '') ILIKE '%' || $6 || '%')
      ORDER BY compatibility_score DESC, i.item_name, i.item_id
      LIMIT $7`,
    [vendor.vendorId, proposal.id, text(base.series), text(base.brand), text(base.product_type), term, Math.min(30, Math.max(1, Number(limit) || 12))]
  );
  return result.rows.map((row) => ({
    itemId: Number(row.item_id),
    itemName: row.item_name,
    displayName: row.display_name || "",
    description: row.item_description || "",
    unit: row.stock_unit || "",
    vendorId: Number(row.vendor_id),
    vendor: row.vendor || vendor.vendorName,
    series: row.series || "",
    brand: row.brand || "",
    toPlt: positive(row.to_plt),
    toLyr: positive(row.to_lyr),
    toSec: positive(row.to_sec),
    toPcs: positive(row.to_pcs),
    palletWeightLbs: round(positive(row.to_plt) * positive(row.item_weight), 2),
    compatibilityScore: Number(row.compatibility_score || 0),
    suggested: !term && Number(row.compatibility_score || 0) > 0
  }));
}

export async function addSmartScmVendorAlternativeLine(proposalId, values = {}, operatorId = null) {
  const id = Number(proposalId);
  const itemId = Number(values.itemId);
  const requestedPallets = positive(values.proposedPallets ?? values.pallets ?? values.confirmedPallets);
  const confirmedPallets = positive(values.confirmedPallets ?? requestedPallets);
  if (!Number.isInteger(itemId) || itemId <= 0) throw Object.assign(new Error("Select an alternative item."), { status: 400 });
  if (requestedPallets <= EPSILON) throw Object.assign(new Error("Alternative quantity must be greater than zero."), { status: 400 });
  const created = await withTransaction(async () => {
    await query("SELECT id FROM scm_smart_proposals WHERE id = $1 FOR UPDATE", [id]);
    const proposal = await getSmartScmProposal(id);
    ensureEditableVendorLoad(proposal);
    const vendor = await vendorIdentityForProposal(id);
    const itemResult = await query(
      `SELECT item_id, item_name, item_description, stock_unit, vendor_id, vendor,
              to_plt, to_lyr, to_sec, to_pcs, item_weight
         FROM inventory_items
        WHERE item_id = $1
        FOR UPDATE`,
      [itemId]
    );
    if (!itemResult.rowCount) throw Object.assign(new Error("The selected Item Master record was not found."), { status: 404 });
    const item = itemResult.rows[0];
    if (Number(item.vendor_id) !== vendor.vendorId) {
      throw Object.assign(new Error(`The alternative must use the same NetSuite vendor (${vendor.vendorName || vendor.vendorId}) as this PO load.`), { status: 409 });
    }
    const toPlt = positive(item.to_plt);
    const itemWeight = positive(item.item_weight);
    if (toPlt <= EPSILON || itemWeight <= EPSILON) {
      throw Object.assign(new Error("The alternative needs both a pallet conversion and item weight before it can be added."), { status: 409 });
    }
    let alternativeForLineId = values.alternativeForLineId ? Number(values.alternativeForLineId) : null;
    if (alternativeForLineId && !proposal.lines.some((line) => line.id === alternativeForLineId)) {
      throw Object.assign(new Error("The original line for this alternative is not part of the PO load."), { status: 400 });
    }
    const originalLine = proposal.lines.find((line) => line.id === alternativeForLineId);
    const destinationLocationId = Number(originalLine?.destinationLocationId || proposal.destinationLocationId);
    const destinationName = originalLine?.destinationName || proposal.destinationName;
    const pallets = Math.max(requestedPallets, confirmedPallets);
    const palletWeight = round(toPlt * itemWeight, 6);
    let inserted;
    try {
      inserted = await query(
        `INSERT INTO scm_smart_proposal_lines (
           proposal_id, item_id, item_name, item_description, unit,
           required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
           sales_quantity, pallet_weight_lbs, line_weight_lbs,
           to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason,
           is_alternative, alternative_for_line_id, added_source, added_by, destination_location_id, destination_name,
           urgent, provisional
         ) VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,$16::jsonb,true,$17,$18,$19,$20,$21,$22,$23)
         RETURNING id`,
        [
          id, item.item_id, item.item_name, item.item_description, item.stock_unit,
          pallets, confirmedPallets, Math.max(0, pallets - confirmedPallets),
          round(pallets * toPlt), palletWeight, round(pallets * palletWeight),
          item.to_plt, item.to_lyr, item.to_sec, item.to_pcs,
          JSON.stringify({ alternative: true, alternativeForLineId, vendorId: vendor.vendorId }),
          alternativeForLineId, text(values.source) === "system" ? "system" : "manual", operatorId, destinationLocationId, destinationName,
          Boolean(originalLine?.urgent || proposal.urgent), Boolean(originalLine?.provisional || proposal.provisional)
        ]
      );
    } catch (error) {
      if (error.code === "23505") throw Object.assign(new Error("This item is already part of the PO load."), { status: 409 });
      throw error;
    }
    if (confirmedPallets > EPSILON) {
      await query(
        `INSERT INTO scm_smart_vendor_responses (
           proposal_line_id, revision, response_status, confirmed_pallets, unavailable_pallets,
           ready_date, vendor_reference, packing_number, credit_status, remarks, response_source, responded_by
         ) SELECT $1::bigint, 1, 'confirmed', $2::numeric, GREATEST($3::numeric - $2::numeric, 0), vendor_ready_date,
                  vendor_reference, vendor_packing_number, vendor_credit_status, vendor_remarks, 'alternative', $4::text
             FROM scm_smart_proposals WHERE id = $5::bigint`,
        [inserted.rows[0].id, confirmedPallets, pallets, operatorId, id]
      );
    }
    await query(
      `UPDATE scm_smart_proposals
          SET status = 'vendor_replied', vendor_replied_at = now(), vendor_replied_by = $2, updated_at = now()
        WHERE id = $1`,
      [id, operatorId]
    );
    await recalculateProposalTotals(id);
    await recordStructuralRevision(proposal.runId, "vendor_alternative_added", {
      proposalId: id,
      lineId: Number(inserted.rows[0].id),
      itemId,
      alternativeForLineId,
      requestedPallets: pallets,
      confirmedPallets
    }, operatorId);
    return { lineId: Number(inserted.rows[0].id), runId: proposal.runId };
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.vendor_alternative.add",
    details: { proposalId: id, ...created, itemId, requestedPallets, confirmedPallets }
  });
  return getSmartScmProposal(id);
}

export async function removeSmartScmVendorAlternativeLine(proposalId, lineId, operatorId = null) {
  const id = Number(proposalId);
  const targetLineId = Number(lineId);
  const removed = await withTransaction(async () => {
    await query("SELECT id FROM scm_smart_proposals WHERE id = $1 FOR UPDATE", [id]);
    const proposal = await getSmartScmProposal(id);
    ensureEditableVendorLoad(proposal);
    const lineResult = await query(
      `SELECT * FROM scm_smart_proposal_lines
        WHERE id = $1 AND proposal_id = $2
        FOR UPDATE`,
      [targetLineId, id]
    );
    if (!lineResult.rowCount) throw Object.assign(new Error("Alternative line was not found."), { status: 404 });
    if (!lineResult.rows[0].is_alternative) throw Object.assign(new Error("Only an added alternative line can be removed."), { status: 409 });
    await query("DELETE FROM scm_smart_proposal_lines WHERE id = $1", [targetLineId]);
    await recalculateProposalTotals(id);
    await recordStructuralRevision(proposal.runId, "vendor_alternative_removed", {
      proposalId: id,
      lineId: targetLineId,
      itemId: Number(lineResult.rows[0].item_id)
    }, operatorId);
    return { runId: proposal.runId, itemId: Number(lineResult.rows[0].item_id) };
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.vendor_alternative.remove",
    details: { proposalId: id, lineId: targetLineId, ...removed }
  });
  return getSmartScmProposal(id);
}

export async function saveSmartScmVendorReplyLoad(proposalId, values = {}, operatorId = null) {
  const id = Number(proposalId);
  return withTransaction(async () => {
    await query("SELECT id FROM scm_smart_proposals WHERE id = $1 FOR UPDATE", [id]);
    const proposal = await getSmartScmProposal(id);
  ensureEditableVendorLoad(proposal);
  const inputs = Array.isArray(values.lines) ? values.lines : [];
  if (!inputs.length) throw Object.assign(new Error("Enter at least one vendor reply line."), { status: 400 });
  const inputByLine = new Map(inputs.map((input) => [Number(input.proposalLineId || input.lineId), input]));
  const readyDate = validIsoDate(values.readyDate);
  const metadata = {
    readyDate,
    vendorReference: text(values.vendorReference),
    packingNumber: text(values.packingNumber),
    creditStatus: text(values.creditStatus),
    remarks: text(values.remarks),
    responseSource: text(values.responseSource) || "load_grid"
  };
  const responses = proposal.lines
    .filter((line) => inputByLine.has(line.id))
    .map((line) => ({
      ...normalizedLineReply(line, inputByLine.get(line.id)),
      ...metadata
    }));
  if (responses.length !== inputByLine.size) throw Object.assign(new Error("One or more reply lines do not belong to this PO load."), { status: 400 });
  if (responses.some((response) => response.responseStatus === "production_eta") && !readyDate) {
    throw Object.assign(new Error("A production ETA reply requires a ready date."), { status: 400 });
  }
  await recordSmartScmVendorResponses(responses, operatorId);
  const loadStatus = aggregateReplyStatus(responses);
  await query(
    `UPDATE scm_smart_proposals
        SET status = 'vendor_replied',
            vendor_response_status = $2,
            vendor_ready_date = $3,
            vendor_reference = NULLIF($4, ''),
            vendor_packing_number = NULLIF($5, ''),
            vendor_credit_status = NULLIF($6, ''),
            vendor_remarks = NULLIF($7, ''),
            vendor_response_source = $8,
            vendor_replied_at = now(),
            vendor_replied_by = $9,
            po_execution_status = 'idle',
            po_execution_error = NULL,
            updated_at = now()
      WHERE id = $1`,
    [id, loadStatus, readyDate, metadata.vendorReference, metadata.packingNumber, metadata.creditStatus, metadata.remarks, metadata.responseSource, operatorId]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.vendor_reply.load_saved",
    details: { proposalId: id, runId: proposal.runId, responseCount: responses.length, loadStatus, ...metadata }
  });
  return getSmartScmProposal(id);
  });
}

export async function prepareSmartScmPurchaseExecution(proposalId, operatorId = null) {
  return withTransaction(async () => {
    const result = await query(
      `SELECT p.*,
              COALESCE((
                SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id)
                  FROM scm_smart_proposal_lines l
                 WHERE l.proposal_id = p.id
              ), '[]'::jsonb) AS lines
         FROM scm_smart_proposals p
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [Number(proposalId)]
    );
    if (!result.rowCount) throw Object.assign(new Error("Smart SCM PO load was not found."), { status: 404 });
    const proposal = result.rows[0];
    if (proposal.proposal_type !== "PO") throw Object.assign(new Error("Only a PO load can create a purchase order."), { status: 400 });
    if (proposal.netsuite_purchase_order_id || proposal.netsuite_purchase_order_ref) {
      throw Object.assign(new Error("This load already has a purchase-order reference. Do not create a duplicate PO."), { status: 409 });
    }
    if (proposal.status !== "vendor_replied") {
      throw Object.assign(new Error("Save the vendor reply before confirming this PO load."), { status: 409 });
    }
    const lines = (proposal.lines || []).filter((line) => positive(line.confirmed_pallets) > EPSILON);
    if (!lines.length) throw Object.assign(new Error("At least one line needs a confirmed quantity before creating the PO."), { status: 409 });
    if (lines.some((line) => positive(line.to_plt) <= EPSILON || positive(line.pallet_weight_lbs) <= EPSILON)) {
      throw Object.assign(new Error("Every confirmed line needs a pallet conversion and weight before creating the PO."), { status: 409 });
    }
    const vendor = await vendorIdentityForProposal(proposal.id, { confirmedOnly: true });
    const settings = await settingsRow();
    await query(
      `UPDATE scm_smart_proposal_lines
          SET sales_quantity = confirmed_pallets * to_plt,
              line_weight_lbs = confirmed_pallets * pallet_weight_lbs,
              residual_pallets = GREATEST(proposed_pallets - confirmed_pallets, 0),
              updated_at = now()
        WHERE proposal_id = $1`,
      [proposal.id]
    );
    await recalculateProposalTotals(proposal.id, { confirmed: true });
    await query(
      `UPDATE scm_smart_proposals
          SET status = 'executing', po_execution_status = 'creating', po_execution_error = NULL,
              confirmed_at = now(), confirmed_by = $2, updated_at = now()
        WHERE id = $1`,
      [proposal.id, operatorId]
    );
    return {
      id: Number(proposal.id),
      runId: Number(proposal.run_id),
      mode: settings.execution_mode,
      vendorId: vendor.vendorId,
      vendorName: vendor.vendorName || proposal.vendor || proposal.source_name,
      destinationLocationId: Number(proposal.destination_location_id),
      destinationName: proposal.destination_name,
      memo: proposal.memo,
      readyDate: proposal.vendor_ready_date,
      vendorReference: proposal.vendor_reference,
      totalPallets: round(lines.reduce((sum, line) => sum + positive(line.confirmed_pallets), 0)),
      lines: lines.map((line) => ({
        id: Number(line.id),
        itemId: Number(line.item_id),
        itemName: line.item_name,
        destinationLocationId: Number(line.destination_location_id || proposal.destination_location_id),
        destinationName: line.destination_name || proposal.destination_name,
        description: line.item_description,
        proposedPallets: positive(line.proposed_pallets),
        confirmedPallets: positive(line.confirmed_pallets),
        salesQuantity: round(positive(line.confirmed_pallets) * positive(line.to_plt)),
        palletQty: positive(line.confirmed_pallets),
        layerQty: 0,
        sectionQty: 0,
        pieceQty: 0
      }))
    };
  });
}

export async function completeSmartScmPurchaseExecution(proposalId, { purchaseOrderId = null, purchaseOrderRef = null, mock = false } = {}, operatorId = null) {
  const updated = await query(
    `UPDATE scm_smart_proposals
        SET status = 'completed', po_execution_status = $2, po_execution_error = NULL,
            netsuite_purchase_order_id = $3, netsuite_purchase_order_ref = $4,
            approved_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING id`,
    [Number(proposalId), mock ? "mock_completed" : "created", purchaseOrderId, purchaseOrderRef]
  );
  if (!updated.rowCount) throw Object.assign(new Error("Smart SCM PO load was not found."), { status: 404 });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: mock ? "smart_scm.purchase.mock_completed" : "smart_scm.purchase.completed",
    orderId: purchaseOrderId,
    details: { proposalId: Number(proposalId), purchaseOrderId, purchaseOrderRef, mock }
  });
  return getSmartScmProposal(proposalId);
}

export async function failSmartScmPurchaseExecution(proposalId, error, operatorId = null) {
  const message = text(error?.message || error);
  await query(
    `UPDATE scm_smart_proposals
        SET status = 'vendor_replied', po_execution_status = 'failed', po_execution_error = $2, updated_at = now()
      WHERE id = $1`,
    [Number(proposalId), message]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.purchase.failed",
    details: { proposalId: Number(proposalId), error: message }
  });
}

export async function markSmartScmPurchaseAttention(proposalId, { purchaseOrderId = null, purchaseOrderRef = null, error } = {}, operatorId = null) {
  const message = text(error?.message || error || "Smart SCM purchase order requires attention.");
  await query(
    `UPDATE scm_smart_proposals
        SET status = 'attention', po_execution_status = 'attention', po_execution_error = $2,
            netsuite_purchase_order_id = COALESCE($3, netsuite_purchase_order_id),
            netsuite_purchase_order_ref = COALESCE(NULLIF($4, ''), netsuite_purchase_order_ref),
            updated_at = now()
      WHERE id = $1`,
    [Number(proposalId), message, purchaseOrderId, purchaseOrderRef]
  );
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.purchase.attention",
    orderId: purchaseOrderId,
    details: { proposalId: Number(proposalId), purchaseOrderId, purchaseOrderRef, error: message }
  });
}
