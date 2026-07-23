import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import {
  getSmartScmProposal,
  listSmartScmProposals,
  recordSmartScmVendorResponses,
  smartScmNormalizePalletQuantityOverrides,
  smartScmPalletQuantityOverridePatch,
  setSmartScmPalletQuantityOverride,
  smartScmMinimumOrderMap
} from "./smart-scm-planning-repository.js";
import { calculateSmartScmOrderRequirement, calculateSmartScmPolicyLevels } from "./smart-scm-policy-calculation.js";

const EPSILON = 0.000001;
const VENDOR_REPLY_LOAD_STATUSES = Object.freeze(["order_requested", "vendor_replied"]);
const NETSUITE_PO_REVIEW_STATUSES = Object.freeze(["confirmed", "executing", "failed", "attention", "completed"]);

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

function normalizedUnit(value) {
  return text(value).toUpperCase().replace(/\s+/g, " ");
}

function hasPurchaseUnitMismatch(stockUnit, purchaseUnit) {
  return Boolean(normalizedUnit(stockUnit) && normalizedUnit(purchaseUnit)
    && normalizedUnit(stockUnit) !== normalizedUnit(purchaseUnit));
}

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}

function palletQuantityOverridePatch(values = {}) {
  if (!Object.hasOwn(values, "palletQuantityOverrides")) return null;
  const raw = values.palletQuantityOverrides;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw Object.assign(new Error("PALLET overrides must be keyed by destination location."), { status: 400 });
  }
  const patch = new Map();
  for (const [rawLocationId, rawQuantity] of Object.entries(raw)) {
    const locationId = Number(rawLocationId);
    if (!Number.isInteger(locationId) || locationId <= 0) {
      throw Object.assign(new Error("Every PALLET override needs a valid destination location."), { status: 400 });
    }
    if (rawQuantity === null) {
      patch.set(String(locationId), null);
      continue;
    }
    const { quantity } = smartScmPalletQuantityOverridePatch({ quantity: rawQuantity });
    patch.set(String(locationId), quantity);
  }
  return patch;
}

function materialPalletsByDestination(lines = [], proposal = {}, { confirmed = false } = {}) {
  const grouped = new Map();
  for (const line of lines) {
    const quantity = positive(confirmed
      ? line.confirmedPallets ?? line.confirmed_pallets
      : line.proposedPallets ?? line.proposed_pallets);
    if (quantity <= EPSILON) continue;
    const destinationLocationId = Number(
      line.destinationLocationId ?? line.destination_location_id
      ?? proposal.destinationLocationId ?? proposal.destination_location_id
    );
    if (!Number.isInteger(destinationLocationId) || destinationLocationId <= 0) continue;
    const current = grouped.get(destinationLocationId) || {
      destinationLocationId,
      destinationName: line.destinationName ?? line.destination_name
        ?? proposal.destinationName ?? proposal.destination_name ?? "",
      automaticQuantity: 0
    };
    current.automaticQuantity = round(current.automaticQuantity + quantity);
    grouped.set(destinationLocationId, current);
  }
  return grouped;
}

