import crypto from "node:crypto";
import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { createScmPurchaseOrderSplit } from "./dispatch-repository.js";
import {
  getSmartScmPlanningRun,
  getSmartScmProposal,
  loadSmartScmPlanningDemandStates,
  smartScmPackWholePalletLines,
  smartScmProposalLineForState,
  smartScmUrgencyRank,
  smartScmUrgencySummary
} from "./smart-scm-planning-repository.js";
import {
  getSmartScmProposalInventorySnapshot,
  getSmartScmProposalItemPolicy,
  recordSmartScmProposalRevision,
  refreshSmartScmProposalDerived
} from "./smart-scm-proposal-editor.js";
import { getSmartScmRouteRule, smartScmRouteRuleKey } from "./smart-scm-route-repository.js";

const EPSILON = 0.000001;
const BLANKET_PENDING_ALLOCATION_STATUSES = Object.freeze(["reserved", "held"]);
const BLANKET_PENDING_RELEASE_STATUSES = Object.freeze(["reserved", "partially_released", "held"]);
const BLANKET_DESTINATIONS = Object.freeze(new Map([
  [1, "3445"],
  [28, "2967"],
  [15, "12441"],
  [26, "150"]
]));

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback = 0) {
  return Math.max(0, number(value, fallback));
}

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((number(value) + Number.EPSILON) * factor) / factor;
}

function text(value) {
  return String(value ?? "").trim();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function payloadFingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalJson(value || {}))).digest("hex");
}

function integer(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function httpError(message, status = 400, code = "") {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10))) return value.slice(0, 10);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function validIsoDate(value) {
  const candidate = text(value);
  if (!candidate) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate) || Number.isNaN(new Date(`${candidate}T00:00:00Z`).getTime())) {
    throw httpError("Ready date must use a valid YYYY-MM-DD value.");
  }
  return candidate;
}

function sourceOrderRow(row = {}) {
  return {
    netsuiteId: Number(row.source_po_id),
    orderRef: row.source_po_ref,
    transactionDate: dateOnly(row.trandate),
    vendorId: row.vendor_id === null ? null : Number(row.vendor_id),
    vendor: row.vendor || "",
    pickupPoint: row.pickup_point || row.vendor || "",
    status: row.status_text || "",
    isBlanket: row.is_blanket_po === true,
    flaggedAt: row.blanket_flagged_at || null,
    flaggedBy: row.blanket_flagged_by || "",
    remainingPallets: 0,
    remainingSalesQty: 0,
    lines: []
  };
}

function sourceLineRow(row = {}) {
  return {
    sourcePoId: Number(row.source_po_id),
    sourcePoRef: row.source_po_ref,
    sourceLineId: Number(row.source_line_id),
    lineId: row.line_id === null ? null : Number(row.line_id),
    itemId: Number(row.item_id),
    itemName: row.item_name || row.sku || "",
    sku: row.sku || row.item_name || "",
    description: row.item_description || "",
    unit: row.unit || "",
    toPlt: positive(row.to_plt),
    toLyr: positive(row.to_lyr),
    toSec: positive(row.to_sec),
    toPcs: positive(row.to_pcs),
    palletWeightLbs: positive(row.pallet_weight_lbs),
    remainingPallets: positive(row.remaining_pallets),
    remainingSalesQty: positive(row.remaining_sales_qty),
    orderedSalesQty: positive(row.ordered_sales_qty),
    receivedBaselineSalesQty: positive(row.received_baseline_sales_qty),
    allocatedSalesQty: positive(row.allocated_sales_qty),
    reservedSalesQty: positive(row.reserved_sales_qty)
  };
}

async function blanketPoolLineRows({
  search = "",
  isBlanket = null,
  sourcePoId = null,
  limit = 10000,
  offset = 0
} = {}) {
  const cleanSearch = text(search).slice(0, 160);
  const selectedSourcePoId = integer(sourcePoId);
  const maxRows = Math.min(20000, Math.max(1, Number(limit) || 10000));
  const rowOffset = Math.max(0, Number(offset) || 0);
  const result = await query(
    `WITH sales_alloc AS (
       SELECT po_line_id,
              SUM(allocated_pallet_qty) AS pallet_qty,
              SUM(allocated_sales_qty) AS sales_qty
         FROM dispatch_so_po_allocations
        WHERE status = 'active'
        GROUP BY po_line_id
     ), split_alloc AS (
       SELECT split_line.source_line_id,
              SUM(split_line.pallet_qty) AS pallet_qty,
              SUM(split_line.sales_qty) AS sales_qty
         FROM dispatch_scm_po_split_lines split_line
         JOIN dispatch_scm_po_splits split_header
           ON split_header.id = split_line.split_id
          AND split_header.status = 'active'
        GROUP BY split_line.source_line_id
     ), blanket_alloc AS (
       SELECT allocation.source_line_id,
              SUM(CASE
                WHEN allocation.status = 'reserved' THEN allocation.reserved_pallets
                WHEN allocation.status = 'held' THEN allocation.held_pallets
                ELSE 0
              END) AS pallet_qty,
              SUM(CASE
                WHEN allocation.status = 'reserved' THEN allocation.reserved_sales_qty
                WHEN allocation.status = 'held' THEN allocation.held_sales_qty
                ELSE 0
              END) AS sales_qty
         FROM scm_smart_blanket_allocations allocation
        WHERE allocation.status = ANY($6::text[])
        GROUP BY allocation.source_line_id
     ), calculated AS (
       SELECT po.netsuite_id AS source_po_id,
              po.tranid AS source_po_ref,
              po.trandate,
              po.vendor_id,
              po.vendor,
              COALESCE(NULLIF(po.dispatch_vendor_yard, ''), NULLIF(po.source_location, ''), po.vendor) AS pickup_point,
              po.status_text,
              po.is_blanket_po,
              po.blanket_flagged_at,
              po.blanket_flagged_by,
              line.id AS source_line_id,
              line.line_id,
              line.item_id,
              line.item_name,
              line.sku,
              line.item_description,
              line.unit,
              line.to_plt,
              line.to_lyr,
              line.to_sec,
              line.to_pcs,
              CASE WHEN COALESCE(line.item_weight, 0) > 0 AND COALESCE(line.to_plt, 0) > 0
                   THEN line.item_weight * line.to_plt ELSE 0 END AS pallet_weight_lbs,
              GREATEST(COALESCE(line.quantity, 0), 0) AS ordered_sales_qty,
              GREATEST(COALESCE(line.netsuite_received_baseline_qty, line.netsuite_received_qty, 0), 0) AS received_baseline_sales_qty,
              COALESCE(sales.sales_qty, 0) + COALESCE(split.sales_qty, 0) AS allocated_sales_qty,
              COALESCE(blanket.sales_qty, 0) AS reserved_sales_qty,
              GREATEST(
                COALESCE(line.quantity, 0)
                - COALESCE(line.netsuite_received_baseline_qty, line.netsuite_received_qty, 0)
                - COALESCE(sales.sales_qty, 0)
                - COALESCE(split.sales_qty, 0)
                - COALESCE(blanket.sales_qty, 0),
                0
              ) AS remaining_sales_qty,
              CASE WHEN COALESCE(line.to_plt, 0) > 0 THEN GREATEST(LEAST(
                FLOOR((GREATEST(
                  COALESCE(line.quantity, 0)
                  - COALESCE(line.netsuite_received_baseline_qty, line.netsuite_received_qty, 0)
                  - COALESCE(sales.sales_qty, 0)
                  - COALESCE(split.sales_qty, 0)
                  - COALESCE(blanket.sales_qty, 0),
                  0
                ) / line.to_plt) + 0.000001),
                CASE WHEN COALESCE(line.pallet_qty, 0) > 0
                  THEN GREATEST(
                    COALESCE(line.pallet_qty, 0)
                    - COALESCE(sales.pallet_qty, 0)
                    - COALESCE(split.pallet_qty, 0)
                    - COALESCE(blanket.pallet_qty, 0),
                    0
                  )
                  ELSE FLOOR((GREATEST(
                    COALESCE(line.quantity, 0)
                    - COALESCE(line.netsuite_received_baseline_qty, line.netsuite_received_qty, 0)
                    - COALESCE(sales.sales_qty, 0)
                    - COALESCE(split.sales_qty, 0)
                    - COALESCE(blanket.sales_qty, 0),
                    0
                  ) / line.to_plt) + 0.000001)
                END
              ), 0) ELSE 0 END AS remaining_pallets
         FROM purchase_orders po
         JOIN purchase_order_lines line
           ON line.purchase_order_id = po.netsuite_id
          AND line.netsuite_active = true
         LEFT JOIN sales_alloc sales ON sales.po_line_id = line.id
         LEFT JOIN split_alloc split ON split.source_line_id = line.id
         LEFT JOIN blanket_alloc blanket ON blanket.source_line_id = line.id
        WHERE po.netsuite_active = true
          AND line.item_id IS NOT NULL
          AND COALESCE(line.to_plt, 0) > 0
          AND COALESCE(line.item_weight, 0) > 0
          AND (po.status_text ILIKE '%Pending Receipt%' OR po.status_text ILIKE '%Partially Received%')
          AND NOT EXISTS (
            SELECT 1
              FROM dispatch_scm_po_splits child_split
             WHERE child_split.split_po_id = po.netsuite_id
          )
          AND ($1::bigint IS NULL OR po.netsuite_id = $1)
          AND ($2::boolean IS NULL OR po.is_blanket_po = $2)
          AND ($3 = '' OR concat_ws(' ', po.tranid, po.vendor, po.dispatch_vendor_yard,
                 po.source_location, line.item_id::text, line.item_name, line.sku, line.item_description) ILIKE '%' || $3 || '%')
     )
     SELECT *
       FROM calculated
      WHERE remaining_pallets > 0
      ORDER BY trandate NULLS LAST, source_po_id, source_line_id
      LIMIT $4 OFFSET $5`,
    [selectedSourcePoId, isBlanket, cleanSearch, maxRows, rowOffset, BLANKET_PENDING_ALLOCATION_STATUSES]
  );
  return result.rows;
}

async function openSourcePurchaseOrderRows({ search = "", isBlanket = null, limit = 500, offset = 0 } = {}) {
  const cleanSearch = text(search).slice(0, 160);
  const rowLimit = Math.min(1000, Math.max(1, Number(limit) || 500));
  const rowOffset = Math.max(0, Number(offset) || 0);
  const result = await query(
    `SELECT po.netsuite_id AS source_po_id,
            po.tranid AS source_po_ref,
            po.trandate,
            po.vendor_id,
            po.vendor,
            COALESCE(NULLIF(po.dispatch_vendor_yard, ''), NULLIF(po.source_location, ''), po.vendor) AS pickup_point,
            po.status_text,
            po.is_blanket_po,
            po.blanket_flagged_at,
            po.blanket_flagged_by
       FROM purchase_orders po
      WHERE po.netsuite_active = true
        AND (po.status_text ILIKE '%Pending Receipt%' OR po.status_text ILIKE '%Partially Received%')
        AND NOT EXISTS (
          SELECT 1
            FROM dispatch_scm_po_splits child_split
           WHERE child_split.split_po_id = po.netsuite_id
        )
        AND ($1::boolean IS NULL OR po.is_blanket_po = $1)
        AND ($2 = '' OR concat_ws(' ', po.tranid, po.vendor, po.dispatch_vendor_yard, po.source_location) ILIKE '%' || $2 || '%'
          OR EXISTS (
            SELECT 1
              FROM purchase_order_lines line
             WHERE line.purchase_order_id = po.netsuite_id
               AND line.netsuite_active = true
               AND concat_ws(' ', line.item_id::text, line.item_name, line.sku, line.item_description) ILIKE '%' || $2 || '%'
          ))
      ORDER BY po.trandate NULLS LAST, po.netsuite_id
      LIMIT $3 OFFSET $4`,
    [isBlanket, cleanSearch, rowLimit, rowOffset]
  );
  return result.rows;
}

function mergeSourceOrders(headers = [], lines = []) {
  const grouped = new Map(headers.map((row) => [Number(row.source_po_id), sourceOrderRow(row)]));
  for (const row of lines) {
    const id = Number(row.source_po_id);
    const order = grouped.get(id);
    if (!order) continue;
    const line = sourceLineRow(row);
    order.lines.push(line);
    order.remainingPallets = round(order.remainingPallets + line.remainingPallets);
    order.remainingSalesQty = round(order.remainingSalesQty + line.remainingSalesQty);
  }
  return [...grouped.values()];
}

function publicAllocation(row = {}) {
  return {
    id: Number(row.id),
    proposalId: Number(row.proposal_id),
    proposalLineId: Number(row.proposal_line_id),
    releaseId: row.release_id === null ? null : Number(row.release_id),
    sourcePoId: Number(row.source_po_id),
    sourcePoRef: row.source_po_ref,
    sourceLineId: Number(row.source_line_id),
    itemId: Number(row.item_id),
    destinationLocationId: Number(row.destination_location_id),
    destinationName: row.destination_name,
    plannedPallets: positive(row.planned_pallets),
    plannedSalesQty: positive(row.planned_sales_qty),
    reservedPallets: positive(row.reserved_pallets),
    reservedSalesQty: positive(row.reserved_sales_qty),
    releasedPallets: positive(row.released_pallets),
    releasedSalesQty: positive(row.released_sales_qty),
    heldPallets: positive(row.held_pallets),
    heldSalesQty: positive(row.held_sales_qty),
    cancelledPallets: positive(row.cancelled_pallets),
    cancelledSalesQty: positive(row.cancelled_sales_qty),
    status: row.status,
    splitLineId: row.split_line_id === null ? null : Number(row.split_line_id)
  };
}