function resolvedPalletLines(lines = [], proposal = {}, palletItem = {}, { confirmed = false } = {}) {
  const overrides = smartScmNormalizePalletQuantityOverrides(
    proposal.palletQuantityOverrides ?? proposal.pallet_quantity_overrides
  );
  return [...materialPalletsByDestination(lines, proposal, { confirmed }).values()].map((entry) => {
    const key = String(entry.destinationLocationId);
    const overridden = Object.hasOwn(overrides, key);
    const overrideQuantity = overridden ? overrides[key] : null;
    const quantity = overridden ? overrideQuantity : entry.automaticQuantity;
    const itemWeightLbs = positive(palletItem.itemWeightLbs ?? palletItem.item_weight);
    const lastPurchasePrice = palletItem.lastPurchasePrice === null
      || palletItem.lastPurchasePrice === undefined
      ? null
      : number(palletItem.lastPurchasePrice, null);
    return {
      itemId: Number(palletItem.itemId ?? palletItem.id) || null,
      itemName: palletItem.itemName || "PALLET",
      destinationLocationId: entry.destinationLocationId,
      destinationName: entry.destinationName,
      automaticQuantity: entry.automaticQuantity,
      overrideQuantity,
      overridden,
      confirmedPallets: quantity,
      salesQuantity: quantity,
      purchaseQuantity: quantity,
      unit: palletItem.unit || null,
      purchaseUnit: palletItem.purchaseUnit || null,
      purchaseUnitMismatch: hasPurchaseUnitMismatch(palletItem.unit, palletItem.purchaseUnit),
      lastPurchasePrice,
      lastPurchasePriceSyncedAt: palletItem.lastPurchasePriceSyncedAt || null,
      itemWeightLbs,
      lineWeightLbs: round(quantity * itemWeightLbs),
      purchaseAmount: lastPurchasePrice === null ? null : round(quantity * lastPurchasePrice, 2),
      ancillaryPallet: true,
      officialLineItem: true,
      submittedToNetSuite: true
    };
  });
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

export function normalizeSmartScmVendorDecision(line, input = {}) {
  const requested = positive(line.proposedPallets);
  const requestedDecision = text(input.decision || input.responseStatus || input.status || "").toLowerCase();
  const decision = ["hold", "awaiting", "production_eta", "credit_hold"].includes(requestedDecision)
    ? "hold"
    : ["cancel", "cancelled", "out_of_stock"].includes(requestedDecision)
      ? "cancel"
      : "confirm";
  const savedDraft = line.reason?.vendorReplyDraft || {};
  const hasDecisionPallets = input.decisionPallets !== undefined
    && input.decisionPallets !== null
    && String(input.decisionPallets).trim() !== "";
  const hasConfirmedPallets = input.confirmedPallets !== undefined
    && input.confirmedPallets !== null
    && String(input.confirmedPallets).trim() !== "";
  const savedDecisionPallets = text(savedDraft.decision).toLowerCase() === decision
    ? positive(savedDraft.decisionPallets)
    : 0;
  const remainingPallets = positive(line.residualPallets);
  const existingConfirmedPallets = positive(line.confirmedPallets);
  const defaultDecisionPallets = savedDecisionPallets > EPSILON
    ? savedDecisionPallets
    : decision === "confirm" && existingConfirmedPallets > EPSILON
      ? existingConfirmedPallets
      : remainingPallets > EPSILON
        ? Math.min(remainingPallets, requested)
        : requested;
  const rawDecisionPallets = hasDecisionPallets
    ? positive(input.decisionPallets)
    : hasConfirmedPallets
      ? positive(input.confirmedPallets)
      : defaultDecisionPallets;
  const decisionPallets = rawDecisionPallets > requested && rawDecisionPallets <= requested + EPSILON
    ? requested
    : round(rawDecisionPallets);
  if (decision === "hold") {
    if (decisionPallets <= EPSILON) {
      throw Object.assign(new Error("A held vendor line must have hold pallets greater than zero."), { status: 400 });
    }
    if (decisionPallets > requested + EPSILON) {
      throw Object.assign(new Error("Hold pallets cannot exceed the requested pallets."), { status: 400 });
    }
    return {
      decision,
      proposalLineId: line.id,
      requestedPallets: requested,
      decisionPallets,
      heldPallets: decisionPallets,
      remainderPallets: round(Math.max(0, requested - decisionPallets)),
      responseStatus: "awaiting",
      confirmedPallets: 0,
      unavailablePallets: requested
    };
  }
  if (decision === "cancel") {
    return {
      decision,
      proposalLineId: line.id,
      requestedPallets: requested,
      decisionPallets: 0,
      heldPallets: 0,
      remainderPallets: requested,
      responseStatus: "cancelled",
      confirmedPallets: 0,
      unavailablePallets: requested
    };
  }
  if (decisionPallets <= EPSILON) {
    throw Object.assign(new Error("A confirmed vendor line must have confirmed pallets greater than zero."), { status: 400 });
  }
  if (decisionPallets > requested + EPSILON) {
    throw Object.assign(new Error("Confirmed pallets cannot exceed the requested pallets."), { status: 400 });
  }
  return {
    decision,
    proposalLineId: line.id,
    requestedPallets: requested,
    decisionPallets,
    heldPallets: 0,
    remainderPallets: round(Math.max(0, requested - decisionPallets)),
    responseStatus: decisionPallets + EPSILON < requested ? "partial" : "confirmed",
    confirmedPallets: decisionPallets,
    unavailablePallets: round(Math.max(0, requested - decisionPallets))
  };
}

function normalizedLineReply(line, input = {}) {
  return normalizeSmartScmVendorDecision(line, input);
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

async function resolvedProposalTotalWeight(proposalId, { confirmed = false } = {}) {
  const result = await query(
    `SELECT p.destination_location_id, p.destination_name, p.pallet_quantity_overrides,
            COALESCE((
              SELECT MAX(item_weight) FILTER (
                WHERE UPPER(BTRIM(COALESCE(item_name, ''))) = 'PALLET'
              )
                FROM inventory_items
            ), 0) AS pallet_item_weight_lbs,
            COALESCE((
              SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id)
                FROM scm_smart_proposal_lines l
               WHERE l.proposal_id = p.id
            ), '[]'::jsonb) AS lines
       FROM scm_smart_proposals p
      WHERE p.id = $1`,
    [Number(proposalId)]
  );
  if (!result.rowCount) return 0;
  const proposal = result.rows[0];
  const lines = Array.isArray(proposal.lines) ? proposal.lines : [];
  const materialWeight = lines.reduce((sum, line) => {
    const pallets = positive(confirmed ? line.confirmed_pallets : line.proposed_pallets);
    return sum + (pallets * positive(line.pallet_weight_lbs));
  }, 0);
  const palletLines = resolvedPalletLines(lines, proposal, {
    itemWeightLbs: proposal.pallet_item_weight_lbs
  }, { confirmed });
  return round(materialWeight + palletLines.reduce(
    (sum, line) => sum + positive(line.lineWeightLbs),
    0
  ));
}

async function recalculateProposalTotals(proposalId, { confirmed = false } = {}) {
  const totalWeight = await resolvedProposalTotalWeight(proposalId, { confirmed });
  await query(
    `WITH totals AS (
       SELECT COALESCE(SUM(${confirmed ? "confirmed_pallets" : "proposed_pallets"}), 0) AS pallets
         FROM scm_smart_proposal_lines
        WHERE proposal_id = $1
     ), settings AS (
       SELECT truck_capacity_lbs FROM scm_smart_settings WHERE id = 1
     )
     UPDATE scm_smart_proposals p
        SET total_pallets = totals.pallets,
            total_weight_lbs = $2,
            utilization = CASE WHEN settings.truck_capacity_lbs > 0 THEN $2::numeric / settings.truck_capacity_lbs ELSE 0 END,
            updated_at = now()
       FROM totals, settings
      WHERE p.id = $1`,
    [Number(proposalId), totalWeight]
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

async function refreshVendorResolutionProposal(proposalId, { confirmed = false } = {}) {
  const quantityColumn = confirmed ? "confirmed_pallets" : "proposed_pallets";
  const totalWeight = await resolvedProposalTotalWeight(proposalId, { confirmed });
  await query(
    `WITH totals AS (
       SELECT COALESCE(SUM(${quantityColumn}), 0) AS pallets,
              COALESCE(BOOL_OR(urgent), false) AS urgent,
              COALESCE(BOOL_OR(provisional), false) AS provisional
         FROM scm_smart_proposal_lines
        WHERE proposal_id = $1
     ), stops AS (
       SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'locationId', destination_location_id,
                'name', destination_name,
                'sequence', stop_sequence
              ) ORDER BY stop_sequence), '[]'::jsonb) AS route_stops
         FROM (
           SELECT destination_location_id, MIN(destination_name) AS destination_name,
                  row_number() OVER (ORDER BY MIN(id)) AS stop_sequence
             FROM scm_smart_proposal_lines WHERE proposal_id = $1
            GROUP BY destination_location_id
         ) distinct_stops
     ), settings AS (
       SELECT truck_capacity_lbs FROM scm_smart_settings WHERE id = 1
     )
     UPDATE scm_smart_proposals p
        SET total_pallets = totals.pallets,
            total_weight_lbs = $2,
            utilization = CASE WHEN settings.truck_capacity_lbs > 0 THEN $2::numeric / settings.truck_capacity_lbs ELSE 0 END,
            urgent = totals.urgent,
            provisional = totals.provisional,
            route_stops = stops.route_stops,
            updated_at = now()
       FROM totals, stops, settings
      WHERE p.id = $1`,
    [Number(proposalId), totalWeight]
  );
}

async function createVendorResolutionChild(source, { kind, status, label, operatorId = null } = {}) {
  const sequenceResult = await query(
    `SELECT COUNT(*)::int + 1 AS sequence
       FROM scm_smart_proposals
      WHERE parent_proposal_id = $1 AND vendor_resolution_kind = $2`,
    [source.id, kind]
  );
  const sequence = Number(sequenceResult.rows[0]?.sequence || 1);
  const proposalKey = `${source.proposalKey}:${label}:${sequence}`;
  const created = await query(
    `INSERT INTO scm_smart_proposals (
       run_id, proposal_key, proposal_type, phase, source_kind, source_location_id, source_name,
       destination_location_id, destination_name, vendor, plant, status, urgent, provisional, memo,
       order_requested_at, order_requested_by, vendor_replied_at, vendor_replied_by,
       vendor_response_status, vendor_ready_date, vendor_reference, vendor_packing_number,
       vendor_credit_status, vendor_remarks, vendor_response_source,
       pallet_quantity_overrides,
       parent_proposal_id, vendor_resolution_kind, price_snapshot_at, confirmed_at, confirmed_by
     )
     SELECT run_id, $2, proposal_type, phase, source_kind, source_location_id, source_name,
            destination_location_id, destination_name, vendor, plant, $3, urgent, provisional, memo,
            order_requested_at, order_requested_by, vendor_replied_at, vendor_replied_by,
            $4, vendor_ready_date, vendor_reference, vendor_packing_number,
            vendor_credit_status, vendor_remarks, vendor_response_source,
            CASE WHEN $5 = 'netsuite_po_review' THEN pallet_quantity_overrides ELSE '{}'::jsonb END,
            id, $5, CASE WHEN $5 = 'netsuite_po_review' THEN now() ELSE NULL END,
            CASE WHEN $5 = 'netsuite_po_review' THEN now() ELSE NULL END,
            CASE WHEN $5 = 'netsuite_po_review' THEN $6 ELSE NULL END
       FROM scm_smart_proposals WHERE id = $1
     RETURNING id`,
    [source.id, proposalKey, status, kind === "netsuite_po_review" ? "confirmed" : "cancelled", kind, operatorId]
  );
  return Number(created.rows[0].id);
}

async function createVendorHeldLineChild(source, line) {
  const proposalKey = `${source.proposalKey}:held-line:${line.id}`;
  const created = await query(
    `INSERT INTO scm_smart_proposals (
       run_id, proposal_key, proposal_type, phase, source_kind, source_location_id, source_name,
       destination_location_id, destination_name, vendor, plant, status, urgent, provisional,
       vendor_reply_due_at, memo, execution_mode, route_stops, manually_grouped,
       order_requested_at, order_requested_by, vendor_replied_at, vendor_replied_by,
       vendor_response_status, vendor_ready_date, vendor_reference, vendor_packing_number,
       vendor_credit_status, vendor_remarks, vendor_response_source,
       parent_proposal_id, vendor_resolution_kind, po_execution_status
     )
     SELECT run_id, $2, proposal_type, phase, source_kind, source_location_id, source_name,
            destination_location_id, destination_name, vendor, plant, 'vendor_replied', urgent, provisional,
            vendor_reply_due_at,
            CONCAT_WS(' · ', NULLIF(memo, ''), 'held vendor line ' || $3 || ' from load #' || id),
            execution_mode, '[]'::jsonb, false,
            order_requested_at, order_requested_by, vendor_replied_at, vendor_replied_by,
            'awaiting', vendor_ready_date, vendor_reference, vendor_packing_number,
            vendor_credit_status, vendor_remarks, vendor_response_source,
            id, NULL, 'idle'
       FROM scm_smart_proposals WHERE id = $1
     RETURNING id`,
    [source.id, proposalKey, line.itemName]
  );
  return Number(created.rows[0].id);
}

function proportionalPallets(total, part, whole) {
  if (positive(whole) <= EPSILON) return 0;
  return round(positive(total) * positive(part) / positive(whole));
}

async function splitHeldVendorLine({ source, line, decision, cancelledProposalId }) {
  const lineResult = await query(
    `SELECT * FROM scm_smart_proposal_lines
      WHERE id = $1 AND proposal_id = $2
      FOR UPDATE`,
    [Number(line.id), Number(source.id)]
  );
  if (!lineResult.rowCount) {
    throw Object.assign(new Error("The held vendor line is no longer available on its source load."), { status: 409 });
  }
  const stored = lineResult.rows[0];
  const originalPallets = positive(stored.proposed_pallets);
  const heldPallets = positive(decision.heldPallets);
  const cancelledRemainderPallets = round(Math.max(0, originalPallets - heldPallets));
  const heldProposalId = await createVendorHeldLineChild(source, line);
  const heldRequiredPallets = proportionalPallets(stored.required_pallets, heldPallets, originalPallets);
  const cancelledRequiredPallets = round(Math.max(0, positive(stored.required_pallets) - heldRequiredPallets));
  const toPlt = positive(stored.to_plt);
  const heldSalesQuantity = toPlt > EPSILON
    ? round(heldPallets * toPlt)
    : proportionalPallets(stored.sales_quantity, heldPallets, originalPallets);
  const palletWeight = positive(stored.pallet_weight_lbs);
  const heldLineWeight = palletWeight > EPSILON
    ? round(heldPallets * palletWeight)
    : proportionalPallets(stored.line_weight_lbs, heldPallets, originalPallets);
  let cancelledRemainderLineId = null;

  if (cancelledRemainderPallets > EPSILON) {
    if (!cancelledProposalId) throw new Error("A cancelled history load is required for the unused Hold quantity.");
    const cancellationEvidence = {
      ...(stored.reason || {}),
      vendorHoldRemainder: {
        sourceProposalId: Number(source.id),
        sourceLineId: Number(stored.id),
        heldProposalId,
        originalPallets,
        heldPallets,
        cancelledPallets: cancelledRemainderPallets,
        originalSalesQuantity: positive(stored.sales_quantity),
        originalLineWeightLbs: positive(stored.line_weight_lbs)
      }
    };
    const inserted = await query(
      `INSERT INTO scm_smart_proposal_lines (
         proposal_id, item_id, item_name, item_description, unit,
         required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
         sales_quantity, pallet_weight_lbs, line_weight_lbs, to_plt, to_lyr, to_sec, to_pcs,
         manual_planning_required, reason, destination_location_id, destination_name,
         urgent, provisional, is_alternative, alternative_for_line_id, added_source, added_by,
         vendor_decision, last_purchase_price, last_purchase_price_synced_at, purchase_unit
       )
       SELECT $1, item_id, item_name, item_description, unit,
              $3, $4, 0, $4,
              0, pallet_weight_lbs, 0, to_plt, to_lyr, to_sec, to_pcs,
              manual_planning_required, $5::jsonb, destination_location_id, destination_name,
              urgent, provisional, is_alternative, alternative_for_line_id, added_source, added_by,
              'cancel', last_purchase_price, last_purchase_price_synced_at, purchase_unit
         FROM scm_smart_proposal_lines WHERE id = $2
       RETURNING id`,
      [cancelledProposalId, stored.id, cancelledRequiredPallets, cancelledRemainderPallets, JSON.stringify(cancellationEvidence)]
    );
    cancelledRemainderLineId = Number(inserted.rows[0].id);
  }

  const holdEvidence = {
    ...(stored.reason || {}),
    vendorHoldSplit: {
      sourceProposalId: Number(source.id),
      sourceLineId: Number(stored.id),
      heldProposalId,
      originalPallets,
      heldPallets,
      cancelledRemainderPallets,
      cancelledRemainderLineId
    },
    vendorReplyDraft: { decision: "hold", decisionPallets: heldPallets }
  };
  await query(
    `UPDATE scm_smart_proposal_lines
        SET proposal_id = $2,
            required_pallets = $3,
            proposed_pallets = $4,
            confirmed_pallets = 0,
            residual_pallets = $4,
            sales_quantity = $5,
            line_weight_lbs = $6,
            vendor_decision = 'hold',
            reason = $7::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [stored.id, heldProposalId, heldRequiredPallets, heldPallets, heldSalesQuantity, heldLineWeight, JSON.stringify(holdEvidence)]
  );
  await refreshVendorResolutionProposal(heldProposalId);
  return {
    sourceLineId: Number(stored.id),
    heldProposalId,
    originalPallets,
    heldPallets,
    cancelledRemainderPallets,
    cancelledRemainderLineId,
    conservedPallets: round(heldPallets + cancelledRemainderPallets)
  };
}

async function snapshotReviewPalletItem(reviewProposalId) {
  const result = await query(
    `SELECT item_id, item_name, stock_unit, purchase_unit, last_purchase_price, synced_at
       FROM inventory_items
      WHERE UPPER(COALESCE(item_name, '')) = 'PALLET'
      ORDER BY item_id`
  );
  const pallet = result.rowCount === 1 ? result.rows[0] : null;
  await query(
    `UPDATE scm_smart_proposals
        SET pallet_item_id = $2,
            pallet_item_name = $3,
            pallet_unit = $4,
            pallet_purchase_unit = $5,
            pallet_last_purchase_price = $6,
            pallet_price_synced_at = $7,
            updated_at = now()
      WHERE id = $1`,
    [reviewProposalId, pallet?.item_id || null, pallet?.item_name || null, pallet?.stock_unit || null,
      pallet?.purchase_unit || null, pallet?.last_purchase_price || null, pallet?.synced_at || null]
  );
}

function smartScmPoReviewBlockers(proposal) {
  const blockers = [];
  for (const line of proposal.lines || []) {
    if (positive(line.confirmedPallets) <= EPSILON) continue;
    if (positive(line.lastPurchasePrice) <= EPSILON) {
      blockers.push({
        code: "missing_last_purchase_price",
        itemId: line.itemId,
        itemName: line.itemName,
        message: `${line.itemName} does not have a positive NetSuite Last Purchase Price.`
      });
    }
    if (!text(line.purchaseUnit)) {
      blockers.push({ code: "missing_purchase_unit", itemId: line.itemId, itemName: line.itemName, message: `${line.itemName} does not have a NetSuite purchase unit snapshot.` });
    } else if (hasPurchaseUnitMismatch(line.unit, line.purchaseUnit)) {
      blockers.push({ code: "purchase_unit_mismatch", itemId: line.itemId, itemName: line.itemName, stockUnit: line.unit, purchaseUnit: line.purchaseUnit, message: `${line.itemName} uses stock unit ${line.unit} but NetSuite Last Purchase Price uses purchase unit ${line.purchaseUnit}.` });
    }
  }
  const needsPalletItem = !Array.isArray(proposal.palletLines)
    || proposal.palletLines.some((line) => positive(line.purchaseQuantity ?? line.confirmedPallets) > EPSILON);
  if (needsPalletItem) {
    if (!Number.isInteger(Number(proposal.palletItemId)) || Number(proposal.palletItemId) <= 0) {
      blockers.push({ code: "missing_pallet_item", message: "The active NetSuite PALLET item is not available in Item Master." });
    } else if (positive(proposal.palletLastPurchasePrice) <= EPSILON) {
      blockers.push({ code: "missing_pallet_last_purchase_price", itemId: Number(proposal.palletItemId), itemName: proposal.palletItemName || "PALLET", message: "PALLET does not have a positive NetSuite Last Purchase Price." });
    }
    if (!text(proposal.palletPurchaseUnit)) {
      blockers.push({ code: "missing_pallet_purchase_unit", itemId: Number(proposal.palletItemId) || null, itemName: proposal.palletItemName || "PALLET", message: "PALLET does not have a NetSuite purchase unit snapshot." });
    } else if (hasPurchaseUnitMismatch(proposal.palletUnit, proposal.palletPurchaseUnit)) {
      blockers.push({ code: "pallet_purchase_unit_mismatch", itemId: Number(proposal.palletItemId), itemName: proposal.palletItemName || "PALLET", stockUnit: proposal.palletUnit, purchaseUnit: proposal.palletPurchaseUnit, message: `PALLET uses stock unit ${proposal.palletUnit} but NetSuite Last Purchase Price uses purchase unit ${proposal.palletPurchaseUnit}.` });
    }
  }
  return blockers;
}

async function enrichSmartScmNetSuitePoReview(proposal) {
  if (!proposal) return null;
  const [headerResult, lineResult] = await Promise.all([
    query(
      `SELECT parent_proposal_id, vendor_resolution_kind, price_snapshot_at,
              pallet_item_id, pallet_item_name, pallet_unit, pallet_purchase_unit,
              pallet_last_purchase_price, pallet_price_synced_at, pallet_quantity_overrides,
              (SELECT item_weight FROM inventory_items item WHERE item.item_id = pallet_item_id) AS pallet_item_weight_lbs,
              execution_mode AS proposal_execution_mode,
              (SELECT execution_mode FROM scm_smart_settings WHERE id = 1) AS current_execution_mode
         FROM scm_smart_proposals WHERE id = $1`,
      [proposal.id]
    ),
    query(
      `SELECT id, vendor_decision, purchase_unit, last_purchase_price, last_purchase_price_synced_at
         FROM scm_smart_proposal_lines WHERE proposal_id = $1`,
      [proposal.id]
    )
  ]);
  if (!headerResult.rowCount) return null;
  const header = headerResult.rows[0];
  const lineMeta = new Map(lineResult.rows.map((row) => [Number(row.id), row]));
  const lines = (proposal.lines || []).map((line) => {
    const meta = lineMeta.get(Number(line.id)) || {};
    const purchaseQuantity = positive(line.salesQuantity) || round(positive(line.confirmedPallets) * positive(line.toPlt));
    const lastPurchasePrice = meta.last_purchase_price === null || meta.last_purchase_price === undefined
      ? null
      : number(meta.last_purchase_price, null);
    const purchaseUnit = meta.purchase_unit || null;
    return {
      ...line,
      vendorDecision: meta.vendor_decision || null,
      purchaseUnit,
      purchaseUnitMismatch: hasPurchaseUnitMismatch(line.unit, purchaseUnit),
      purchaseQuantity,
      lastPurchasePrice,
      lastPurchasePriceSyncedAt: meta.last_purchase_price_synced_at || null,
      purchaseAmount: lastPurchasePrice === null ? null : round(purchaseQuantity * lastPurchasePrice, 2)
    };
  });
  const palletItemId = header.pallet_item_id === null ? null : Number(header.pallet_item_id);
  const palletLastPurchasePrice = header.pallet_last_purchase_price === null
    ? null
    : number(header.pallet_last_purchase_price, null);
  const palletItemWeightLbs = positive(header.pallet_item_weight_lbs);
  const palletItem = {
    id: palletItemId,
    itemId: palletItemId,
    itemName: header.pallet_item_name || "PALLET",
    unit: header.pallet_unit || null,
    purchaseUnit: header.pallet_purchase_unit || null,
    itemWeightLbs: palletItemWeightLbs,
    purchaseUnitMismatch: hasPurchaseUnitMismatch(header.pallet_unit, header.pallet_purchase_unit),
    lastPurchasePrice: palletLastPurchasePrice,
    lastPurchasePriceSyncedAt: header.pallet_price_synced_at || null
  };
  const palletQuantityOverrides = smartScmNormalizePalletQuantityOverrides(header.pallet_quantity_overrides);
  const palletLines = resolvedPalletLines(lines, {
    ...proposal,
    palletQuantityOverrides
  }, palletItem, { confirmed: true });
  const enriched = {
    ...proposal,
    parentProposalId: header.parent_proposal_id === null ? null : Number(header.parent_proposal_id),
    vendorResolutionKind: header.vendor_resolution_kind || null,
    persistedExecutionMode: header.proposal_execution_mode || null,
    executionMode: header.proposal_execution_mode || header.current_execution_mode || proposal.executionMode || "mock",
    priceSnapshotAt: header.price_snapshot_at || null,
    palletItemId,
    palletItemName: palletItem.itemName,
    palletUnit: palletItem.unit,
    palletPurchaseUnit: palletItem.purchaseUnit,
    palletLastPurchasePrice,
    palletPriceSyncedAt: palletItem.lastPurchasePriceSyncedAt,
    palletQuantityOverrides,
    palletItem,
    palletLines,
    lines
  };
  const reviewBlockers = smartScmPoReviewBlockers(enriched);
  return {
    ...enriched,
    reviewBlockers,
    blockers: reviewBlockers.map((blocker) => blocker.message),
    canInsertIntoNetSuite: ["confirmed", "failed"].includes(enriched.status)
      && !enriched.netsuitePurchaseOrderId
      && !enriched.netsuitePurchaseOrderRef
      && reviewBlockers.length === 0,
    purchaseTotal: round([...lines, ...palletLines].reduce((sum, line) => sum + positive(line.purchaseAmount), 0), 2)
  };
}

export async function getSmartScmNetSuitePoReviewLoad(proposalId) {
  const proposal = await getSmartScmProposal(proposalId);
  if (!proposal) throw Object.assign(new Error("Smart SCM NetSuite PO review was not found."), { status: 404 });
  const enriched = await enrichSmartScmNetSuitePoReview(proposal);
  if (enriched.vendorResolutionKind !== "netsuite_po_review") {
    throw Object.assign(new Error("Only a staged NetSuite PO review load can be opened here."), { status: 409 });
  }
  return enriched;
}

export async function updateSmartScmNetSuitePoReviewPalletQuantity(
  proposalId,
  destinationLocationId,
  values = {},
  operatorId = null
) {
  const review = await getSmartScmNetSuitePoReviewLoad(proposalId);
  if (!["confirmed", "failed"].includes(review.status)
    || review.netsuitePurchaseOrderId
    || review.netsuitePurchaseOrderRef) {
    throw Object.assign(new Error("PALLET quantity can be changed only before this staged PO is inserted."), { status: 409 });
  }
  await setSmartScmPalletQuantityOverride(
    review.id,
    destinationLocationId,
    values.reset === true ? { reset: true } : { quantity: values.quantity },
    operatorId
  );
  return getSmartScmNetSuitePoReviewLoad(review.id);
}

export async function listSmartScmNetSuitePoReviewLoads({ search = "", view = "all", statuses = null, limit = 500 } = {}) {
  const requestedStatuses = Array.isArray(statuses)
    ? statuses.map(String).filter((status) => NETSUITE_PO_REVIEW_STATUSES.includes(status))
    : view === "completed"
      ? ["completed"]
      : view === "pending"
        ? ["confirmed", "executing", "failed", "attention"]
        : [...NETSUITE_PO_REVIEW_STATUSES];
  if (!requestedStatuses.length) return [];
  const result = await query(
    `SELECT p.id
       FROM scm_smart_proposals p
      WHERE p.proposal_type = 'PO'
        AND p.vendor_resolution_kind = 'netsuite_po_review'
        AND p.status = ANY($1::text[])
        AND ($2 = '' OR p.id::text ILIKE '%' || $2 || '%'
          OR COALESCE(p.vendor, '') ILIKE '%' || $2 || '%'
          OR COALESCE(p.source_name, '') ILIKE '%' || $2 || '%'
          OR COALESCE(p.destination_name, '') ILIKE '%' || $2 || '%'
          OR COALESCE(p.vendor_reference, '') ILIKE '%' || $2 || '%'
          OR EXISTS (
            SELECT 1 FROM scm_smart_proposal_lines l
             WHERE l.proposal_id = p.id
               AND (l.item_id::text ILIKE '%' || $2 || '%' OR l.item_name ILIKE '%' || $2 || '%')
          ))
      ORDER BY p.updated_at DESC, p.id DESC
      LIMIT $3`,
    [requestedStatuses, text(search), Math.min(1000, Math.max(1, Number(limit) || 500))]
  );
  return Promise.all(result.rows.map((row) => getSmartScmNetSuitePoReviewLoad(row.id)));
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

async function smartScmAlternativeEvidence(rows = [], destinationLocationId) {
  const itemIds = rows.map((row) => Number(row.item_id)).filter(Number.isInteger);
  if (!itemIds.length) return new Map();
  const forecasts = await query(
    `SELECT DISTINCT ON (item_id) *
       FROM scm_smart_forecasts
      WHERE item_id = ANY($1::bigint[]) AND location_id = $2
        AND run_id = (
          SELECT id FROM scm_smart_forecast_runs
           WHERE status = 'completed'
           ORDER BY id DESC LIMIT 1
        )
      ORDER BY item_id, run_id DESC`,
    [itemIds, destinationLocationId]
  );
  const inbound = await query(
    `WITH open_po AS (
         SELECT l.item_id, SUM(GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_qty, 0), 0)) AS quantity
           FROM purchase_order_lines l JOIN purchase_orders o ON o.netsuite_id = l.purchase_order_id
          WHERE l.netsuite_active = true AND o.netsuite_active = true
            AND l.item_id = ANY($1::bigint[]) AND COALESCE(l.location_id, o.destination_location_id) = $2
          GROUP BY l.item_id
       ), open_to AS (
         SELECT l.item_id, SUM(GREATEST(COALESCE(l.quantity, 0) - COALESCE(l.netsuite_received_qty, 0), 0)) AS quantity
           FROM transfer_order_lines l JOIN transfer_orders o ON o.netsuite_id = l.transfer_order_id
          WHERE l.line_stage = 'receiving' AND l.netsuite_active = true AND o.netsuite_active = true
            AND l.item_id = ANY($1::bigint[]) AND o.to_location_id = $2
          GROUP BY l.item_id
       )
       SELECT item_id, SUM(quantity) AS quantity FROM (
         SELECT * FROM open_po UNION ALL SELECT * FROM open_to
       ) source GROUP BY item_id`,
    [itemIds, destinationLocationId]
  );
  const backorders = await query(
    `SELECT l.item_id, SUM(GREATEST(COALESCE(l.netsuite_backordered_qty, 0), 0)) AS quantity
       FROM sales_order_lines l JOIN sales_orders o ON o.netsuite_id = l.sales_order_id
      WHERE l.netsuite_active = true AND o.netsuite_active = true
        AND l.item_id = ANY($1::bigint[])
        AND COALESCE(l.location_id, o.outbound_location_id, o.order_location_id) = $2
      GROUP BY l.item_id`,
    [itemIds, destinationLocationId]
  );
  const reservations = await query(
    `SELECT item_id,
            SUM(reserved_sales_quantity) FILTER (WHERE source_location_id = $2) AS outbound_quantity,
            SUM(reserved_sales_quantity) FILTER (WHERE destination_location_id = $2) AS inbound_quantity
       FROM scm_smart_inventory_reservations
      WHERE status = 'active' AND item_id = ANY($1::bigint[])
      GROUP BY item_id`,
    [itemIds, destinationLocationId]
  );
  const settings = await settingsRow();
  const minimumOrders = await smartScmMinimumOrderMap(rows);
  const forecastByItem = new Map(forecasts.rows.map((row) => [Number(row.item_id), row]));
  const inboundByItem = new Map(inbound.rows.map((row) => [Number(row.item_id), positive(row.quantity)]));
  const backorderByItem = new Map(backorders.rows.map((row) => [Number(row.item_id), positive(row.quantity)]));
  const reservationByItem = new Map(reservations.rows.map((row) => [Number(row.item_id), row]));
  return new Map(rows.map((row) => {
    const itemId = Number(row.item_id);
    const toPlt = positive(row.to_plt);
    const quantityAvailable = positive(row.quantity_available);
    const quantityOnOrder = positive(inboundByItem.get(itemId)) + positive(reservationByItem.get(itemId)?.inbound_quantity);
    const quantityBackordered = positive(backorderByItem.get(itemId));
    const quantityReservedOutbound = positive(reservationByItem.get(itemId)?.outbound_quantity);
    const positionPallets = toPlt > EPSILON
      ? (quantityAvailable + quantityOnOrder - quantityBackordered - quantityReservedOutbound) / toPlt
      : 0;
    const forecast = forecastByItem.get(itemId) || null;
    const levels = calculateSmartScmPolicyLevels(row, forecast, settings);
    const requirement = calculateSmartScmOrderRequirement({
      positionPallets,
      reorderPointPallets: levels.reorderPointPallets,
      preferredPallets: levels.preferredPallets,
      capacityPallets: levels.capacityPallets,
      minimumOrderPallets: minimumOrders.get(`${itemId}:${destinationLocationId}`)
    });
    const weeksOfCover = levels.weeklyDemandPallets > EPSILON
      ? Math.max(0, positionPallets) / levels.weeklyDemandPallets
      : null;
    return [itemId, {
      destinationLocationId,
      destinationName: row.yard_code,
      quantityOnHand: positive(row.quantity_on_hand),
      quantityAvailable,
      quantityOnOrder,
      quantityBackordered,
      quantityReservedOutbound,
      positionPallets: round(positionPallets),
      safetyStockPallets: round(levels.safetyStockPallets),
      reorderPointPallets: round(levels.reorderPointPallets),
      preferredPallets: round(levels.preferredPallets),
      capacityPallets: round(levels.capacityPallets),
      minimumOrderPallets: round(requirement.minimumOrderPallets),
      requiredGapPallets: round(requirement.requiredGapPallets),
      capacityBelowMinimum: requirement.capacityBelowMinimum,
      requiredPallets: round(requirement.requiredPallets),
      weeklyDemandPallets: round(levels.weeklyDemandPallets),
      weeksOfCover: weeksOfCover === null ? null : round(weeksOfCover),
      forecastModel: levels.forecastModel,
      inventorySyncedAt: row.inventory_synced_at || null,
      forecastRunId: forecast?.run_id === undefined ? null : Number(forecast.run_id)
    }];
  }));
}

export function rankSmartScmVendorAlternatives(rows = [], evidence = new Map(), { term = "", limit = 12, vendorName = "" } = {}) {
  return rows.map((row) => ({
    itemId: Number(row.item_id),
    itemName: row.item_name,
    displayName: row.display_name || "",
    description: row.item_description || "",
    unit: row.stock_unit || "",
    vendorId: Number(row.vendor_id),
    vendor: row.vendor || vendorName,
    series: row.series || "",
    brand: row.brand || "",
    toPlt: positive(row.to_plt),
    toLyr: positive(row.to_lyr),
    toSec: positive(row.to_sec),
    toPcs: positive(row.to_pcs),
    palletWeightLbs: round(positive(row.to_plt) * positive(row.item_weight), 2),
    compatibilityScore: Number(row.compatibility_score || 0),
    ...(evidence.get(Number(row.item_id)) || {}),
    suggested: !term && positive(evidence.get(Number(row.item_id))?.requiredPallets) > 0
  })).sort((left, right) =>
    Number(Boolean(right.requiredPallets)) - Number(Boolean(left.requiredPallets))
    || positive(right.requiredPallets) - positive(left.requiredPallets)
    || positive(right.requiredGapPallets) - positive(left.requiredGapPallets)
    || positive(right.weeklyDemandPallets) - positive(left.weeklyDemandPallets)
    || right.compatibilityScore - left.compatibilityScore
    || left.itemName.localeCompare(right.itemName)
    || left.itemId - right.itemId
  ).slice(0, Math.min(30, Math.max(1, Number(limit) || 12)));
}

export async function searchSmartScmVendorAlternatives(proposalId, { search = "", lineId = null, limit = 12 } = {}) {
  const proposal = await getSmartScmProposal(proposalId);
  ensureEditableVendorLoad(proposal);
  const vendor = await vendorIdentityForProposal(proposal.id);
  const baseLine = lineId ? proposal.lines.find((line) => Number(line.id) === Number(lineId)) : null;
  if (!baseLine || !Number.isInteger(Number(baseLine.destinationLocationId))) {
    throw Object.assign(new Error("Select an original PO line with a destination yard before finding alternatives."), { status: 400 });
  }
  const baseResult = await query("SELECT series, brand, product_type FROM inventory_items WHERE item_id = $1", [baseLine.itemId]);
  const base = baseResult.rows[0] || {};
  const term = text(search);
  const result = await query(
    `SELECT i.item_id, i.item_name, i.display_name, i.item_description, i.stock_unit,
            i.vendor_id, i.vendor, i.series, i.brand, i.product_type,
            i.to_plt, i.to_lyr, i.to_sec, i.to_pcs, i.item_weight,
            p.lead_time_days, p.purchase_lead_time_days,
            y.location_id, y.yard_code, y.capacity_pallets, y.service_quantile, y.minimum_safety_pallets,
            b.quantity_on_hand, b.quantity_available, b.synced_at AS inventory_synced_at,
            CASE
              WHEN NULLIF($3, '') IS NOT NULL AND LOWER(COALESCE(i.series, '')) = LOWER($3) THEN 4
              WHEN NULLIF($4, '') IS NOT NULL AND LOWER(COALESCE(i.brand, '')) = LOWER($4) THEN 2
              WHEN NULLIF($5, '') IS NOT NULL AND LOWER(COALESCE(i.product_type, '')) = LOWER($5) THEN 1
              ELSE 0
            END AS compatibility_score
       FROM inventory_items i
       JOIN scm_smart_item_policies p ON p.item_id = i.item_id
        AND p.planning_enabled = true AND p.inactive = false AND p.discontinued = false
       JOIN scm_smart_item_yard_policies y ON y.item_id = i.item_id
        AND y.location_id = $7 AND y.eligible = true
       LEFT JOIN inventory_balances b ON b.item_id = i.item_id AND b.location_id = y.location_id
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
      ORDER BY compatibility_score DESC, i.item_name, i.item_id`,
    [vendor.vendorId, proposal.id, text(base.series), text(base.brand), text(base.product_type), term, Number(baseLine.destinationLocationId)]
  );
  const evidence = await smartScmAlternativeEvidence(result.rows, Number(baseLine.destinationLocationId));
  return rankSmartScmVendorAlternatives(result.rows, evidence, { term, limit, vendorName: vendor.vendorName });
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
    const alternativeForLineId = Number(values.alternativeForLineId);
    const originalLine = proposal.lines.find((line) => line.id === alternativeForLineId);
    if (!Number.isInteger(alternativeForLineId) || !originalLine) {
      throw Object.assign(new Error("Select the original PO line that this alternative replaces."), { status: 400 });
    }
    const destinationLocationId = Number(originalLine.destinationLocationId);
    const destinationName = originalLine.destinationName || proposal.destinationName;
    const itemResult = await query(
      `SELECT i.item_id, i.item_name, i.item_description, i.stock_unit, i.vendor_id, i.vendor,
              i.to_plt, i.to_lyr, i.to_sec, i.to_pcs, i.item_weight
         FROM inventory_items i
         JOIN scm_smart_item_policies p ON p.item_id = i.item_id
          AND p.planning_enabled = true AND p.inactive = false AND p.discontinued = false
         JOIN scm_smart_item_yard_policies y ON y.item_id = i.item_id
          AND y.location_id = $2 AND y.eligible = true
        WHERE i.item_id = $1
        FOR UPDATE OF i, p, y`,
      [itemId, destinationLocationId]
    );
    if (!itemResult.rowCount) {
      throw Object.assign(new Error(`The alternative item is not enabled for Smart SCM planning at ${destinationName}.`), { status: 409 });
    }
    const item = itemResult.rows[0];
    if (Number(item.vendor_id) !== vendor.vendorId) {
      throw Object.assign(new Error(`The alternative must use the same NetSuite vendor (${vendor.vendorName || vendor.vendorId}) as this PO load.`), { status: 409 });
    }
    const toPlt = positive(item.to_plt);
    const itemWeight = positive(item.item_weight);
    if (toPlt <= EPSILON || itemWeight <= EPSILON) {
      throw Object.assign(new Error("The alternative needs both a pallet conversion and item weight before it can be added."), { status: 409 });
    }
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
  const palletPatch = palletQuantityOverridePatch(values);
  if (palletPatch !== null) {
    for (const [destinationLocationId, quantity] of palletPatch) {
      await setSmartScmPalletQuantityOverride(id, Number(destinationLocationId), quantity === null
        ? { reset: true }
        : { quantity }, operatorId);
    }
  }
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
  for (const response of responses) {
    const vendorReplyDraft = {
      decision: response.decision,
      decisionPallets: response.decisionPallets
    };
    await query(
      `UPDATE scm_smart_proposal_lines
          SET vendor_decision = $2,
              reason = jsonb_set(COALESCE(reason, '{}'::jsonb), '{vendorReplyDraft}', $4::jsonb, true),
              updated_at = now()
        WHERE id = $1 AND proposal_id = $3`,
      [response.proposalLineId, response.decision, id, JSON.stringify(vendorReplyDraft)]
    );
  }
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
    details: {
      proposalId: id,
      runId: proposal.runId,
      responseCount: responses.length,
      loadStatus,
      palletQuantityOverrides: palletPatch === null
        ? smartScmNormalizePalletQuantityOverrides(proposal.palletQuantityOverrides)
        : Object.fromEntries(palletPatch),
      decisions: responses.map((response) => ({
        proposalLineId: Number(response.proposalLineId),
        decision: response.decision,
        requestedPallets: positive(response.requestedPallets),
        decisionPallets: positive(response.decisionPallets),
        confirmedPallets: positive(response.confirmedPallets),
        heldPallets: positive(response.heldPallets),
        remainderPallets: positive(response.remainderPallets)
      })),
      ...metadata
    }
  });
  return getSmartScmProposal(id);
  });
}

export async function stageSmartScmVendorReplyLoad(proposalId, values = {}, operatorId = null) {
  const id = Number(proposalId);
  const staged = await withTransaction(async () => {
    await query("SELECT id FROM scm_smart_proposals WHERE id = $1 FOR UPDATE", [id]);
    const source = await getSmartScmProposal(id);
    ensureEditableVendorLoad(source);
    const suppliedLines = Array.isArray(values.lines) ? values.lines : [];
    const suppliedByLine = new Map(suppliedLines.map((line) => [Number(line.proposalLineId || line.lineId), line]));
    const sourceLineIds = new Set(source.lines.map((line) => Number(line.id)));
    if ([...suppliedByLine.keys()].some((lineId) => !sourceLineIds.has(lineId))) {
      throw Object.assign(new Error("One or more vendor decisions do not belong to this PO load."), { status: 400 });
    }
    const lineInputs = source.lines.map((line) => ({
      proposalLineId: line.id,
      ...(suppliedByLine.get(Number(line.id)) || { decision: "confirm" })
    }));
    const decisions = source.lines.map((line) => normalizeSmartScmVendorDecision(
      line,
      lineInputs.find((input) => Number(input.proposalLineId) === Number(line.id))
    ));
    await saveSmartScmVendorReplyLoad(id, { ...values, lines: lineInputs }, operatorId);
    const confirmedDecisions = decisions.filter((decision) => decision.decision === "confirm");
    const heldDecisions = decisions.filter((decision) => decision.decision === "hold");
    const cancelledDecisions = decisions.filter((decision) => decision.decision === "cancel");
    const confirmedLineIds = confirmedDecisions.map((decision) => Number(decision.proposalLineId));
    const heldLineIds = heldDecisions.map((decision) => Number(decision.proposalLineId));
    const cancelledLineIds = cancelledDecisions.map((decision) => Number(decision.proposalLineId));
    const sourceLineById = new Map(source.lines.map((line) => [Number(line.id), line]));
    const hasHeldRemainder = heldDecisions.some((decision) => round(positive(decision.remainderPallets)) > EPSILON);
    let reviewProposalId = null;
    let cancelledProposalId = null;
    const heldSplits = [];

    if (confirmedLineIds.length) {
      reviewProposalId = await createVendorResolutionChild(source, {
        kind: "netsuite_po_review",
        status: "confirmed",
        label: "netsuite-review",
        operatorId
      });
      await query(
        `UPDATE scm_smart_proposal_lines l
            SET proposal_id = $1,
                vendor_decision = 'confirm',
                sales_quantity = confirmed_pallets * to_plt,
                line_weight_lbs = confirmed_pallets * pallet_weight_lbs,
                residual_pallets = GREATEST(proposed_pallets - confirmed_pallets, 0),
                last_purchase_price = (SELECT i.last_purchase_price FROM inventory_items i WHERE i.item_id = l.item_id),
                last_purchase_price_synced_at = (SELECT i.synced_at FROM inventory_items i WHERE i.item_id = l.item_id),
                purchase_unit = (SELECT i.purchase_unit FROM inventory_items i WHERE i.item_id = l.item_id),
                updated_at = now()
          WHERE l.proposal_id = $2 AND l.id = ANY($3::bigint[])`,
        [reviewProposalId, id, confirmedLineIds]
      );
      await snapshotReviewPalletItem(reviewProposalId);
      await refreshVendorResolutionProposal(reviewProposalId, { confirmed: true });
    }

    if (cancelledLineIds.length || hasHeldRemainder) {
      cancelledProposalId = await createVendorResolutionChild(source, {
        kind: "vendor_cancelled_history",
        status: "cancelled",
        label: "cancelled",
        operatorId
      });
      if (cancelledLineIds.length) {
        await query(
          `UPDATE scm_smart_proposal_lines
              SET proposal_id = $1,
                  vendor_decision = 'cancel',
                  confirmed_pallets = 0,
                  sales_quantity = 0,
                  line_weight_lbs = 0,
                  residual_pallets = proposed_pallets,
                  reason = COALESCE(reason, '{}'::jsonb) || jsonb_build_object(
                    'vendorCancellation', jsonb_build_object(
                      'sourceProposalId', $2,
                      'sourceLineId', id,
                      'cancelledPallets', proposed_pallets
                    )
                  ),
                  updated_at = now()
            WHERE proposal_id = $2 AND id = ANY($3::bigint[])`,
          [cancelledProposalId, id, cancelledLineIds]
        );
      }
    }

    for (const decision of heldDecisions) {
      const line = sourceLineById.get(Number(decision.proposalLineId));
      heldSplits.push(await splitHeldVendorLine({ source, line, decision, cancelledProposalId }));
    }

    if (cancelledProposalId) await refreshVendorResolutionProposal(cancelledProposalId);
    await query(
      `UPDATE scm_smart_proposals
          SET status = 'superseded', vendor_reply_due_at = NULL,
              po_execution_status = 'idle', po_execution_error = NULL,
              superseded_at = now(), updated_at = now()
        WHERE id = $1`,
      [id]
    );
    await refreshVendorResolutionProposal(id);
    const heldProposalIds = heldSplits.map((split) => split.heldProposalId);
    const conservation = decisions.map((decision) => {
      const confirmedPallets = decision.decision === "confirm" ? positive(decision.decisionPallets) : 0;
      const confirmedResidualPallets = decision.decision === "confirm" ? positive(decision.remainderPallets) : 0;
      const heldPallets = decision.decision === "hold" ? positive(decision.decisionPallets) : 0;
      const cancelledPallets = decision.decision === "cancel"
        ? positive(decision.requestedPallets)
        : decision.decision === "hold"
          ? positive(decision.remainderPallets)
          : 0;
      const accountedPallets = round(confirmedPallets + confirmedResidualPallets + heldPallets + cancelledPallets);
      return {
        sourceLineId: Number(decision.proposalLineId),
        decision: decision.decision,
        requestedPallets: positive(decision.requestedPallets),
        confirmedPallets,
        confirmedResidualPallets,
        heldPallets,
        cancelledPallets,
        accountedPallets,
        conserved: Math.abs(accountedPallets - positive(decision.requestedPallets)) <= EPSILON
      };
    });
    await recordStructuralRevision(source.runId, "vendor_reply_staged", {
      sourceProposalId: id,
      reviewProposalId,
      cancelledProposalId,
      heldProposalIds,
      confirmedLineIds,
      heldLineIds,
      cancelledLineIds,
      heldSplits,
      conservation
    }, operatorId);
    return {
      sourceProposalId: id,
      runId: source.runId,
      reviewProposalId,
      cancelledProposalId,
      heldProposalIds,
      confirmedLineIds,
      heldLineIds,
      cancelledLineIds,
      heldSplits,
      conservation
    };
  });
  const source = await getSmartScmProposal(staged.sourceProposalId);
  const review = staged.reviewProposalId ? await getSmartScmNetSuitePoReviewLoad(staged.reviewProposalId) : null;
  const cancelled = staged.cancelledProposalId ? await getSmartScmProposal(staged.cancelledProposalId) : null;
  const heldLoads = [];
  for (const heldProposalId of staged.heldProposalIds) {
    heldLoads.push(await getSmartScmProposal(heldProposalId));
  }
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.vendor_reply.staged",
    details: staged
  });
  return { ...staged, source, review, cancelled, heldLoads };
}

export async function prepareSmartScmPurchaseExecution(proposalId, operatorId = null, options = {}) {
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
    if (proposal.vendor_resolution_kind !== "netsuite_po_review") {
      throw Object.assign(new Error("Confirm the vendor load into NetSuite PO review before inserting a purchase order."), { status: 409 });
    }
    if (proposal.netsuite_purchase_order_id || proposal.netsuite_purchase_order_ref) {
      throw Object.assign(new Error("This load already has a purchase-order reference. Do not create a duplicate PO."), { status: 409 });
    }
    if (!["confirmed", "failed"].includes(proposal.status)) {
      throw Object.assign(new Error("Only a confirmed or failed NetSuite PO review can be inserted."), { status: 409 });
    }
    const lines = (proposal.lines || []).filter((line) => positive(line.confirmed_pallets) > EPSILON);
    if (!lines.length) throw Object.assign(new Error("At least one line needs a confirmed quantity before creating the PO."), { status: 409 });
    if (lines.some((line) => positive(line.to_plt) <= EPSILON || positive(line.pallet_weight_lbs) <= EPSILON)) {
      throw Object.assign(new Error("Every confirmed line needs a pallet conversion and weight before creating the PO."), { status: 409 });
    }
    const preparedLines = lines.map((line) => ({
      id: Number(line.id),
      itemId: Number(line.item_id),
      itemName: line.item_name,
      unit: line.unit,
      purchaseUnit: line.purchase_unit,
      lastPurchasePrice: line.last_purchase_price === null ? null : number(line.last_purchase_price, null),
      lastPurchasePriceSyncedAt: line.last_purchase_price_synced_at || null,
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
    }));
    const palletItemId = proposal.pallet_item_id === null ? null : Number(proposal.pallet_item_id);
    const palletItem = {
      id: palletItemId,
      itemId: palletItemId,
      itemName: proposal.pallet_item_name || "PALLET",
      unit: proposal.pallet_unit || null,
      purchaseUnit: proposal.pallet_purchase_unit || null,
      lastPurchasePrice: proposal.pallet_last_purchase_price === null ? null : number(proposal.pallet_last_purchase_price, null),
      lastPurchasePriceSyncedAt: proposal.pallet_price_synced_at || null
    };
    const palletQuantityOverrides = smartScmNormalizePalletQuantityOverrides(proposal.pallet_quantity_overrides);
    const palletLines = resolvedPalletLines(preparedLines, {
      destinationLocationId: Number(proposal.destination_location_id),
      destinationName: proposal.destination_name,
      palletQuantityOverrides
    }, palletItem, { confirmed: true });
    const validationTarget = {
      lines: preparedLines,
      palletLines,
      palletItemId,
      palletItemName: palletItem.itemName,
      palletUnit: palletItem.unit,
      palletPurchaseUnit: palletItem.purchaseUnit,
      palletLastPurchasePrice: palletItem.lastPurchasePrice
    };
    const blockers = smartScmPoReviewBlockers(validationTarget);
    const needsPalletItem = palletLines.some((line) => positive(line.purchaseQuantity) > EPSILON);
    const currentItemIds = [...new Set([...preparedLines.map((line) => line.itemId), needsPalletItem ? palletItemId : null]
      .filter((itemId) => Number.isInteger(itemId) && itemId > 0))];
    const currentResult = await query(
      `SELECT item_id, item_name, stock_unit, purchase_unit
         FROM inventory_items WHERE item_id = ANY($1::bigint[])`,
      [currentItemIds]
    );
    const currentByItem = new Map(currentResult.rows.map((row) => [Number(row.item_id), row]));
    for (const line of preparedLines) {
      const current = currentByItem.get(line.itemId);
      if (!current) {
        blockers.push({ code: "item_missing_after_snapshot", itemId: line.itemId, itemName: line.itemName, message: line.itemName + " is no longer available in Item Master." });
        continue;
      }
      if (normalizedUnit(current.purchase_unit) !== normalizedUnit(line.purchaseUnit)
        || normalizedUnit(current.stock_unit) !== normalizedUnit(line.unit)) {
        blockers.push({ code: "purchase_unit_changed_after_snapshot", itemId: line.itemId, itemName: line.itemName, message: line.itemName + "'s stock or purchase unit changed after vendor confirmation. Refresh and restage the vendor load." });
      }
    }
    const currentPallet = currentByItem.get(palletItemId);
    if (needsPalletItem && Number.isInteger(palletItemId) && palletItemId > 0 && !currentPallet) {
      blockers.push({ code: "pallet_missing_after_snapshot", itemId: palletItemId, itemName: palletItem.itemName, message: "PALLET is no longer available in Item Master." });
    } else if (needsPalletItem && currentPallet && (normalizedUnit(currentPallet.purchase_unit) !== normalizedUnit(palletItem.purchaseUnit)
      || normalizedUnit(currentPallet.stock_unit) !== normalizedUnit(palletItem.unit))) {
      blockers.push({ code: "pallet_unit_changed_after_snapshot", itemId: palletItemId, itemName: palletItem.itemName, message: "PALLET's stock or purchase unit changed after vendor confirmation. Refresh and restage the vendor load." });
    }
    if (blockers.length) {
      const error = Object.assign(new Error("PO insertion is blocked: " + blockers.map((blocker) => blocker.message).join(" ")), { status: 409 });
      error.blockers = blockers;
      throw error;
    }
    const vendor = await vendorIdentityForProposal(proposal.id, { confirmedOnly: true });
    const settings = await settingsRow();
    const requestedExecutionMode = text(options.executionMode).toLowerCase();
    const executionMode = ["mock", "live"].includes(requestedExecutionMode)
      ? requestedExecutionMode
      : ["mock", "live"].includes(proposal.execution_mode)
        ? proposal.execution_mode
        : settings.execution_mode;
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
          SET status = 'executing', execution_mode = $3,
              po_execution_status = 'creating', po_execution_error = NULL,
              confirmed_at = now(), confirmed_by = $2, updated_at = now()
        WHERE id = $1`,
      [proposal.id, operatorId, executionMode]
    );
    return {
      id: Number(proposal.id),
      runId: Number(proposal.run_id),
      parentProposalId: proposal.parent_proposal_id === null ? null : Number(proposal.parent_proposal_id),
      vendorResolutionKind: proposal.vendor_resolution_kind,
      priceSnapshotAt: proposal.price_snapshot_at,
      mode: executionMode,
      vendorId: vendor.vendorId,
      vendorName: vendor.vendorName || proposal.vendor || proposal.source_name,
      destinationLocationId: Number(proposal.destination_location_id),
      destinationName: proposal.destination_name,
      memo: proposal.memo,
      readyDate: proposal.vendor_ready_date,
      vendorReference: proposal.vendor_reference,
      palletItemId,
      palletItemName: palletItem.itemName,
      palletUnit: palletItem.unit,
      palletPurchaseUnit: palletItem.purchaseUnit,
      palletLastPurchasePrice: palletItem.lastPurchasePrice,
      palletPriceSyncedAt: palletItem.lastPurchasePriceSyncedAt,
      palletQuantityOverrides,
      palletItem,
      palletLines,
      totalPallets: round(lines.reduce((sum, line) => sum + positive(line.confirmed_pallets), 0)),
      lines: preparedLines
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
        SET status = 'failed', po_execution_status = 'failed', po_execution_error = $2, updated_at = now()
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