function publicRelease(row = {}) {
  return {
    id: Number(row.id),
    proposalId: Number(row.proposal_id),
    runId: Number(row.run_id),
    sourcePoId: Number(row.source_po_id),
    sourcePoRef: row.source_po_ref,
    status: row.status,
    splitId: row.split_id === null ? null : Number(row.split_id),
    splitPoId: row.split_po_id === null ? null : Number(row.split_po_id),
    splitPoRef: row.split_po_ref || null,
    readyDate: dateOnly(row.ready_date),
    vendorReference: row.vendor_reference || "",
    packingNumber: row.packing_number || "",
    creditStatus: row.credit_status || "",
    remarks: row.remarks || "",
    metadata: row.metadata || {},
    reservedAt: row.reserved_at,
    reservedBy: row.reserved_by || "",
    finalizedAt: row.finalized_at,
    finalizedBy: row.finalized_by || "",
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    allocations: Array.isArray(row.allocations) ? row.allocations.map(publicAllocation) : [],
    events: Array.isArray(row.events) ? row.events.map((event) => ({
      id: Number(event.id),
      eventType: event.event_type,
      actor: event.actor || "",
      details: event.details || {},
      createdAt: event.created_at
    })) : []
  };
}

async function releaseRows({ releaseId = null, proposalId = null, limit = 500, lock = false } = {}) {
  const result = await query(
    `SELECT release.*,
            COALESCE((
              SELECT jsonb_agg(to_jsonb(allocation) ORDER BY allocation.id)
                FROM scm_smart_blanket_allocations allocation
               WHERE allocation.release_id = release.id
            ), '[]'::jsonb) AS allocations,
            COALESCE((
              SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id)
                FROM scm_smart_blanket_release_events event
               WHERE event.release_id = release.id
            ), '[]'::jsonb) AS events
       FROM scm_smart_blanket_releases release
      WHERE ($1::bigint IS NULL OR release.id = $1)
        AND ($2::bigint IS NULL OR release.proposal_id = $2)
      ORDER BY release.id DESC
      LIMIT $3
      ${lock ? "FOR UPDATE OF release" : ""}`,
    [integer(releaseId), integer(proposalId), Math.min(1000, Math.max(1, Number(limit) || 500))]
  );
  return result.rows;
}

async function enrichedBlanketProposals(run) {
  if (!run) return [];
  const proposalIds = run.proposals.map((proposal) => proposal.id);
  if (!proposalIds.length) return run.proposals;
  const allocations = await query(
    `SELECT *
       FROM scm_smart_blanket_allocations
      WHERE proposal_id = ANY($1::bigint[])
      ORDER BY proposal_id, proposal_line_id, id`,
    [proposalIds]
  );
  const byProposal = new Map();
  for (const row of allocations.rows) {
    const id = Number(row.proposal_id);
    if (!byProposal.has(id)) byProposal.set(id, []);
    byProposal.get(id).push(publicAllocation(row));
  }
  return run.proposals.map((proposal) => ({
    ...proposal,
    blanketAllocations: byProposal.get(proposal.id) || []
  }));
}

export async function listSmartScmBlanketWorkspace({ search = "", limit = 100, offset = 0 } = {}) {
  const rowLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const [blanketHeaders, candidateHeaders, blanketRows, candidateRows, latest, releases] = await Promise.all([
    openSourcePurchaseOrderRows({ isBlanket: true, limit: 1000 }),
    openSourcePurchaseOrderRows({ search, isBlanket: false, limit: rowLimit, offset }),
    blanketPoolLineRows({ isBlanket: true, limit: 20000 }),
    blanketPoolLineRows({ search, isBlanket: false, limit: 20000 }),
    query(
      `SELECT id
         FROM scm_smart_planning_runs
        WHERE plan_kind = 'blanket' AND status = 'ready'
        ORDER BY id DESC
        LIMIT 1`
    ),
    releaseRows({ limit: 500 })
  ]);
  const latestRun = latest.rows[0]?.id ? await getSmartScmPlanningRun(latest.rows[0].id) : null;
  const proposals = await enrichedBlanketProposals(latestRun);
  return {
    blanketOrders: mergeSourceOrders(blanketHeaders, blanketRows),
    candidates: mergeSourceOrders(candidateHeaders, candidateRows),
    proposals,
    releases: releases.map(publicRelease),
    latestRun: latestRun ? { ...latestRun, proposals } : null
  };
}

function demandSort(left, right) {
  const urgency = smartScmUrgencyRank(right.urgencyLevel, right.urgent)
    - smartScmUrgencyRank(left.urgencyLevel, left.urgent);
  if (urgency) return urgency;
  const score = positive(right.urgencyScore) - positive(left.urgencyScore);
  if (Math.abs(score) > EPSILON) return score;
  return Number(left.policy.location_id) - Number(right.policy.location_id);
}

function sourceIdentity(row = {}) {
  return text(row.pickup_point || row.vendor || row.source_po_ref || "Blanket PO");
}

function loadMemo(sourcePoRef, loadIndex, lines) {
  return `Blanket ${sourcePoRef} · load ${loadIndex} · ${lines.length} item${lines.length === 1 ? "" : "s"}`;
}

async function insertBlanketProposal(runId, source, load, loadIndex, settings, lineage) {
  const priority = smartScmUrgencySummary(load.lines);
  const stops = load.routeStops || [];
  const proposal = await query(
    `INSERT INTO scm_smart_proposals (
       run_id, proposal_key, proposal_type, phase, source_kind, source_name,
       destination_location_id, destination_name, vendor, plant, status,
       urgent, urgency_level, urgency_score, provisional, total_pallets,
       total_weight_lbs, utilization, memo, route_stops, proposal_origin,
       blanket_source_po_id, blanket_source_po_ref
     ) VALUES (
       $1,$2,'PO','direct_vendor','vendor',$3,$4,$5,$6,$3,'held',
       $7,$8,$9,false,$10,$11,$12,$13,$14::jsonb,'blanket',$15,$16
     ) RETURNING id`,
    [
      runId,
      `blanket:${source.source_po_id}:load:${loadIndex}`,
      sourceIdentity(source),
      stops[0]?.locationId || load.lines[0]?.destinationLocationId,
      stops[0]?.name || load.lines[0]?.destinationName,
      source.vendor || null,
      priority.urgent,
      priority.urgencyLevel,
      priority.urgencyScore,
      load.totalPallets,
      load.totalWeight,
      round(load.totalWeight / positive(settings.truck_capacity_lbs, 78000)),
      loadMemo(source.source_po_ref, loadIndex, load.lines),
      JSON.stringify(stops),
      source.source_po_id,
      source.source_po_ref
    ]
  );
  const proposalId = Number(proposal.rows[0].id);
  for (const line of load.lines) {
    const inserted = await query(
      `INSERT INTO scm_smart_proposal_lines (
         proposal_id, item_id, item_name, item_description, unit,
         required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
         sales_quantity, pallet_weight_lbs, line_weight_lbs, to_plt, to_lyr,
         to_sec, to_pcs, manual_planning_required, reason,
         destination_location_id, destination_name, urgent, urgency_level,
         urgency_score, provisional
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,0,$7,$8,$9,$10,$11,$12,$13,$14,false,$15::jsonb,
         $16,$17,$18,$19,$20,false
       ) RETURNING id`,
      [
        proposalId,
        line.itemId,
        line.itemName,
        line.itemDescription,
        line.unit,
        line.requiredPallets,
        line.proposedPallets,
        line.salesQuantity,
        line.palletWeight,
        line.lineWeight,
        line.toPlt,
        line.toLyr,
        line.toSec,
        line.toPcs,
        JSON.stringify({ ...(line.reason || {}), blanketSourcePoId: Number(source.source_po_id), blanketSourcePoRef: source.source_po_ref }),
        line.destinationLocationId,
        line.destinationName,
        line.urgent,
        line.urgencyLevel,
        line.urgencyScore
      ]
    );
    const proposalLineId = Number(inserted.rows[0].id);
    let remaining = positive(line.proposedPallets);
    const candidates = lineage.filter((entry) => Number(entry.item_id) === Number(line.itemId)
      && positive(entry.remainingForLineage) > EPSILON);
    for (const entry of candidates) {
      if (remaining <= EPSILON) break;
      const pallets = Math.min(remaining, positive(entry.remainingForLineage));
      const salesQty = round(pallets * positive(entry.to_plt));
      await query(
        `INSERT INTO scm_smart_blanket_allocations (
           proposal_id, proposal_line_id, source_po_id, source_po_ref,
           source_line_id, item_id, destination_location_id, destination_name,
           planned_pallets, planned_sales_qty
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [proposalId, proposalLineId, source.source_po_id, source.source_po_ref,
          entry.source_line_id, line.itemId, line.destinationLocationId,
          line.destinationName, pallets, salesQty]
      );
      entry.remainingForLineage = round(positive(entry.remainingForLineage) - pallets);
      remaining = round(remaining - pallets);
    }
    if (remaining > EPSILON) throw new Error(`Blanket source lineage was lost for ${line.itemName}.`);
  }
  return proposalId;
}

export async function buildSmartScmBlanketPlan(operatorId = null) {
  let failure = null;
  const runId = await withTransaction(async () => {
    // Only one pool snapshot may be materialized at a time. Holding this
    // transaction-scoped advisory lock through the ready/failed transition
    // prevents two concurrent requests from exposing overlapping current plans.
    await query("SELECT pg_advisory_xact_lock(hashtext('smart-scm-blanket-plan-build'))");
    const [planning, poolRows] = await Promise.all([
      loadSmartScmPlanningDemandStates({ includeTemporarilyExcluded: false }),
      blanketPoolLineRows({ isBlanket: true, limit: 20000 })
    ]);
    const created = await query(
      `INSERT INTO scm_smart_planning_runs (
         status, trigger_source, forecast_run_id, settings_snapshot, created_by, plan_kind
       ) VALUES ('running', 'blanket_manual', $1, $2::jsonb, $3, 'blanket')
       RETURNING id`,
      [planning.forecastRunId, JSON.stringify(planning.settings), operatorId]
    );
    const nextRunId = Number(created.rows[0].id);
    try {
    const mutablePool = poolRows.map((row) => ({ ...row, remainingForPlanning: Math.floor(positive(row.remaining_pallets)) }));
    const lineDraftsBySource = new Map();
    for (const state of planning.states
      .filter((candidate) => positive(candidate.requiredPallets) >= 1 && candidate.policy.temporarily_excluded !== true)
      .sort(demandSort)) {
      let needed = Math.floor(positive(state.requiredPallets));
      const candidates = mutablePool.filter((row) => Number(row.item_id) === Number(state.policy.item_id)
        && Math.abs(positive(row.to_plt) - positive(state.toPlt)) <= EPSILON
        && positive(row.remainingForPlanning) >= 1);
      for (const source of candidates) {
        if (needed < 1) break;
        const pallets = Math.min(needed, Math.floor(positive(source.remainingForPlanning)));
        const line = smartScmProposalLineForState(state, pallets, {
          blanketPool: true,
          blanketSourcePoId: Number(source.source_po_id),
          blanketSourcePoRef: source.source_po_ref,
          blanketSourceLineId: Number(source.source_line_id),
          blanketRemainingBeforePallets: positive(source.remainingForPlanning)
        });
        const key = String(source.source_po_id);
        if (!lineDraftsBySource.has(key)) lineDraftsBySource.set(key, { source, lines: [] });
        lineDraftsBySource.get(key).lines.push(line);
        source.remainingForPlanning = round(positive(source.remainingForPlanning) - pallets);
        needed -= pallets;
      }
    }

    const proposalIds = [];
    await withTransaction(async () => {
      await query(
        `UPDATE scm_smart_proposals proposal
            SET status = 'superseded', superseded_at = now(), updated_at = now()
           FROM scm_smart_planning_runs run
          WHERE run.id = proposal.run_id
            AND run.plan_kind = 'blanket'
            AND run.id <> $1
            AND proposal.proposal_origin = 'blanket'
            AND proposal.status = 'held'
            AND NOT EXISTS (
              SELECT 1 FROM scm_smart_blanket_releases release WHERE release.proposal_id = proposal.id
            )`,
        [nextRunId]
      );
      await query(
        `UPDATE scm_smart_planning_runs
            SET status = 'superseded', completed_at = COALESCE(completed_at, now())
          WHERE plan_kind = 'blanket' AND id <> $1 AND status IN ('running', 'ready')`,
        [nextRunId]
      );
      for (const { source, lines } of lineDraftsBySource.values()) {
        const routeRule = planning.routeRules.get(smartScmRouteRuleKey(sourceIdentity(source)));
        const loads = smartScmPackWholePalletLines(lines, positive(planning.settings.truck_capacity_lbs, 78000), {
          proposalType: "PO",
          sourceName: sourceIdentity(source),
          maxStops: 2,
          routeRule
        });
        const lineage = poolRows
          .filter((row) => Number(row.source_po_id) === Number(source.source_po_id))
          .map((row) => ({ ...row, remainingForLineage: Math.floor(positive(row.remaining_pallets)) }));
        let loadIndex = 0;
        for (const load of loads) {
          loadIndex += 1;
          proposalIds.push(await insertBlanketProposal(nextRunId, source, load, loadIndex, planning.settings, lineage));
        }
      }
      const totals = {
        proposals: proposalIds.length,
        poProposals: proposalIds.length,
        toProposals: 0,
        sourcePurchaseOrders: lineDraftsBySource.size,
        poolPallets: round(poolRows.reduce((sum, row) => sum + positive(row.remaining_pallets), 0))
      };
      await query(
        `UPDATE scm_smart_planning_runs
            SET status = 'ready', totals = $2::jsonb, completed_at = now()
          WHERE id = $1`,
        [nextRunId, JSON.stringify(totals)]
      );
    });
    await writeAudit({
      actorOperatorId: operatorId,
      source: "smart_scm",
      action: "smart_scm.blanket.plan_built",
      details: { runId: nextRunId, proposalIds }
    });
    } catch (error) {
      await query(
        `UPDATE scm_smart_planning_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`,
        [nextRunId, error.message]
      );
      failure = error;
    }
    return nextRunId;
  });
  if (failure) throw failure;
  return getSmartScmPlanningRun(runId);
}

async function lockedBlanketProposal(proposalId) {
  const result = await query(
    `SELECT proposal.*, run.plan_kind, run.status AS run_status
       FROM scm_smart_proposals proposal
       JOIN scm_smart_planning_runs run ON run.id = proposal.run_id
      WHERE proposal.id = $1
      FOR UPDATE OF proposal, run`,
    [integer(proposalId)]
  );
  const proposal = result.rows[0];
  if (!proposal || proposal.proposal_origin !== "blanket" || proposal.plan_kind !== "blanket") {
    throw httpError("Blanket proposal was not found.", 404);
  }
  return proposal;
}

export async function updateSmartScmBlanketProposalLine(proposalId, lineId, values = {}, operatorId = null) {
  const id = integer(proposalId);
  const targetLineId = integer(lineId);
  const pallets = Number(values.proposedPallets ?? values.pallets);
  const destinationWasProvided = Object.prototype.hasOwnProperty.call(values, "destinationLocationId");
  if (!id || !targetLineId) throw httpError("Select a valid Blanket proposal line.");
  if (!Number.isInteger(pallets) || pallets <= 0) {
    throw httpError("Blanket release quantity must be a positive whole number of pallets.");
  }
  const outcome = await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext('smart-scm-blanket-plan-build'))");
    const proposal = await lockedBlanketProposal(id);
    if (proposal.status !== "held" || proposal.run_status !== "ready") {
      throw httpError("Only a held proposal in the current ready Blanket plan can be edited.", 409);
    }
    const existingRelease = await query(
      "SELECT id FROM scm_smart_blanket_releases WHERE proposal_id = $1 FOR UPDATE",
      [id]
    );
    if (existingRelease.rowCount) {
      throw httpError("This Blanket load is already reserved. Edit its quantities from Vendor Replies.", 409);
    }
    const source = await query(
      `SELECT netsuite_id, tranid, netsuite_active, is_blanket_po
         FROM purchase_orders
        WHERE netsuite_id = $1
        FOR UPDATE`,
      [proposal.blanket_source_po_id]
    );
    if (!source.rows[0]?.netsuite_active || source.rows[0]?.is_blanket_po !== true) {
      throw httpError("The source PO is no longer an active Blanket order. Calculate releases again.", 409, "SCM_BLANKET_SOURCE_CHANGED");
    }
    const lineResult = await query(
      "SELECT * FROM scm_smart_proposal_lines WHERE id = $1 AND proposal_id = $2 FOR UPDATE",
      [targetLineId, id]
    );
    if (!lineResult.rowCount) throw httpError("Blanket proposal line was not found.", 404);
    const line = lineResult.rows[0];
    const allocations = await query(
      `SELECT *
         FROM scm_smart_blanket_allocations
        WHERE proposal_id = $1 AND proposal_line_id = $2
        ORDER BY source_line_id, id
        FOR UPDATE`,
      [id, targetLineId]
    );
    if (!allocations.rowCount || allocations.rows.some((row) => row.status !== "planned" || row.release_id !== null)) {
      throw httpError("This Blanket line no longer has editable planned source allocations.", 409, "SCM_BLANKET_ALLOCATION_CHANGED");
    }
    if (allocations.rows.some((row) => Number(row.source_po_id) !== Number(proposal.blanket_source_po_id)
      || Number(row.item_id) !== Number(line.item_id))) {
      throw httpError("Blanket source lineage does not match this proposal line. Calculate releases again.", 409, "SCM_BLANKET_ALLOCATION_CHANGED");
    }

    const beforeDestinationLocationId = Number(line.destination_location_id);
    const destinationLocationId = destinationWasProvided
      ? integer(values.destinationLocationId)
      : beforeDestinationLocationId;
    const destinationName = BLANKET_DESTINATIONS.get(destinationLocationId);
    if (!destinationName) throw httpError("Select a valid destination yard.");
    const destinationChanged = destinationLocationId !== beforeDestinationLocationId;
    const policy = await getSmartScmProposalItemPolicy(line.item_id, destinationLocationId, { allowExcluded: true });
    if (!policy) {
      throw httpError(`${line.item_name} is not enabled for Smart SCM planning at ${destinationName}.`, 409);
    }
    const toPlt = positive(policy.to_plt);
    const palletWeight = positive(policy.pallet_weight_lbs);
    if (toPlt <= EPSILON || palletWeight <= EPSILON) {
      throw httpError(`${line.item_name} needs a pallet conversion and pallet weight at ${destinationName}.`, 409);
    }
    const duplicate = await query(
      `SELECT id
         FROM scm_smart_proposal_lines
        WHERE proposal_id = $1 AND item_id = $2 AND destination_location_id = $3 AND id <> $4`,
      [id, Number(line.item_id), destinationLocationId, targetLineId]
    );
    if (duplicate.rowCount) {
      throw httpError(`${line.item_name} already has a ${destinationName} line in this load. Adjust that line instead.`, 409);
    }
    const destinationRows = await query(
      "SELECT DISTINCT destination_location_id FROM scm_smart_proposal_lines WHERE proposal_id = $1 AND id <> $2",
      [id, targetLineId]
    );
    const nextDestinations = new Set(destinationRows.rows.map((row) => Number(row.destination_location_id)));
    nextDestinations.add(destinationLocationId);
    const routeRule = await getSmartScmRouteRule(proposal.source_name);
    const maximumDrops = routeRule.enabled === false
      ? 2
      : Math.max(1, Math.min(2, Number(routeRule.maxDrops) || 2));
    if (nextDestinations.size > maximumDrops) {
      throw httpError(`${proposal.source_name || "This Blanket source"} allows at most ${maximumDrops} destination${maximumDrops === 1 ? "" : "s"} per load.`, 409);
    }

    const sourceLineLocks = await query(
      `SELECT id
         FROM purchase_order_lines
        WHERE purchase_order_id = $1 AND item_id = $2 AND netsuite_active = true
        ORDER BY id
        FOR UPDATE`,
      [proposal.blanket_source_po_id, Number(line.item_id)]
    );
    if (!sourceLineLocks.rowCount) {
      throw httpError("The item is no longer available on this Blanket source PO. Calculate releases again.", 409, "SCM_BLANKET_POOL_CHANGED");
    }
    const otherPlannedRows = await query(
      `SELECT allocation.id, allocation.source_line_id, allocation.planned_pallets
         FROM scm_smart_blanket_allocations allocation
         JOIN scm_smart_proposals other_proposal ON other_proposal.id = allocation.proposal_id
        WHERE other_proposal.run_id = $1
          AND other_proposal.status = 'held'
          AND other_proposal.proposal_origin = 'blanket'
          AND allocation.source_po_id = $2
          AND allocation.item_id = $3
          AND allocation.proposal_line_id <> $4
          AND allocation.status = 'planned'
        ORDER BY allocation.id
        FOR UPDATE OF allocation`,
      [proposal.run_id, proposal.blanket_source_po_id, Number(line.item_id), targetLineId]
    );
    const otherPlannedBySourceLine = new Map();
    for (const allocation of otherPlannedRows.rows) {
      const sourceLineId = Number(allocation.source_line_id);
      otherPlannedBySourceLine.set(sourceLineId, round(
        positive(otherPlannedBySourceLine.get(sourceLineId)) + positive(allocation.planned_pallets)
      ));
    }
    const pool = await blanketPoolLineRows({
      isBlanket: true,
      sourcePoId: proposal.blanket_source_po_id,
      limit: 20000
    });
    const candidates = pool
      .filter((row) => Number(row.item_id) === Number(line.item_id)
        && Math.abs(positive(row.to_plt) - toPlt) <= EPSILON)
      .map((row) => ({
        ...row,
        availableForLine: Math.max(0, Math.floor(
          positive(row.remaining_pallets) - positive(otherPlannedBySourceLine.get(Number(row.source_line_id))) + EPSILON
        ))
      }))
      .filter((row) => row.availableForLine > 0);
    const availablePallets = candidates.reduce((sum, row) => sum + row.availableForLine, 0);
    if (pallets > availablePallets) {
      throw httpError(`Only ${availablePallets} whole PLT remain available for this item after other proposed Blanket loads.`, 409, "SCM_BLANKET_POOL_CHANGED");
    }

    const inventory = await getSmartScmProposalInventorySnapshot(line.item_id, destinationLocationId, toPlt);
    const reason = {
      ...(line.reason || {}),
      ...inventory,
      destinationAvailablePallets: inventory.availablePallets,
      destinationExpectedAvailablePallets: inventory.expectedAvailablePallets,
      manuallyAdjusted: true,
      blanketManuallyAdjusted: true,
      blanketSourcePoId: Number(proposal.blanket_source_po_id),
      blanketSourcePoRef: proposal.blanket_source_po_ref,
      ...(destinationChanged ? {
        destinationManuallyAdjusted: true,
        previousDestinationLocationId: beforeDestinationLocationId,
        previousDestinationName: line.destination_name
      } : {})
    };
    delete reason.manualCapacityOverride;
    if (destinationChanged) {
      for (const key of [
        "quantityOnHand", "inventorySyncedAt", "positionPallets", "baseReorderPointPallets", "basePreferredPallets",
        "safetyStockPallets", "reorderPointPallets", "preferredPallets", "minimumOrderPallets",
        "weeklyDemandPallets", "weeklyDemandSdPallets", "leadTimeWeeks", "capacityPallets",
        "safetyFactor", "weeksOfCover", "forecastModel", "zeroDemandCoverageApplied",
        "representativeOrderPallets", "coverageOrderCount", "coverageFloorPallets", "coverageSource",
        "coverageLocalSamples", "coverageDonorSamples", "coverageCapacityShortfall",
        "coverageCausedNeed", "coverageReviewRequired", "availableCoverageOrders",
        "availableCoverageGapPallets", "coverageCoveredByInbound",
        "gormleyHubRedirected", "gormleyOriginalDestinations", "routeRulePartialRedirected",
        "routeRuleOriginalDestinations", "routeRuleSource", "actualDestinationYard", "destinationAllocations"
      ]) delete reason[key];
    }

    const deletedAllocations = await query(
      `DELETE FROM scm_smart_blanket_allocations
        WHERE proposal_id = $1 AND proposal_line_id = $2 AND status = 'planned'
        RETURNING id`,
      [id, targetLineId]
    );
    if (deletedAllocations.rowCount !== allocations.rowCount) {
      throw httpError("Blanket source allocations changed while the line was being edited. Try again.", 409, "SCM_BLANKET_ALLOCATION_CHANGED");
    }
    let remaining = pallets;
    for (const candidate of candidates) {
      if (remaining <= 0) break;
      const allocatedPallets = Math.min(remaining, candidate.availableForLine);
      const allocatedSalesQty = round(allocatedPallets * toPlt);
      await query(
        `INSERT INTO scm_smart_blanket_allocations (
           proposal_id, proposal_line_id, source_po_id, source_po_ref,
           source_line_id, item_id, destination_location_id, destination_name,
           planned_pallets, planned_sales_qty
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, targetLineId, proposal.blanket_source_po_id, proposal.blanket_source_po_ref,
          candidate.source_line_id, Number(line.item_id), destinationLocationId, destinationName,
          allocatedPallets, allocatedSalesQty]
      );
      remaining -= allocatedPallets;
    }
    if (remaining !== 0) throw new Error("Blanket source allocation did not conserve the edited pallet quantity.");
    await query(
      `UPDATE scm_smart_proposal_lines
          SET proposed_pallets = $3,
              residual_pallets = $3,
              confirmed_pallets = 0,
              sales_quantity = $3::numeric * $4::numeric,
              pallet_weight_lbs = $5,
              line_weight_lbs = $3::numeric * $5::numeric,
              unit = $6,
              to_plt = $4,
              to_lyr = $7,
              to_sec = $8,
              to_pcs = $9,
              destination_location_id = $10,
              destination_name = $11,
              reason = $12::jsonb,
              updated_at = now()
        WHERE id = $1 AND proposal_id = $2`,
      [targetLineId, id, pallets, toPlt, palletWeight, policy.stock_unit || line.unit,
        positive(policy.to_lyr), positive(policy.to_sec), positive(policy.to_pcs),
        destinationLocationId, destinationName, JSON.stringify(reason)]
    );
    const conserved = await query(
      `SELECT COALESCE(SUM(planned_pallets), 0) AS pallets,
              COALESCE(SUM(planned_sales_qty), 0) AS sales_qty
         FROM scm_smart_blanket_allocations
        WHERE proposal_id = $1 AND proposal_line_id = $2 AND status = 'planned'`,
      [id, targetLineId]
    );
    if (Math.abs(positive(conserved.rows[0]?.pallets) - pallets) > EPSILON
      || Math.abs(positive(conserved.rows[0]?.sales_qty) - (pallets * toPlt)) > EPSILON) {
      throw new Error("Blanket source allocation totals do not match the edited proposal line.");
    }
    const derived = await refreshSmartScmProposalDerived(id);
    if (!derived) throw new Error("Blanket proposal totals could not be refreshed after the line edit.");
    const manualCapacityOverride = derived.capacity > EPSILON
      && derived.totalWeight > derived.capacity + EPSILON;
    if (manualCapacityOverride) {
      await query(
        `UPDATE scm_smart_proposal_lines
            SET reason = reason || '{"manualCapacityOverride":true}'::jsonb,
                updated_at = now()
          WHERE id = $1 AND proposal_id = $2`,
        [targetLineId, id]
      );
    }
    const revision = await recordSmartScmProposalRevision(proposal.run_id, "Blanket proposal line adjusted", {
      proposalId: id,
      lineId: targetLineId,
      beforePallets: positive(line.proposed_pallets),
      afterPallets: pallets,
      beforeDestinationLocationId,
      destinationLocationId,
      exactSourceAllocation: true,
      manualCapacityOverride,
      totalWeightLbs: derived.totalWeight,
      truckCapacityLbs: derived.capacity
    }, operatorId);
    return {
      runId: Number(proposal.run_id),
      revision,
      beforePallets: positive(line.proposed_pallets),
      beforeDestinationLocationId,
      destinationLocationId,
      manualCapacityOverride,
      totalWeightLbs: derived.totalWeight,
      truckCapacityLbs: derived.capacity
    };
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.blanket.proposal_line.update",
    details: { proposalId: id, lineId: targetLineId, pallets, ...outcome }
  });
  return getSmartScmProposal(id);
}

async function lockedEditableBlanketProposalLine(proposalId, lineId) {
  const proposal = await lockedBlanketProposal(proposalId);
  if (proposal.status !== "held" || proposal.run_status !== "ready") {
    throw httpError("Only a held proposal in the current ready Blanket plan can be edited.", 409);
  }
  const existingRelease = await query(
    "SELECT id FROM scm_smart_blanket_releases WHERE proposal_id = $1 FOR UPDATE",
    [Number(proposal.id)]
  );
  if (existingRelease.rowCount) {
    throw httpError("This Blanket load is already reserved. Edit it from Vendor Replies.", 409);
  }
  const source = await query(
    `SELECT netsuite_id, tranid, netsuite_active, is_blanket_po
       FROM purchase_orders
      WHERE netsuite_id = $1
      FOR UPDATE`,
    [proposal.blanket_source_po_id]
  );
  if (!source.rows[0]?.netsuite_active || source.rows[0]?.is_blanket_po !== true) {
    throw httpError("The source PO is no longer an active Blanket order. Calculate releases again.", 409, "SCM_BLANKET_SOURCE_CHANGED");
  }
  const lineResult = await query(
    "SELECT * FROM scm_smart_proposal_lines WHERE id = $1 AND proposal_id = $2 FOR UPDATE",
    [Number(lineId), Number(proposal.id)]
  );
  if (!lineResult.rowCount) throw httpError("Blanket proposal line was not found.", 404);
  const allocations = await query(
    `SELECT *
       FROM scm_smart_blanket_allocations
      WHERE proposal_id = $1 AND proposal_line_id = $2
      ORDER BY source_line_id, id
      FOR UPDATE`,
    [Number(proposal.id), Number(lineId)]
  );
  const line = lineResult.rows[0];
  if (!allocations.rowCount || allocations.rows.some((row) => row.status !== "planned" || row.release_id !== null)) {
    throw httpError("This Blanket line no longer has editable planned source allocations.", 409, "SCM_BLANKET_ALLOCATION_CHANGED");
  }
  if (allocations.rows.some((row) => Number(row.source_po_id) !== Number(proposal.blanket_source_po_id)
    || Number(row.item_id) !== Number(line.item_id))) {
    throw httpError("Blanket source lineage does not match this proposal line. Calculate releases again.", 409, "SCM_BLANKET_ALLOCATION_CHANGED");
  }
  return { proposal, line, allocations: allocations.rows };
}

export async function splitSmartScmBlanketProposalLine(proposalId, lineId, _values = {}, operatorId = null) {
  const id = integer(proposalId);
  const targetLineId = integer(lineId);
  if (!id || !targetLineId) throw httpError("Select a valid Blanket proposal line to split.");
  const outcome = await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext('smart-scm-blanket-plan-build'))");
    const { proposal, line, allocations } = await lockedEditableBlanketProposalLine(id, targetLineId);
    const movedPallets = positive(line.proposed_pallets);
    if (!Number.isInteger(movedPallets) || movedPallets <= 0) {
      throw httpError("Save this Blanket line as a positive whole-pallet quantity before splitting it.", 409);
    }
    const allOverrides = proposal.pallet_quantity_overrides && typeof proposal.pallet_quantity_overrides === "object"
      ? { ...proposal.pallet_quantity_overrides }
      : {};
    const destinationKey = String(Number(line.destination_location_id));
    // A manual PALLET override belongs to the original load, not to one item
    // line. Once that line moves, its correct share is unknowable, so both
    // affected loads return to the deterministic automatic calculation.
    const childOverrides = {};
    const sourceOverrides = { ...allOverrides };
    delete sourceOverrides[destinationKey];
    const insertedProposal = await query(
      `INSERT INTO scm_smart_proposals (
         run_id, proposal_key, proposal_type, phase, source_kind,
         source_location_id, source_vendor_yard_id, source_name,
         destination_location_id, destination_name, vendor, plant, status,
         urgent, urgency_level, urgency_score, provisional,
         total_pallets, total_weight_lbs, utilization, memo, route_stops,
         pallet_quantity_overrides, manually_grouped, proposal_origin,
         blanket_source_po_id, blanket_source_po_ref
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'held',$13,$14,$15,$16,
         $17,$18,0,$19,$20::jsonb,$21::jsonb,false,'blanket',$22,$23
       ) RETURNING id`,
      [proposal.run_id, `blanket-split:${crypto.randomUUID()}`, proposal.proposal_type, proposal.phase,
        proposal.source_kind, proposal.source_location_id, proposal.source_vendor_yard_id, proposal.source_name,
        Number(line.destination_location_id), line.destination_name, proposal.vendor, proposal.plant,
        Boolean(line.urgent), line.urgency_level || "normal", positive(line.urgency_score), Boolean(line.provisional),
        movedPallets, positive(line.line_weight_lbs), `split from Blanket load #${id} · ${line.item_name}`,
        JSON.stringify([{ locationId: Number(line.destination_location_id), name: line.destination_name, sequence: 1 }]),
        JSON.stringify(childOverrides), proposal.blanket_source_po_id, proposal.blanket_source_po_ref]
    );
    const createdProposalId = Number(insertedProposal.rows[0].id);
    const insertedLine = await query(
      `INSERT INTO scm_smart_proposal_lines (
         proposal_id, item_id, item_name, item_description, unit,
         required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
         sales_quantity, pallet_weight_lbs, line_weight_lbs,
         to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason,
         is_alternative, alternative_for_line_id, added_source, added_by,
         destination_location_id, destination_name, urgent, provisional,
         vendor_decision, last_purchase_price, last_purchase_price_synced_at,
         purchase_unit, urgency_level, urgency_score
       ) SELECT
         $1, item_id, item_name, item_description, unit,
         required_pallets, proposed_pallets, 0, proposed_pallets,
         sales_quantity, pallet_weight_lbs, line_weight_lbs,
         to_plt, to_lyr, to_sec, to_pcs, manual_planning_required,
         COALESCE(reason, '{}'::jsonb) || jsonb_build_object(
           'manuallySplit', true,
           'splitWholeLine', true,
           'splitFromProposalId', $2::bigint,
           'splitFromLineId', $3::bigint
         ),
         is_alternative, alternative_for_line_id, added_source, COALESCE($4, added_by),
         destination_location_id, destination_name, urgent, provisional,
         vendor_decision, last_purchase_price, last_purchase_price_synced_at,
         purchase_unit, urgency_level, urgency_score
        FROM scm_smart_proposal_lines
       WHERE id = $3 AND proposal_id = $2
       RETURNING id`,
      [createdProposalId, id, targetLineId, operatorText(operatorId)]
    );
    if (!insertedLine.rowCount) throw httpError("Blanket proposal line was not found.", 404);
    const createdLineId = Number(insertedLine.rows[0].id);
    const movedAllocations = await query(
      `UPDATE scm_smart_blanket_allocations
          SET proposal_id = $3, proposal_line_id = $4, updated_at = now()
        WHERE proposal_id = $1 AND proposal_line_id = $2
          AND status = 'planned' AND release_id IS NULL
       RETURNING id`,
      [id, targetLineId, createdProposalId, createdLineId]
    );
    if (movedAllocations.rowCount !== allocations.length) {
      throw httpError("Blanket source allocations changed while the line was being split. Try again.", 409, "SCM_BLANKET_ALLOCATION_CHANGED");
    }
    const deletedLine = await query(
      "DELETE FROM scm_smart_proposal_lines WHERE id = $1 AND proposal_id = $2 RETURNING id",
      [targetLineId, id]
    );
    if (!deletedLine.rowCount) throw new Error("The original Blanket line could not be removed after its allocation was moved.");
    const remaining = await query(
      "SELECT COUNT(*)::int AS count FROM scm_smart_proposal_lines WHERE proposal_id = $1",
      [id]
    );
    const sourceProposalRemoved = Number(remaining.rows[0]?.count || 0) === 0;
    if (sourceProposalRemoved) {
      await query("DELETE FROM scm_smart_proposals WHERE id = $1", [id]);
    } else {
      await query(
        "UPDATE scm_smart_proposals SET pallet_quantity_overrides = $2::jsonb, updated_at = now() WHERE id = $1",
        [id, JSON.stringify(sourceOverrides)]
      );
      await refreshSmartScmProposalDerived(id);
    }
    await refreshSmartScmProposalDerived(createdProposalId);
    const revision = await recordSmartScmProposalRevision(proposal.run_id, "Blanket proposal item line moved into a separate load", {
      proposalId: id,
      lineId: targetLineId,
      createdProposalId,
      createdLineId,
      movedPallets,
      movedAllocationIds: movedAllocations.rows.map((row) => Number(row.id)),
      sourceProposalRemoved,
      movedDestinationPalletOverrideReset: Object.prototype.hasOwnProperty.call(allOverrides, destinationKey),
      exactSourceAllocation: true
    }, operatorId);
    return { runId: Number(proposal.run_id), createdProposalId, createdLineId, revision, sourceProposalRemoved };
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.blanket.proposal_line.split",
    details: { proposalId: id, lineId: targetLineId, ...outcome }
  });
  return getSmartScmPlanningRun(outcome.runId);
}

export async function removeSmartScmBlanketProposalLine(proposalId, lineId, operatorId = null) {
  const id = integer(proposalId);
  const targetLineId = integer(lineId);
  if (!id || !targetLineId) throw httpError("Select a valid Blanket proposal line to remove.");
  const outcome = await withTransaction(async () => {
    await query("SELECT pg_advisory_xact_lock(hashtext('smart-scm-blanket-plan-build'))");
    const { proposal, line, allocations } = await lockedEditableBlanketProposalLine(id, targetLineId);
    const deletedAllocations = await query(
      `DELETE FROM scm_smart_blanket_allocations
        WHERE proposal_id = $1 AND proposal_line_id = $2
          AND status = 'planned' AND release_id IS NULL
       RETURNING id, source_line_id, planned_pallets, planned_sales_qty`,
      [id, targetLineId]
    );
    if (deletedAllocations.rowCount !== allocations.length) {
      throw httpError("Blanket source allocations changed while the line was being removed. Try again.", 409, "SCM_BLANKET_ALLOCATION_CHANGED");
    }
    const removed = await query(
      "DELETE FROM scm_smart_proposal_lines WHERE id = $1 AND proposal_id = $2 RETURNING id",
      [targetLineId, id]
    );
    if (!removed.rowCount) throw httpError("Blanket proposal line was not found.", 404);
    const remaining = await query(
      "SELECT COUNT(*)::int AS count FROM scm_smart_proposal_lines WHERE proposal_id = $1",
      [id]
    );
    const deletedProposal = Number(remaining.rows[0]?.count || 0) === 0;
    if (deletedProposal) await query("DELETE FROM scm_smart_proposals WHERE id = $1", [id]);
    else await refreshSmartScmProposalDerived(id);
    const revision = await recordSmartScmProposalRevision(proposal.run_id, "Blanket proposal line removed", {
      proposalId: id,
      lineId: targetLineId,
      itemId: Number(line.item_id),
      releasedPlannedPallets: deletedAllocations.rows.reduce((sum, row) => sum + positive(row.planned_pallets), 0),
      releasedPlannedSalesQty: deletedAllocations.rows.reduce((sum, row) => sum + positive(row.planned_sales_qty), 0),
      deletedProposal,
      exactSourceAllocation: true
    }, operatorId);
    return { runId: Number(proposal.run_id), revision, deletedProposal };
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.blanket.proposal_line.remove",
    details: { proposalId: id, lineId: targetLineId, ...outcome }
  });
  if (outcome.deletedProposal) return { deleted: true, runId: outcome.runId };
  return getSmartScmProposal(id);
}

async function lockedReleaseById(releaseId) {
  const id = integer(releaseId);
  if (!id) throw httpError("Select a valid Blanket release.");
  const rows = await query(
    `SELECT *
       FROM scm_smart_blanket_releases
      WHERE id = $1
      FOR UPDATE`,
    [id]
  );
  if (!rows.rowCount) throw httpError("Blanket release was not found.", 404);
  return rows.rows[0];
}

async function lockedReleaseByProposalId(proposalId) {
  const id = integer(proposalId);
  if (!id) throw httpError("Select a valid Blanket proposal.");
  const rows = await query(
    `SELECT *
       FROM scm_smart_blanket_releases
      WHERE proposal_id = $1
      FOR UPDATE`,
    [id]
  );
  if (!rows.rowCount) throw httpError("Blanket release was not found for this proposal.", 404);
  return rows.rows[0];
}

async function lockedBlanketWorkflowByProposalId(proposalId) {
  const proposal = await lockedBlanketProposal(proposalId);
  const release = await lockedReleaseByProposalId(proposal.id);
  return { proposal, release };
}

async function lockedBlanketWorkflowByReleaseId(releaseId) {
  const id = integer(releaseId);
  if (!id) throw httpError("Select a valid Blanket release.");
  const relation = await query(
    "SELECT proposal_id FROM scm_smart_blanket_releases WHERE id = $1",
    [id]
  );
  if (!relation.rowCount) throw httpError("Blanket release was not found.", 404);
  const proposal = await lockedBlanketProposal(relation.rows[0].proposal_id);
  const release = await lockedReleaseById(id);
  return { proposal, release };
}

async function insertReleaseEvent(releaseId, eventType, actor, details = {}) {
  await query(
    `INSERT INTO scm_smart_blanket_release_events (release_id, event_type, actor, details)
     VALUES ($1,$2,$3,$4::jsonb)`,
    [releaseId, eventType, operatorText(actor), JSON.stringify(details || {})]
  );
}

async function refreshBlanketProposalLineDecisions(proposalId) {
  await query(
    `WITH totals AS (
       SELECT allocation.proposal_line_id,
              SUM(allocation.released_pallets) AS released_pallets,
              SUM(allocation.released_sales_qty) AS released_sales_qty,
              SUM(allocation.held_pallets) AS held_pallets,
              SUM(allocation.cancelled_pallets) AS cancelled_pallets
         FROM scm_smart_blanket_allocations allocation
        WHERE allocation.proposal_id = $1
        GROUP BY allocation.proposal_line_id
     )
     UPDATE scm_smart_proposal_lines line
        SET confirmed_pallets = totals.released_pallets,
            residual_pallets = totals.held_pallets,
            sales_quantity = totals.released_sales_qty,
            line_weight_lbs = totals.released_pallets * COALESCE(line.pallet_weight_lbs, 0),
            vendor_decision = CASE
              WHEN totals.held_pallets > 0 THEN 'hold'
              WHEN totals.released_pallets > 0 THEN 'confirm'
              WHEN totals.cancelled_pallets > 0 THEN 'cancel'
              ELSE line.vendor_decision
            END,
            reason = CASE
              WHEN totals.held_pallets > 0 THEN jsonb_set(
                COALESCE(line.reason, '{}'::jsonb),
                '{vendorReplyDraft}',
                jsonb_build_object(
                  'decision', 'hold',
                  'decisionPallets', totals.held_pallets,
                  'confirmedPallets', 0,
                  'heldPallets', totals.held_pallets,
                  'cancelledPallets', 0,
                  'reservedPallets', totals.held_pallets,
                  'responseStatus', 'hold'
                ),
                true
              )
              ELSE COALESCE(line.reason, '{}'::jsonb) - 'vendorReplyDraft'
            END,
            updated_at = now()
       FROM totals
      WHERE line.id = totals.proposal_line_id`,
    [Number(proposalId)]
  );
}

function operatorText(value) {
  return value === null || value === undefined ? "" : String(value);
}

export async function confirmSmartScmBlanketProposal(proposalId, operatorId = null, { idempotencyKey = "" } = {}) {
  const id = integer(proposalId);
  if (!id) throw httpError("Select a valid Blanket proposal.");
  const releaseId = await withTransaction(async () => {
    const proposal = await lockedBlanketProposal(id);
    const existing = await query(
      `SELECT id FROM scm_smart_blanket_releases WHERE proposal_id = $1 FOR UPDATE`,
      [id]
    );
    if (existing.rowCount) return Number(existing.rows[0].id);
    if (proposal.status !== "held") throw httpError("Only a held Blanket proposal can be confirmed.", 409);
    const source = await query(
      `SELECT netsuite_id, tranid, is_blanket_po, netsuite_active
         FROM purchase_orders
        WHERE netsuite_id = $1
        FOR UPDATE`,
      [proposal.blanket_source_po_id]
    );
    if (!source.rows[0]?.netsuite_active || source.rows[0]?.is_blanket_po !== true) {
      throw httpError("The source PO is no longer an active Blanket order. Build a new plan.", 409, "SCM_BLANKET_SOURCE_CHANGED");
    }
    const allocations = await query(
      `SELECT *
         FROM scm_smart_blanket_allocations
        WHERE proposal_id = $1
        ORDER BY source_line_id, id
        FOR UPDATE`,
      [id]
    );
    if (!allocations.rowCount || allocations.rows.some((row) => row.status !== "planned")) {
      throw httpError("Blanket proposal source allocations changed. Build a new plan.", 409, "SCM_BLANKET_ALLOCATION_CHANGED");
    }
    await query(
      `SELECT id
         FROM purchase_order_lines
        WHERE id = ANY($1::bigint[])
        ORDER BY id
        FOR UPDATE`,
      [[...new Set(allocations.rows.map((row) => Number(row.source_line_id)))]]
    );
    const pool = await blanketPoolLineRows({
      isBlanket: true,
      sourcePoId: proposal.blanket_source_po_id,
      limit: 20000
    });
    const remainingByLine = new Map(pool.map((row) => [Number(row.source_line_id), positive(row.remaining_pallets)]));
    for (const allocation of allocations.rows) {
      const available = positive(remainingByLine.get(Number(allocation.source_line_id)));
      const requested = positive(allocation.planned_pallets);
      if (requested > available + EPSILON) {
        throw httpError("Blanket PO remaining quantity changed. Build a new plan.", 409, "SCM_BLANKET_POOL_CHANGED");
      }
      remainingByLine.set(Number(allocation.source_line_id), round(available - requested));
    }
    const key = text(idempotencyKey) || `blanket-proposal:${id}`;
    const settings = await query("SELECT vendor_response_sla_hours FROM scm_smart_settings WHERE id = 1");
    const inserted = await query(
      `INSERT INTO scm_smart_blanket_releases (
         proposal_id, run_id, source_po_id, source_po_ref, idempotency_key, reserved_by
       ) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [id, proposal.run_id, proposal.blanket_source_po_id, proposal.blanket_source_po_ref, key, operatorText(operatorId)]
    );
    const nextReleaseId = Number(inserted.rows[0].id);
    await query(
      `UPDATE scm_smart_blanket_allocations
          SET release_id = $2,
              reserved_pallets = planned_pallets,
              reserved_sales_qty = planned_sales_qty,
              status = 'reserved',
              updated_at = now()
        WHERE proposal_id = $1`,
      [id, nextReleaseId]
    );
    await query(
      `UPDATE scm_smart_proposals
          SET status = 'order_requested', order_requested_at = now(), order_requested_by = $2,
              vendor_reply_due_at = now() + ($3 * interval '1 hour'), updated_at = now()
        WHERE id = $1`,
      [id, operatorText(operatorId), Math.max(1, Number(settings.rows[0]?.vendor_response_sla_hours) || 24)]
    );
    await insertReleaseEvent(nextReleaseId, "reserved", operatorId, {
      proposalId: id,
      sourcePoId: Number(proposal.blanket_source_po_id),
      sourcePoRef: proposal.blanket_source_po_ref,
      allocations: allocations.rows.map((row) => ({
        allocationId: Number(row.id),
        sourceLineId: Number(row.source_line_id),
        pallets: positive(row.planned_pallets),
        salesQty: positive(row.planned_sales_qty)
      }))
    });
    return nextReleaseId;
  });
  const [release] = await releaseRows({ releaseId, limit: 1 });
  const proposal = await getSmartScmProposal(id);
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.blanket.reserved",
    details: { releaseId, proposalId: id }
  });
  return { release: publicRelease(release), proposal };
}

function normalizeBlanketVendorReplyDraft(totalPallets, input = {}) {
  const total = positive(totalPallets);
  const rawDecision = text(input.decision || input.responseStatus || input.status || "").toLowerCase();
  const decision = ["hold", "awaiting", "production_eta", "credit_hold"].includes(rawDecision)
    ? "hold"
    : ["cancel", "cancelled", "out_of_stock"].includes(rawDecision)
      ? "cancel"
      : "confirm";
  const explicitParts = ["confirmedPallets", "heldPallets", "cancelledPallets"]
    .some((field) => input[field] !== undefined && input[field] !== null && String(input[field]).trim() !== "");
  let confirmedPallets = 0;
  let heldPallets = 0;
  let cancelledPallets = 0;
  let decisionPallets = 0;
  if (explicitParts) {
    confirmedPallets = positive(input.confirmedPallets);
    heldPallets = positive(input.heldPallets);
    cancelledPallets = positive(input.cancelledPallets);
    decisionPallets = decision === "hold" ? heldPallets : decision === "cancel" ? cancelledPallets : confirmedPallets;
    if (confirmedPallets + heldPallets + cancelledPallets > total + EPSILON) {
      throw httpError("A Blanket vendor decision cannot exceed its reserved line quantity.");
    }
  } else if (decision === "cancel") {
    cancelledPallets = total;
  } else {
    const rawQuantity = input.decisionPallets ?? input.confirmedPallets ?? input.quantity;
    decisionPallets = rawQuantity === undefined || rawQuantity === null || String(rawQuantity).trim() === ""
      ? total
      : positive(rawQuantity);
    if (decisionPallets <= EPSILON) {
      throw httpError(`A ${decision === "hold" ? "held" : "confirmed"} Blanket line must have pallets greater than zero.`);
    }
    if (decisionPallets > total + EPSILON) {
      throw httpError("A Blanket vendor decision cannot exceed its reserved line quantity.");
    }
    if (decision === "hold") heldPallets = decisionPallets;
    else confirmedPallets = decisionPallets;
  }
  return {
    decision,
    decisionPallets: round(decisionPallets),
    confirmedPallets: round(confirmedPallets),
    heldPallets: round(heldPallets),
    cancelledPallets: round(cancelledPallets),
    reservedPallets: round(total),
    responseStatus: rawDecision || decision
  };
}

function blanketDraftResponseStatus(drafts = []) {
  if (!drafts.length) return "awaiting";
  if (drafts.some((draft) => draft.responseStatus === "credit_hold")) return "credit_hold";
  if (drafts.some((draft) => draft.responseStatus === "production_eta")) return "production_eta";
  if (drafts.every((draft) => draft.decision === "cancel")) return "cancelled";
  if (drafts.every((draft) => draft.decision === "confirm"
    && draft.confirmedPallets + EPSILON >= draft.reservedPallets)) return "confirmed";
  if (drafts.some((draft) => draft.decision === "confirm" || draft.decision === "cancel")) return "partial";
  return "awaiting";
}

async function updateBlanketVendorReplyDestinations(proposal, release, inputs = [], operatorId = null) {
  const proposalId = Number(proposal.id);
  const lineResult = await query(
    `SELECT *
       FROM scm_smart_proposal_lines
      WHERE proposal_id = $1
      ORDER BY id
      FOR UPDATE`,
    [proposalId]
  );
  const allocationResult = await query(
    `SELECT *
       FROM scm_smart_blanket_allocations
      WHERE proposal_id = $1
      ORDER BY proposal_line_id, source_line_id, id
      FOR UPDATE`,
    [proposalId]
  );
  const lineById = new Map(lineResult.rows.map((line) => [Number(line.id), line]));
  const inputById = new Map(inputs.map((input) => [integer(input.proposalLineId || input.lineId), input]));
  const pendingByLine = new Map();
  for (const allocation of allocationResult.rows.filter((row) => BLANKET_PENDING_ALLOCATION_STATUSES.includes(row.status))) {
    const lineId = Number(allocation.proposal_line_id);
    if (!pendingByLine.has(lineId)) pendingByLine.set(lineId, []);
    pendingByLine.get(lineId).push(allocation);
  }
  const changes = [];
  const nextLines = lineResult.rows.map((line) => {
    const input = inputById.get(Number(line.id));
    const destinationLocationId = input && Object.hasOwn(input, "destinationLocationId")
      ? integer(input.destinationLocationId)
      : Number(line.destination_location_id);
    if (destinationLocationId === Number(line.destination_location_id)) return { line, destinationLocationId };
    const destinationName = BLANKET_DESTINATIONS.get(destinationLocationId);
    if (!destinationLocationId || !destinationName) throw httpError("Select a valid destination yard for every changed Blanket line.");
    if (!pendingByLine.has(Number(line.id))) {
      throw httpError("Only a pending reserved or held Blanket line can change destination.", 409);
    }
    const change = {
      line,
      allocations: pendingByLine.get(Number(line.id)),
      lineId: Number(line.id),
      itemId: Number(line.item_id),
      itemName: line.item_name,
      beforeDestinationLocationId: Number(line.destination_location_id),
      beforeDestinationName: line.destination_name,
      destinationLocationId,
      destinationName
    };
    changes.push(change);
    return { line, destinationLocationId };
  });
  if (!changes.length) return [];

  const itemDestinations = new Set();
  for (const entry of nextLines) {
    const key = `${Number(entry.line.item_id)}:${entry.destinationLocationId}`;
    if (itemDestinations.has(key)) {
      const destinationName = BLANKET_DESTINATIONS.get(entry.destinationLocationId)
        || entry.line.destination_name || entry.destinationLocationId;
      throw httpError(`${entry.line.item_name} already has a ${destinationName} line in this Blanket load. Keep only one item line per destination.`, 409);
    }
    itemDestinations.add(key);
  }

  for (const change of changes) {
    const policy = await getSmartScmProposalItemPolicy(change.itemId, change.destinationLocationId, { allowExcluded: true });
    if (!policy) throw httpError(`${change.itemName} is not enabled for Smart SCM planning at ${change.destinationName}.`, 409);
    const policyToPlt = positive(policy.to_plt);
    const palletWeight = positive(policy.pallet_weight_lbs);
    if (policyToPlt <= EPSILON || palletWeight <= EPSILON) {
      throw httpError(`${change.itemName} needs a pallet conversion and pallet weight at ${change.destinationName}.`, 409);
    }
    const conversionMismatch = Math.abs(positive(change.line.to_plt) - policyToPlt) > EPSILON
      || change.allocations.some((allocation) => {
        const pendingPallets = allocation.status === "held"
          ? positive(allocation.held_pallets)
          : positive(allocation.reserved_pallets);
        const pendingSalesQty = allocation.status === "held"
          ? positive(allocation.held_sales_qty)
          : positive(allocation.reserved_sales_qty);
        return pendingPallets > EPSILON
          && Math.abs(pendingSalesQty - (pendingPallets * policyToPlt)) > EPSILON;
      });
    if (conversionMismatch) {
      throw httpError(`${change.itemName} uses a different PLT conversion at ${change.destinationName}. Its reserved sales quantity cannot be changed after the Blanket release was reserved.`, 409, "SCM_BLANKET_DESTINATION_CONVERSION_CHANGED");
    }
    change.toPlt = policyToPlt;
  }

  const activeDestinations = new Set(allocationResult.rows
    .filter((allocation) => positive(allocation.released_pallets) > EPSILON)
    .map((allocation) => Number(allocation.destination_location_id)));
  for (const [lineId, allocations] of pendingByLine) {
    if (!allocations.some((allocation) => {
      const pending = allocation.status === "held" ? allocation.held_pallets : allocation.reserved_pallets;
      return positive(pending) > EPSILON;
    })) continue;
    const input = inputById.get(lineId);
    const line = lineById.get(lineId);
    activeDestinations.add(input && Object.hasOwn(input, "destinationLocationId")
      ? integer(input.destinationLocationId)
      : Number(line.destination_location_id));
  }
  const routeRule = await getSmartScmRouteRule(proposal.source_name);
  const maximumDrops = routeRule.enabled === false
    ? 2
    : Math.max(1, Math.min(2, Number(routeRule.maxDrops) || 2));
  if (activeDestinations.size > maximumDrops) {
    throw httpError(`${proposal.source_name || "This Blanket source"} allows at most ${maximumDrops} destination${maximumDrops === 1 ? "" : "s"} per load.`, 409);
  }

  for (const change of changes) {
    const reason = {
      ...(change.line.reason || {}),
      blanketVendorReplyDestination: {
        changedBy: operatorText(operatorId),
        changedAt: new Date().toISOString(),
        previousLocationId: change.beforeDestinationLocationId,
        previousLocationName: change.beforeDestinationName,
        locationId: change.destinationLocationId,
        locationName: change.destinationName,
        allocationIds: change.allocations.map((allocation) => Number(allocation.id))
      }
    };
    const allocations = await query(
      `UPDATE scm_smart_blanket_allocations
          SET destination_location_id = $3,
              destination_name = $4,
              updated_at = now()
        WHERE proposal_id = $1
          AND proposal_line_id = $2
          AND status IN ('reserved', 'held')
        RETURNING id`,
      [proposalId, change.lineId, change.destinationLocationId, change.destinationName]
    );
    if (allocations.rowCount !== change.allocations.length) {
      throw httpError("Blanket allocations changed while the destination was being saved. Try again.", 409, "SCM_BLANKET_ALLOCATION_CHANGED");
    }
    await query(
      `UPDATE scm_smart_proposal_lines
          SET destination_location_id = $3,
              destination_name = $4,
              reason = $5::jsonb,
              updated_at = now()
        WHERE id = $1 AND proposal_id = $2`,
      [change.lineId, proposalId, change.destinationLocationId, change.destinationName, JSON.stringify(reason)]
    );
  }
  const derived = await refreshSmartScmProposalDerived(proposalId);
  const revision = await recordSmartScmProposalRevision(proposal.run_id, "Blanket vendor reply destination changed", {
    proposalId,
    releaseId: Number(release.id),
    changes: changes.map((change) => ({
      proposalLineId: change.lineId,
      itemId: change.itemId,
      beforeDestinationLocationId: change.beforeDestinationLocationId,
      destinationLocationId: change.destinationLocationId,
      pendingAllocationIds: change.allocations.map((allocation) => Number(allocation.id)),
      pendingSalesQuantityPreserved: true
    })),
    routeStops: derived.routeStops
  }, operatorId);
  await insertReleaseEvent(release.id, "vendor_destination_updated", operatorId, {
    revision,
    changes: changes.map((change) => ({
      proposalLineId: change.lineId,
      beforeDestinationLocationId: change.beforeDestinationLocationId,
      destinationLocationId: change.destinationLocationId
    }))
  });
  return changes;
}

export async function saveSmartScmBlanketVendorReplyDraft(proposalId, values = {}, operatorId = null) {
  const id = integer(proposalId);
  if (!id) throw httpError("Select a valid Blanket proposal.");
  const saved = await withTransaction(async () => {
    const { proposal, release } = await lockedBlanketWorkflowByProposalId(id);
    if (!BLANKET_PENDING_RELEASE_STATUSES.includes(release.status)) {
      throw httpError("This Blanket vendor workflow is already final.", 409);
    }
    const rows = await query(
      `SELECT line.id, line.reason, allocation.id AS allocation_id,
              allocation.status AS allocation_status,
              CASE WHEN allocation.status = 'reserved'
                THEN allocation.reserved_pallets
                WHEN allocation.status = 'held'
                THEN allocation.held_pallets
                ELSE 0
              END AS pending_pallets
         FROM scm_smart_proposal_lines line
         JOIN scm_smart_blanket_allocations allocation
           ON allocation.proposal_line_id = line.id
          AND allocation.proposal_id = line.proposal_id
        WHERE line.proposal_id = $1
          AND allocation.status IN ('reserved', 'held')
        ORDER BY line.id, allocation.id
        FOR UPDATE OF line, allocation`,
      [id]
    );
    const pendingByLine = new Map();
    const reasonByLine = new Map();
    for (const row of rows.rows) {
      const lineId = Number(row.id);
      pendingByLine.set(lineId, round(positive(pendingByLine.get(lineId)) + positive(row.pending_pallets)));
      reasonByLine.set(lineId, row.reason || {});
    }
    const inputs = Array.isArray(values.lines) ? values.lines : [];
    const inputIds = inputs.map((input) => integer(input.proposalLineId || input.lineId));
    if (inputIds.some((lineId) => !lineId || !pendingByLine.has(lineId))) {
      throw httpError("One or more Blanket vendor decisions do not belong to this reserved load.");
    }
    if (new Set(inputIds).size !== inputIds.length) {
      throw httpError("Each Blanket proposal line can appear only once in a vendor draft.");
    }
    const destinationChanges = await updateBlanketVendorReplyDestinations(proposal, release, inputs, operatorId);
    const suppliedDrafts = new Map();
    for (let index = 0; index < inputs.length; index += 1) {
      const lineId = inputIds[index];
      const draft = normalizeBlanketVendorReplyDraft(pendingByLine.get(lineId), inputs[index]);
      suppliedDrafts.set(lineId, draft);
      await query(
        `UPDATE scm_smart_proposal_lines
            SET vendor_decision = $3,
                reason = jsonb_set(COALESCE(reason, '{}'::jsonb), '{vendorReplyDraft}', $4::jsonb, true),
                updated_at = now()
          WHERE id = $1 AND proposal_id = $2`,
        [lineId, id, draft.decision, JSON.stringify(draft)]
      );
    }
    const allDrafts = [...pendingByLine.entries()].map(([lineId, pendingPallets]) => {
      if (suppliedDrafts.has(lineId)) return suppliedDrafts.get(lineId);
      const existing = reasonByLine.get(lineId)?.vendorReplyDraft;
      return existing && typeof existing === "object"
        ? { ...existing, reservedPallets: pendingPallets }
        : null;
    }).filter(Boolean);
    const readyDate = validIsoDate(values.readyDate);
    if (allDrafts.some((draft) => draft.responseStatus === "production_eta") && !readyDate) {
      throw httpError("A production ETA reply requires a ready date.");
    }
    const metadata = {
      readyDate,
      vendorReference: text(values.vendorReference),
      packingNumber: text(values.packingNumber),
      creditStatus: text(values.creditStatus),
      remarks: text(values.remarks),
      responseSource: text(values.responseSource) || "load_grid",
      destinationChanges: destinationChanges.map((change) => ({
        proposalLineId: change.lineId,
        itemId: change.itemId,
        beforeDestinationLocationId: change.beforeDestinationLocationId,
        destinationLocationId: change.destinationLocationId
      })),
      decisions: [...suppliedDrafts.entries()].map(([lineId, draft]) => ({ proposalLineId: lineId, ...draft }))
    };
    const responseStatus = blanketDraftResponseStatus(allDrafts);
    await query(
      `UPDATE scm_smart_proposals
          SET status = CASE WHEN $10::boolean THEN 'vendor_replied' ELSE status END,
              vendor_response_status = $2,
              vendor_ready_date = $3,
              vendor_reference = NULLIF($4, ''),
              vendor_packing_number = NULLIF($5, ''),
              vendor_credit_status = NULLIF($6, ''),
              vendor_remarks = NULLIF($7, ''),
              vendor_response_source = $8,
              vendor_replied_at = CASE WHEN $10::boolean THEN now() ELSE vendor_replied_at END,
              vendor_replied_by = CASE WHEN $10::boolean THEN $9 ELSE vendor_replied_by END,
              updated_at = now()
        WHERE id = $1`,
      [id, responseStatus, readyDate, metadata.vendorReference, metadata.packingNumber,
        metadata.creditStatus, metadata.remarks, metadata.responseSource,
        operatorText(operatorId), suppliedDrafts.size > 0]
    );
    await query(
      `UPDATE scm_smart_blanket_releases
          SET ready_date = $2,
              vendor_reference = NULLIF($3, ''),
              packing_number = NULLIF($4, ''),
              credit_status = NULLIF($5, ''),
              remarks = NULLIF($6, ''),
              metadata = metadata || jsonb_build_object('vendorReplyDraft', $7::jsonb),
              updated_at = now()
        WHERE id = $1`,
      [release.id, readyDate, metadata.vendorReference, metadata.packingNumber,
        metadata.creditStatus, metadata.remarks, JSON.stringify(metadata)]
    );
    return { runId: Number(proposal.run_id), releaseId: Number(release.id), responseStatus, metadata };
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.blanket.vendor_reply_draft_saved",
    details: { proposalId: id, ...saved }
  });
  return getSmartScmProposal(id);
}

async function cancelBlanketReservation(releaseOrProposalId, values, operatorId, lockWorkflow) {
  const releaseId = await withTransaction(async () => {
    const { release } = await lockWorkflow(releaseOrProposalId);
    if (release.status === "cancelled") return Number(release.id);
    if (release.status === "released") {
      if (release.metadata?.heldQuantityCancelled === true) return Number(release.id);
      throw httpError("A Blanket release with a created split cannot be cancelled as a reservation.", 409);
    }
    const allocations = await query(
      `SELECT * FROM scm_smart_blanket_allocations WHERE release_id = $1 ORDER BY id FOR UPDATE`,
      [release.id]
    );
    const partialRelease = Boolean(release.split_id);
    await query(
      `UPDATE scm_smart_blanket_allocations
          SET cancelled_pallets = cancelled_pallets + CASE
                WHEN status = 'held' THEN held_pallets ELSE reserved_pallets END,
              cancelled_sales_qty = cancelled_sales_qty + CASE
                WHEN status = 'held' THEN held_sales_qty ELSE reserved_sales_qty END,
              reserved_pallets = 0, reserved_sales_qty = 0,
              held_pallets = 0, held_sales_qty = 0,
              status = CASE WHEN released_pallets > 0 THEN 'released' ELSE 'cancelled' END,
              updated_at = now()
        WHERE release_id = $1 AND status IN ('reserved', 'held')`,
      [release.id]
    );
    await refreshBlanketProposalLineDecisions(release.proposal_id);
    await query(
      `UPDATE scm_smart_blanket_releases
          SET status = CASE WHEN $4::boolean THEN 'released' ELSE 'cancelled' END,
              finalized_at = CASE WHEN $4::boolean THEN now() ELSE finalized_at END,
              finalized_by = CASE WHEN $4::boolean THEN $2 ELSE finalized_by END,
              cancelled_at = CASE WHEN $4::boolean THEN cancelled_at ELSE now() END,
              cancelled_by = CASE WHEN $4::boolean THEN cancelled_by ELSE $2 END,
              metadata = metadata || $3::jsonb, updated_at = now()
        WHERE id = $1`,
      [release.id, operatorText(operatorId), JSON.stringify({ cancellationNote: text(values.note), heldQuantityCancelled: partialRelease }), partialRelease]
    );
    await query(
      `UPDATE scm_smart_proposals
          SET status = CASE WHEN $2::boolean THEN 'completed' ELSE 'cancelled' END,
              updated_at = now()
        WHERE id = $1`,
      [release.proposal_id, partialRelease]
    );
    await insertReleaseEvent(release.id, "reservation_cancelled", operatorId, {
      note: text(values.note),
      allocationIds: allocations.rows.map((row) => Number(row.id))
    });
    return Number(release.id);
  });
  const [release] = await releaseRows({ releaseId, limit: 1 });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.blanket.reservation_cancelled",
    details: { releaseId, note: text(values.note) }
  });
  return { release: publicRelease(release), proposal: await getSmartScmProposal(release.proposal_id) };
}

export async function cancelSmartScmBlanketReservation(releaseId, values = {}, operatorId = null) {
  return cancelBlanketReservation(releaseId, values, operatorId, lockedBlanketWorkflowByReleaseId);
}

export async function cancelSmartScmBlanketReservationForProposal(proposalId, values = {}, operatorId = null) {
  return cancelBlanketReservation(proposalId, values, operatorId, lockedBlanketWorkflowByProposalId);
}

function normalizeDecision(totalPallets, input = {}) {
  const total = positive(totalPallets);
  const hasExplicit = ["confirmedPallets", "heldPallets", "cancelledPallets"]
    .some((field) => input[field] !== undefined && input[field] !== null && String(input[field]).trim() !== "");
  let confirmed = 0;
  let held = 0;
  let cancelled = 0;
  if (hasExplicit) {
    confirmed = positive(input.confirmedPallets);
    held = positive(input.heldPallets);
    cancelled = positive(input.cancelledPallets);
  } else {
    const decision = text(input.decision || input.status || "confirm").toLowerCase();
    const quantity = input.decisionPallets === undefined || input.decisionPallets === null || String(input.decisionPallets).trim() === ""
      ? total
      : positive(input.decisionPallets);
    if (["hold", "awaiting", "production_eta", "credit_hold"].includes(decision)) {
      held = quantity;
      cancelled = round(total - held);
    } else if (["cancel", "cancelled", "out_of_stock"].includes(decision)) {
      cancelled = total;
    } else {
      confirmed = quantity;
      cancelled = round(total - confirmed);
    }
  }
  if (confirmed + held + cancelled > total + EPSILON
    || Math.abs((confirmed + held + cancelled) - total) > EPSILON) {
    throw httpError("Each Blanket line must conserve confirmed, held, and cancelled pallets exactly.");
  }
  return { confirmed: round(confirmed), held: round(held), cancelled: round(cancelled), total };
}

function distributeDecision(allocations, decision) {
  const result = [];
  let confirmed = decision.confirmed;
  let held = decision.held;
  let cancelled = decision.cancelled;
  for (const allocation of allocations) {
    const available = allocation.status === "held"
      ? positive(allocation.held_pallets)
      : positive(allocation.reserved_pallets);
    let left = available;
    const releasedPallets = Math.min(left, confirmed);
    left = round(left - releasedPallets);
    confirmed = round(confirmed - releasedPallets);
    const heldPallets = Math.min(left, held);
    left = round(left - heldPallets);
    held = round(held - heldPallets);
    const cancelledPallets = left;
    cancelled = round(cancelled - cancelledPallets);
    const toPlt = positive(allocation.planned_sales_qty) / positive(allocation.planned_pallets, 1);
    result.push({
      allocation,
      releasedPallets,
      releasedSalesQty: round(releasedPallets * toPlt),
      heldPallets,
      heldSalesQty: round(heldPallets * toPlt),
      cancelledPallets,
      cancelledSalesQty: round(cancelledPallets * toPlt)
    });
  }
  if (confirmed > EPSILON || held > EPSILON || Math.abs(cancelled) > EPSILON) {
    throw httpError("Blanket line decisions do not match their reserved source quantities.", 409);
  }
  return result;
}

async function finalizeBlanketVendorWorkflow(releaseOrProposalId, values, operatorId, lockWorkflow) {
  const finalized = await withTransaction(async () => {
    const { proposal, release } = await lockWorkflow(releaseOrProposalId);
    const finalizeRequestHash = payloadFingerprint(values);
    if (release.metadata?.lastFinalizeRequestHash === finalizeRequestHash) {
      return {
        releaseId: Number(release.id),
        idempotent: true,
        conservation: release.metadata?.lastFinalizeResult?.conservation || []
      };
    }
    if (["released", "cancelled"].includes(release.status)) {
      throw httpError("This Blanket release is already final. Only an exact retry of the saved vendor decision is allowed.", 409);
    }
    const allocationRows = await query(
      `SELECT allocation.*, line.item_name, line.to_plt
         FROM scm_smart_blanket_allocations allocation
         JOIN scm_smart_proposal_lines line ON line.id = allocation.proposal_line_id
        WHERE allocation.release_id = $1
          AND allocation.status IN ('reserved', 'held')
        ORDER BY allocation.proposal_line_id, allocation.source_line_id, allocation.id
        FOR UPDATE OF allocation, line`,
      [release.id]
    );
    if (!allocationRows.rowCount) throw httpError("This Blanket release has no pending reserved quantity.", 409);
    const grouped = new Map();
    for (const allocation of allocationRows.rows) {
      const lineId = Number(allocation.proposal_line_id);
      if (!grouped.has(lineId)) grouped.set(lineId, []);
      grouped.get(lineId).push(allocation);
    }
    const suppliedInputs = Array.isArray(values.lines) ? values.lines : [];
    const suppliedLineIds = suppliedInputs.map((input) => integer(input.proposalLineId || input.lineId));
    if (suppliedInputs.length !== grouped.size
      || suppliedLineIds.some((lineId) => !lineId || !grouped.has(lineId))
      || new Set(suppliedLineIds).size !== suppliedLineIds.length) {
      throw httpError("Submit exactly one valid vendor decision for every pending Blanket proposal line.");
    }
    const inputByLine = new Map(suppliedInputs.map((input, index) => [suppliedLineIds[index], input]));
    const decisions = [];
    const distributed = [];
    for (const [proposalLineId, allocations] of grouped) {
      const total = allocations.reduce((sum, allocation) => sum + (allocation.status === "held"
        ? positive(allocation.held_pallets)
        : positive(allocation.reserved_pallets)), 0);
      const decision = normalizeDecision(total, inputByLine.get(proposalLineId));
      decisions.push({ proposalLineId, ...decision });
      distributed.push(...distributeDecision(allocations, decision));
    }
    const confirmed = distributed.filter((entry) => entry.releasedPallets > EPSILON);
    const held = distributed.filter((entry) => entry.heldPallets > EPSILON);
    const splitRef = text(values.splitPoRef || values.newPoRef);
    if (confirmed.length && !splitRef) throw httpError("A split PO reference is required for confirmed Blanket quantities.");
    let split = null;
    if (confirmed.length) {
      const splitLines = new Map();
      for (const entry of confirmed) {
        const allocation = entry.allocation;
        const key = `${allocation.source_line_id}:${allocation.destination_location_id}`;
        const current = splitLines.get(key) || {
          lineRowId: Number(allocation.source_line_id),
          pallets: 0,
          salesQty: 0,
          destinationLocationId: Number(allocation.destination_location_id)
        };
        current.pallets = round(current.pallets + entry.releasedPallets);
        current.salesQty = round(current.salesQty + entry.releasedSalesQty);
        splitLines.set(key, current);
      }
      split = await createScmPurchaseOrderSplit({
        sourcePoRef: release.source_po_ref,
        newPoRef: splitRef,
        destinationLocationId: confirmed[0].allocation.destination_location_id,
        lines: [...splitLines.values()],
        createdBy: operatorText(operatorId),
        blanketReleaseId: Number(release.id),
        extendSplitId: release.split_id ? Number(release.split_id) : null,
        details: {
          source: "smart-scm-blanket",
          blanketReleaseId: Number(release.id),
          blanketProposalId: Number(release.proposal_id)
        }
      });
    }
    const splitLineBySourceDestination = new Map((split?.lines || []).map((line) => [
      `${line.sourceLineId}:${line.destinationLocationId}`,
      line
    ]));
    for (const entry of distributed) {
      const allocation = entry.allocation;
      const releasedPalletsForAllocation = round(positive(allocation.released_pallets) + entry.releasedPallets);
      const releasedSalesQtyForAllocation = round(positive(allocation.released_sales_qty) + entry.releasedSalesQty);
      const cancelledPalletsForAllocation = round(positive(allocation.cancelled_pallets) + entry.cancelledPallets);
      const cancelledSalesQtyForAllocation = round(positive(allocation.cancelled_sales_qty) + entry.cancelledSalesQty);
      const status = entry.heldPallets > EPSILON
        ? "held"
        : releasedPalletsForAllocation > EPSILON
          ? "released"
          : "cancelled";
      const splitLine = splitLineBySourceDestination.get(`${allocation.source_line_id}:${allocation.destination_location_id}`);
      await query(
        `UPDATE scm_smart_blanket_allocations
            SET reserved_pallets = 0, reserved_sales_qty = 0,
                released_pallets = $2, released_sales_qty = $3,
                held_pallets = $4, held_sales_qty = $5,
                cancelled_pallets = $6, cancelled_sales_qty = $7,
                status = $8, split_line_id = COALESCE($9, split_line_id), updated_at = now()
          WHERE id = $1`,
        [allocation.id, releasedPalletsForAllocation, releasedSalesQtyForAllocation,
          entry.heldPallets, entry.heldSalesQty, cancelledPalletsForAllocation,
          cancelledSalesQtyForAllocation, status, splitLine?.id || null]
      );
    }
    await refreshBlanketProposalLineDecisions(release.proposal_id);
    const cumulative = await query(
      `SELECT COALESCE(SUM(released_pallets), 0) AS released_pallets,
              COALESCE(SUM(held_pallets), 0) AS held_pallets,
              COALESCE(SUM(cancelled_pallets), 0) AS cancelled_pallets
         FROM scm_smart_blanket_allocations
        WHERE release_id = $1`,
      [release.id]
    );
    const releasedPallets = round(cumulative.rows[0]?.released_pallets);
    const heldPallets = round(cumulative.rows[0]?.held_pallets);
    const cancelledPallets = round(cumulative.rows[0]?.cancelled_pallets);
    const status = heldPallets > EPSILON
      ? releasedPallets > EPSILON ? "partially_released" : "held"
      : releasedPallets > EPSILON ? "released" : "cancelled";
    const readyDate = validIsoDate(values.readyDate);
    const conservation = decisions.map((decision) => ({
      proposalLineId: decision.proposalLineId,
      requestedPallets: decision.total,
      confirmedPallets: decision.confirmed,
      heldPallets: decision.held,
      cancelledPallets: decision.cancelled,
      conserved: Math.abs(decision.total - decision.confirmed - decision.held - decision.cancelled) <= EPSILON
    }));
    await query(
      `UPDATE scm_smart_blanket_releases
          SET status = $2,
              split_id = COALESCE($3, split_id),
              split_po_id = COALESCE($4, split_po_id),
              split_po_ref = COALESCE(NULLIF($5, ''), split_po_ref),
              ready_date = $6,
              vendor_reference = NULLIF($7, ''),
              packing_number = NULLIF($8, ''),
              credit_status = NULLIF($9, ''),
              remarks = NULLIF($10, ''),
              metadata = metadata || $11::jsonb,
              finalized_at = CASE WHEN $2 IN ('released', 'cancelled') THEN now() ELSE finalized_at END,
              finalized_by = $12,
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END,
              cancelled_by = CASE WHEN $2 = 'cancelled' THEN $12 ELSE cancelled_by END,
              updated_at = now()
        WHERE id = $1`,
      [release.id, status, split?.split?.id || null, split?.split?.splitPoId || null,
        split?.split?.splitPoRef || "", readyDate, text(values.vendorReference),
        text(values.packingNumber), text(values.creditStatus), text(values.remarks),
        JSON.stringify({
          conservation: { releasedPallets, heldPallets, cancelledPallets },
          lastFinalizeRequestHash: finalizeRequestHash,
          lastFinalizeResult: {
            status,
            splitPoRef: split?.split?.splitPoRef || release.split_po_ref || null,
            conservation
          }
        }),
        operatorText(operatorId)]
    );
    await query(
      `UPDATE scm_smart_proposals
          SET status = CASE
                WHEN $2 = 'released' THEN 'completed'
                WHEN $2 = 'cancelled' THEN 'cancelled'
                ELSE 'order_requested'
              END,
              vendor_replied_at = now(), vendor_replied_by = $3,
              vendor_response_status = CASE
                WHEN $2 = 'released' THEN 'confirmed'
                WHEN $2 = 'cancelled' THEN 'cancelled'
                ELSE 'partial'
              END,
              vendor_ready_date = $4,
              vendor_reference = NULLIF($5, ''),
              vendor_packing_number = NULLIF($6, ''),
              vendor_credit_status = NULLIF($7, ''),
              vendor_remarks = NULLIF($8, ''),
              updated_at = now()
        WHERE id = $1`,
      [release.proposal_id, status, operatorText(operatorId), readyDate,
        text(values.vendorReference), text(values.packingNumber),
        text(values.creditStatus), text(values.remarks)]
    );
    await insertReleaseEvent(release.id, "vendor_finalized", operatorId, {
      status,
      splitPoRef: split?.split?.splitPoRef || null,
      conservation
    });
    if (split) await insertReleaseEvent(release.id, "split_created", operatorId, split.split);
    return { releaseId: Number(release.id), idempotent: false, split, conservation };
  });
  const [release] = await releaseRows({ releaseId: finalized.releaseId, limit: 1 });
  const proposal = await getSmartScmProposal(release.proposal_id);
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.blanket.vendor_finalized",
    details: {
      releaseId: finalized.releaseId,
      proposalId: Number(release.proposal_id),
      idempotent: finalized.idempotent,
      splitPoRef: release.split_po_ref,
      conservation: finalized.conservation
    }
  });
  return {
    release: publicRelease(release),
    proposal,
    split: finalized.split || null,
    conservation: finalized.conservation,
    idempotent: finalized.idempotent
  };
}

export async function finalizeSmartScmBlanketVendorWorkflow(proposalId, values = {}, operatorId = null) {
  return finalizeBlanketVendorWorkflow(proposalId, values, operatorId, lockedBlanketWorkflowByProposalId);
}

export async function finalizeSmartScmBlanketRelease(releaseId, values = {}, operatorId = null) {
  return finalizeBlanketVendorWorkflow(releaseId, values, operatorId, lockedBlanketWorkflowByReleaseId);
}

async function refreshBlanketProposalTotals(proposalId) {
  await query(
    `UPDATE scm_smart_proposals proposal
        SET total_pallets = COALESCE((
              SELECT SUM(line.proposed_pallets)
                FROM scm_smart_proposal_lines line
               WHERE line.proposal_id = proposal.id
            ), 0),
            total_weight_lbs = COALESCE((
              SELECT SUM(line.line_weight_lbs)
                FROM scm_smart_proposal_lines line
               WHERE line.proposal_id = proposal.id
            ), 0),
            utilization = CASE
              WHEN COALESCE(NULLIF(run.settings_snapshot->>'truck_capacity_lbs', '')::numeric, 0) > 0
              THEN COALESCE((
                SELECT SUM(line.line_weight_lbs)
                  FROM scm_smart_proposal_lines line
                 WHERE line.proposal_id = proposal.id
              ), 0) / (run.settings_snapshot->>'truck_capacity_lbs')::numeric
              ELSE proposal.utilization
            END,
            updated_at = now()
       FROM scm_smart_planning_runs run
      WHERE proposal.id = $1
        AND run.id = proposal.run_id`,
    [Number(proposalId)]
  );
}

export async function addSmartScmBlanketAlternativeLine(proposalId, values = {}, operatorId = null) {
  const id = integer(proposalId);
  if (!id) throw httpError("Select a valid Blanket proposal.");
  const result = await withTransaction(async () => {
    const proposal = await lockedBlanketProposal(id);
    if (!['order_requested', 'vendor_replied'].includes(proposal.status)) {
      throw httpError("Blanket alternatives can be added only while the vendor reply is open.", 409);
    }
    const releaseResult = await query(
      `SELECT * FROM scm_smart_blanket_releases WHERE proposal_id = $1 FOR UPDATE`,
      [id]
    );
    const release = releaseResult.rows[0];
    if (!release || !BLANKET_PENDING_RELEASE_STATUSES.includes(release.status)) {
      throw httpError("This Blanket release no longer accepts alternatives.", 409);
    }
    if (release.split_id) {
      throw httpError("This Blanket release already created its single local split; additional alternatives cannot be reserved.", 409);
    }
    const requestedPallets = positive(values.proposedPallets ?? values.pallets ?? values.quantity);
    const destinationLocationId = integer(values.destinationLocationId);
    if (requestedPallets <= EPSILON || Math.abs(requestedPallets - Math.round(requestedPallets)) > EPSILON) {
      throw httpError("Blanket alternative quantity must be a positive whole-pallet amount.");
    }
    if (!destinationLocationId) throw httpError("Select a destination yard for the Blanket alternative.");
    const sourceLineId = integer(values.sourceLineId);
    const itemId = integer(values.itemId);
    if (!sourceLineId && !itemId) throw httpError("Select an alternative item from this source PO.");
    await query(
      `SELECT id FROM purchase_order_lines
        WHERE purchase_order_id = $1
          AND ($2::bigint IS NULL OR id = $2)
          AND ($3::bigint IS NULL OR item_id = $3)
        ORDER BY id
        FOR UPDATE`,
      [release.source_po_id, sourceLineId, itemId]
    );
    const pool = await blanketPoolLineRows({
      sourcePoId: release.source_po_id,
      isBlanket: true,
      limit: 20000
    });
    const source = pool.find((row) => sourceLineId
      ? Number(row.source_line_id) === sourceLineId
      : Number(row.item_id) === itemId);
    if (!source || positive(source.remaining_pallets) + EPSILON < requestedPallets) {
      throw httpError("The selected alternative no longer has enough remaining quantity on this source PO.", 409, "SCM_BLANKET_POOL_CHANGED");
    }
    const originalLineId = integer(values.alternativeForLineId);
    if (originalLineId) {
      const original = await query(
        `SELECT id FROM scm_smart_proposal_lines WHERE id = $1 AND proposal_id = $2`,
        [originalLineId, id]
      );
      if (!original.rowCount) throw httpError("The replaced proposal line was not found.");
    }
    const destinationName = String(destinationLocationId) === "1" ? "3445"
      : String(destinationLocationId) === "15" ? "12441"
        : String(destinationLocationId) === "28" ? "2967"
          : String(destinationLocationId) === "26" ? "150"
            : String(destinationLocationId);
    const proposedSalesQty = round(requestedPallets * positive(source.to_plt));
    const lineWeight = round(requestedPallets * positive(source.pallet_weight_lbs));
    const inserted = await query(
      `INSERT INTO scm_smart_proposal_lines (
         proposal_id, item_id, item_name, item_description, unit,
         required_pallets, proposed_pallets, confirmed_pallets, residual_pallets,
         sales_quantity, pallet_weight_lbs, line_weight_lbs,
         to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason,
         destination_location_id, destination_name, urgent, urgency_level,
         urgency_score, provisional, is_alternative, alternative_for_line_id,
         added_source, added_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$6,0,$6,$7,$8,$9,$10,$11,$12,$13,false,$14::jsonb,
         $15,$16,false,'normal',0,false,true,$17,'manual',$18
       ) RETURNING id`,
      [id, source.item_id, source.item_name, source.item_description, source.unit,
        requestedPallets, proposedSalesQty, source.pallet_weight_lbs, lineWeight,
        source.to_plt, source.to_lyr, source.to_sec, source.to_pcs,
        JSON.stringify({ blanketAlternative: true, sourcePoRef: release.source_po_ref, sourceLineId: source.source_line_id }),
        destinationLocationId, destinationName, originalLineId, operatorText(operatorId)]
    );
    const proposalLineId = Number(inserted.rows[0].id);
    const allocation = await query(
      `INSERT INTO scm_smart_blanket_allocations (
         proposal_id, proposal_line_id, release_id, source_po_id, source_po_ref,
         source_line_id, item_id, destination_location_id, destination_name,
         planned_pallets, planned_sales_qty, reserved_pallets, reserved_sales_qty,
         status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,$11,'reserved')
       RETURNING id`,
      [id, proposalLineId, release.id, release.source_po_id, release.source_po_ref,
        source.source_line_id, source.item_id, destinationLocationId, destinationName,
        requestedPallets, proposedSalesQty]
    );
    await refreshBlanketProposalTotals(id);
    await insertReleaseEvent(release.id, "alternative_added", operatorId, {
      proposalLineId,
      allocationId: Number(allocation.rows[0].id),
      sourceLineId: Number(source.source_line_id),
      itemId: Number(source.item_id),
      pallets: requestedPallets
    });
    return { releaseId: Number(release.id), proposalLineId };
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.blanket.alternative_added",
    details: { proposalId: id, ...result }
  });
  return {
    proposal: await getSmartScmProposal(id),
    release: publicRelease((await releaseRows({ releaseId: result.releaseId, limit: 1 }))[0])
  };
}

export async function removeSmartScmBlanketAlternativeLine(proposalId, lineId, operatorId = null) {
  const id = integer(proposalId);
  const targetLineId = integer(lineId);
  if (!id || !targetLineId) throw httpError("Select a valid Blanket alternative line.");
  const result = await withTransaction(async () => {
    await lockedBlanketProposal(id);
    const selected = await query(
      `SELECT line.*, allocation.id AS allocation_id, allocation.release_id,
              allocation.status AS allocation_status,
              allocation.source_po_id AS allocation_source_po_id,
              allocation.source_po_ref AS allocation_source_po_ref,
              allocation.source_line_id AS allocation_source_line_id,
              allocation.destination_location_id AS allocation_destination_location_id,
              allocation.destination_name AS allocation_destination_name,
              allocation.planned_pallets AS allocation_planned_pallets,
              allocation.planned_sales_qty AS allocation_planned_sales_qty,
              allocation.reserved_pallets AS allocation_reserved_pallets,
              allocation.reserved_sales_qty AS allocation_reserved_sales_qty,
              allocation.released_pallets AS allocation_released_pallets,
              allocation.released_sales_qty AS allocation_released_sales_qty,
              allocation.held_pallets AS allocation_held_pallets,
              allocation.held_sales_qty AS allocation_held_sales_qty,
              allocation.cancelled_pallets AS allocation_cancelled_pallets,
              allocation.cancelled_sales_qty AS allocation_cancelled_sales_qty
         FROM scm_smart_proposal_lines line
         JOIN scm_smart_blanket_allocations allocation ON allocation.proposal_line_id = line.id
        WHERE line.id = $1 AND line.proposal_id = $2
        FOR UPDATE OF line, allocation`,
      [targetLineId, id]
    );
    const line = selected.rows[0];
    if (!line || line.is_alternative !== true) throw httpError("Blanket alternative line was not found.", 404);
    if (!['reserved', 'held'].includes(line.allocation_status)) {
      throw httpError("A released or cancelled Blanket alternative cannot be removed.", 409);
    }
    await query("DELETE FROM scm_smart_blanket_allocations WHERE id = $1", [line.allocation_id]);
    await query("DELETE FROM scm_smart_proposal_lines WHERE id = $1", [targetLineId]);
    await refreshBlanketProposalTotals(id);
    await insertReleaseEvent(line.release_id, "alternative_removed", operatorId, {
      proposalLineId: targetLineId,
      allocationId: Number(line.allocation_id),
      itemId: Number(line.item_id),
      pallets: positive(line.proposed_pallets),
      removedAllocation: {
        sourcePoId: Number(line.allocation_source_po_id),
        sourcePoRef: line.allocation_source_po_ref,
        sourceLineId: Number(line.allocation_source_line_id),
        destinationLocationId: Number(line.allocation_destination_location_id),
        destinationName: line.allocation_destination_name,
        plannedPallets: positive(line.allocation_planned_pallets),
        plannedSalesQty: positive(line.allocation_planned_sales_qty),
        reservedPallets: positive(line.allocation_reserved_pallets),
        reservedSalesQty: positive(line.allocation_reserved_sales_qty),
        releasedPallets: positive(line.allocation_released_pallets),
        releasedSalesQty: positive(line.allocation_released_sales_qty),
        heldPallets: positive(line.allocation_held_pallets),
        heldSalesQty: positive(line.allocation_held_sales_qty),
        cancelledPallets: positive(line.allocation_cancelled_pallets),
        cancelledSalesQty: positive(line.allocation_cancelled_sales_qty),
        status: line.allocation_status
      }
    });
    return { releaseId: Number(line.release_id) };
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.blanket.alternative_removed",
    details: { proposalId: id, proposalLineId: targetLineId }
  });
  return {
    proposal: await getSmartScmProposal(id),
    release: publicRelease((await releaseRows({ releaseId: result.releaseId, limit: 1 }))[0])
  };
}

export async function searchSmartScmBlanketAlternatives(proposalId, { search = "", limit = 20 } = {}) {
  const id = integer(proposalId);
  if (!id) throw httpError("Select a valid Blanket proposal.");
  const proposalRows = await releaseRows({ proposalId: id, limit: 1 });
  const release = proposalRows[0];
  if (!release) throw httpError("Blanket release was not found.", 404);
  const pool = await blanketPoolLineRows({
    sourcePoId: release.source_po_id,
    isBlanket: true,
    search,
    limit: Math.min(100, Math.max(1, Number(limit) || 20))
  });
  return pool.map((row) => ({
    ...sourceLineRow(row),
    sameSourcePo: true,
    sourcePoRef: release.source_po_ref
  }));
}

export async function assertSmartScmBlanketCanUnflag(orderRef = "") {
  const ref = text(orderRef);
  if (!ref) throw httpError("Purchase order reference is required.");
  const result = await query(
    `SELECT po.netsuite_id,
            EXISTS (
              SELECT 1 FROM dispatch_scm_po_splits split
               WHERE split.source_po_id = po.netsuite_id AND split.status = 'active'
            ) AS has_active_splits,
            EXISTS (
              SELECT 1 FROM scm_smart_blanket_releases release
               WHERE release.source_po_id = po.netsuite_id
                 AND release.status = ANY($2::text[])
            ) AS has_pending_releases
       FROM purchase_orders po
      WHERE lower(po.tranid) = lower($1)
         OR lower(COALESCE(po.dispatch_ref, '')) = lower($1)
         OR po.netsuite_id::text = $1
      ORDER BY CASE WHEN lower(po.tranid) = lower($1) THEN 0 ELSE 1 END
      LIMIT 1`,
    [ref, BLANKET_PENDING_RELEASE_STATUSES]
  );
  if (!result.rowCount) throw httpError(`Purchase order ${ref} was not found.`, 404);
  const row = result.rows[0];
  if (row.has_active_splits || row.has_pending_releases) {
    throw Object.assign(httpError("This Blanket PO has active releases and cannot be unflagged.", 409, "SCM_BLANKET_UNFLAG_UNSAFE"), {
      conflicts: {
        activeSplits: row.has_active_splits === true,
        pendingReleases: row.has_pending_releases === true
      }
    });
  }
  return { ok: true, sourcePoId: Number(row.netsuite_id) };
}
