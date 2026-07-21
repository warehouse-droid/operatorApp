import { query, withTransaction } from "./db.js";
import { writeAudit } from "./auth-repository.js";
import { getSmartScmPlanningRun, getSmartScmProposal, smartScmPackWholePalletLines } from "./smart-scm-planning-repository.js";
import { getSmartScmRouteRule } from "./smart-scm-route-repository.js";

const EPSILON = 0.000001;
const EDITABLE_STATUSES = new Set(["draft", "held", "reviewed", "attention"]);
const YARDS = Object.freeze([
  { locationId: 1, code: "3445" },
  { locationId: 28, code: "2967" },
  { locationId: 15, code: "12441" },
  { locationId: 26, code: "150" }
]);
const YARD_BY_ID = new Map(YARDS.map((yard) => [yard.locationId, yard]));
const PO_STOP_PRIORITY = new Map([[26, 0], [15, 1], [1, 2], [28, 3]]);

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

function normalized(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function hasExecutionReference(proposal) {
  return Boolean(proposal.netsuite_transfer_order_id || proposal.netsuite_transfer_order_ref
    || proposal.netsuite_purchase_order_id || proposal.netsuite_purchase_order_ref);
}

function assertEditableProposal(proposal) {
  if (!proposal) throw Object.assign(new Error("Smart SCM proposal was not found."), { status: 404 });
  if (!EDITABLE_STATUSES.has(proposal.status)) {
    throw Object.assign(new Error("Only an unrequested draft, held, reviewed, or attention load can be edited."), { status: 409 });
  }
  if (hasExecutionReference(proposal)) {
    throw Object.assign(new Error("This proposal already has an execution reference and cannot be edited."), { status: 409 });
  }
}

function routeStopsForLines(lines = [], routeRule = null) {
  const priority = new Map((routeRule?.enabled === false ? [...PO_STOP_PRIORITY.keys()] : routeRule?.stopOrder || [...PO_STOP_PRIORITY.keys()])
    .map((locationId, index) => [Number(locationId), index]));
  const stops = [];
  for (const line of lines) {
    const locationId = Number(line.destination_location_id ?? line.destinationLocationId);
    if (!Number.isInteger(locationId) || stops.some((stop) => stop.locationId === locationId)) continue;
    stops.push({
      locationId,
      name: line.destination_name || line.destinationName || YARD_BY_ID.get(locationId)?.code || String(locationId),
      sequence: stops.length + 1
    });
  }
  return stops
    .sort((left, right) => (priority.get(left.locationId) ?? 99) - (priority.get(right.locationId) ?? 99))
    .map((stop, index) => ({ ...stop, sequence: index + 1 }));
}

function draftLine(row) {
  return {
    itemId: Number(row.item_id),
    itemName: row.item_name,
    itemDescription: row.item_description,
    unit: row.unit,
    destinationLocationId: Number(row.destination_location_id),
    destinationName: row.destination_name,
    requiredPallets: positive(row.required_pallets),
    proposedPallets: positive(row.proposed_pallets),
    confirmedPallets: 0,
    residualPallets: positive(row.proposed_pallets),
    salesQuantity: positive(row.sales_quantity),
    palletWeight: positive(row.pallet_weight_lbs),
    lineWeight: positive(row.line_weight_lbs),
    toPlt: positive(row.to_plt),
    toLyr: positive(row.to_lyr),
    toSec: positive(row.to_sec),
    toPcs: positive(row.to_pcs),
    manualPlanningRequired: Boolean(row.manual_planning_required),
    urgent: Boolean(row.urgent),
    provisional: Boolean(row.provisional),
    reason: row.reason || {}
  };
}

function combineLines(lines, next) {
  const existing = lines.find((line) => line.itemId === next.itemId
    && line.destinationLocationId === next.destinationLocationId);
  if (!existing) {
    lines.push({ ...next });
    return;
  }
  for (const key of ["requiredPallets", "proposedPallets", "confirmedPallets", "residualPallets", "salesQuantity", "lineWeight"]) {
    existing[key] = round(positive(existing[key]) + positive(next[key]));
  }
  existing.urgent = Boolean(existing.urgent || next.urgent);
  existing.provisional = Boolean(existing.provisional || next.provisional);
  existing.reason = {
    ...(existing.reason || {}),
    urgent: existing.urgent,
    provisional: existing.provisional
  };
}

function wholePalletQuantity(value) {
  const pallets = positive(value);
  return pallets <= EPSILON ? 0 : Math.max(1, Math.round(pallets));
}

function allocatedLine(line, pallets, requestedPallets, capacityRatio) {
  return {
    ...line,
    proposedPallets: pallets,
    confirmedPallets: 0,
    residualPallets: pallets,
    salesQuantity: round(pallets * positive(line.toPlt)),
    lineWeight: round(pallets * positive(line.palletWeight)),
    reason: {
      ...(line.reason || {}),
      manuallyGrouped: true,
      proportionalAllocationPart: 1,
      groupingRoundedFromPallets: round(positive(line.proposedPallets)),
      groupingRequestedPallets: requestedPallets,
      groupingAllocatedPallets: pallets,
      groupingDeferredPallets: Math.max(0, requestedPallets - pallets),
      groupingCapacityRatio: round(capacityRatio)
    }
  };
}

export function smartScmAllocateProRata(lines = [], capacityLbs = 0) {
  const capacity = positive(capacityLbs);
  if (capacity <= EPSILON) throw new Error("Truck capacity must be greater than zero.");
  if (!lines.length) return [];
  if (lines.some((line) => positive(line.palletWeight) <= EPSILON || positive(line.proposedPallets) <= EPSILON)) {
    throw new Error("Every grouped line needs a positive pallet quantity and pallet weight.");
  }
  if (lines.some((line) => positive(line.palletWeight) > capacity + EPSILON)) {
    throw new Error("At least one pallet is heavier than the configured truck capacity.");
  }
  const entries = lines.map((line, index) => ({
    line,
    index,
    requestedPallets: wholePalletQuantity(line.proposedPallets),
    palletWeight: positive(line.palletWeight),
    allocatedPallets: 0,
    idealPallets: 0
  }));
  const representationWeight = entries.reduce((sum, entry) => sum + entry.palletWeight, 0);
  if (representationWeight > capacity + EPSILON) {
    throw new Error("The selected lines cannot fit at least one whole pallet each in one truck. Remove one or more lines before grouping.");
  }
  const requestedWeight = entries.reduce((sum, entry) => sum + (entry.requestedPallets * entry.palletWeight), 0);
  const capacityRatio = requestedWeight > capacity + EPSILON ? capacity / requestedWeight : 1;
  for (const entry of entries) {
    entry.idealPallets = entry.requestedPallets * capacityRatio;
    entry.allocatedPallets = capacityRatio >= 1 - EPSILON
      ? entry.requestedPallets
      : Math.max(1, Math.floor(entry.idealPallets + EPSILON));
  }
  let allocatedWeight = entries.reduce((sum, entry) => sum + (entry.allocatedPallets * entry.palletWeight), 0);
  if (allocatedWeight > capacity + EPSILON) {
    for (const entry of entries) entry.allocatedPallets = 1;
    allocatedWeight = representationWeight;
  }
  while (true) {
    const candidates = entries.filter((entry) => entry.allocatedPallets < entry.requestedPallets
      && allocatedWeight + entry.palletWeight <= capacity + EPSILON);
    if (!candidates.length) break;
    candidates.sort((left, right) => {
      const leftCost = Math.abs((left.allocatedPallets + 1) - left.idealPallets) - Math.abs(left.allocatedPallets - left.idealPallets);
      const rightCost = Math.abs((right.allocatedPallets + 1) - right.idealPallets) - Math.abs(right.allocatedPallets - right.idealPallets);
      if (Math.abs(leftCost - rightCost) > EPSILON) return leftCost - rightCost;
      if (Boolean(left.line.urgent) !== Boolean(right.line.urgent)) return left.line.urgent ? -1 : 1;
      const leftShare = left.allocatedPallets / left.requestedPallets;
      const rightShare = right.allocatedPallets / right.requestedPallets;
      if (Math.abs(leftShare - rightShare) > EPSILON) return leftShare - rightShare;
      if (Math.abs(left.palletWeight - right.palletWeight) > EPSILON) return right.palletWeight - left.palletWeight;
      return left.index - right.index;
    });
    candidates[0].allocatedPallets += 1;
    allocatedWeight += candidates[0].palletWeight;
  }
  const allocation = entries.map((entry) => allocatedLine(
    entry.line, entry.allocatedPallets, entry.requestedPallets, capacityRatio
  ));
  const finalWeight = allocation.reduce((sum, line) => sum + positive(line.lineWeight), 0);
  if (finalWeight > capacity + EPSILON || allocation.some((line) => !Number.isInteger(line.proposedPallets))) {
    throw new Error("Whole-pallet allocation could not be kept within the configured truck capacity.");
  }
  return [allocation];
}

async function settingsRow() {
  const result = await query("SELECT truck_capacity_lbs, hold_load_ratio FROM scm_smart_settings WHERE id = 1");
  if (!result.rowCount) throw new Error("Smart SCM settings are missing. Run migrations first.");
  return result.rows[0];
}

async function rawProposal(proposalId, { lock = false } = {}) {
  const result = await query(`SELECT * FROM scm_smart_proposals WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [Number(proposalId)]);
  return result.rows[0] || null;
}

async function rawProposalLines(proposalIds) {
  const ids = proposalIds.map(Number);
  const result = await query(
    `SELECT * FROM scm_smart_proposal_lines
      WHERE proposal_id = ANY($1::bigint[])
      ORDER BY array_position($1::bigint[], proposal_id), id`,
    [ids]
  );
  return result.rows;
}

async function updateDerivedProposal(proposalId) {
  const lines = await rawProposalLines([proposalId]);
  if (!lines.length) return null;
  const settings = await settingsRow();
  const proposal = await rawProposal(proposalId);
  const routeRule = await getSmartScmRouteRule(proposal?.source_name);
  const routeStops = routeStopsForLines(lines, routeRule);
  const totalPallets = round(lines.reduce((sum, line) => sum + positive(line.proposed_pallets), 0));
  const totalWeight = round(lines.reduce((sum, line) => sum + positive(line.proposed_pallets) * positive(line.pallet_weight_lbs), 0));
  await query(
    `UPDATE scm_smart_proposals
        SET destination_location_id = $2,
            destination_name = $3,
            route_stops = $4::jsonb,
            total_pallets = $5,
            total_weight_lbs = $6,
            utilization = CASE WHEN $7::numeric > 0 THEN $6::numeric / $7::numeric ELSE 0 END,
            urgent = EXISTS (SELECT 1 FROM scm_smart_proposal_lines line WHERE line.proposal_id = $1 AND line.urgent),
            provisional = EXISTS (SELECT 1 FROM scm_smart_proposal_lines line WHERE line.proposal_id = $1 AND line.provisional),
            updated_at = now()
      WHERE id = $1`,
    [Number(proposalId), routeStops[0].locationId, routeStops[0].name, JSON.stringify(routeStops), totalPallets, totalWeight, positive(settings.truck_capacity_lbs)]
  );
  return { totalPallets, totalWeight, capacity: positive(settings.truck_capacity_lbs), routeStops };
}

async function recordRevision(runId, reason, diff, operatorId) {
  const revision = await query(
    "UPDATE scm_smart_planning_runs SET revision = revision + 1 WHERE id = $1 RETURNING revision",
    [Number(runId)]
  );
  const numberValue = Number(revision.rows[0]?.revision || 1);
  await query(
    `INSERT INTO scm_smart_plan_revisions (run_id, revision, reason, before_snapshot, after_snapshot, diff, created_by)
     VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, $4::jsonb, $5)`,
    [Number(runId), numberValue, reason, JSON.stringify(diff || {}), operatorId]
  );
  const counts = await query(
    `SELECT COUNT(*)::int AS proposals,
            COUNT(*) FILTER (WHERE proposal_type = 'PO')::int AS po_proposals,
            COUNT(*) FILTER (WHERE proposal_type = 'TO')::int AS to_proposals,
            COUNT(*) FILTER (WHERE status = 'held')::int AS held
       FROM scm_smart_proposals WHERE run_id = $1`,
    [Number(runId)]
  );
  await query(
    `UPDATE scm_smart_planning_runs
        SET totals = totals || jsonb_build_object(
          'proposals', $2::int, 'poProposals', $3::int, 'toProposals', $4::int, 'held', $5::int
        )
      WHERE id = $1`,
    [Number(runId), counts.rows[0].proposals, counts.rows[0].po_proposals, counts.rows[0].to_proposals, counts.rows[0].held]
  );
  return numberValue;
}

async function insertGroupedDraft(runId, draft) {
  const proposal = await query(
    `INSERT INTO scm_smart_proposals (
       run_id, proposal_key, proposal_type, phase, source_kind, source_location_id, source_name,
       destination_location_id, destination_name, vendor, plant, status, urgent, provisional,
       total_pallets, total_weight_lbs, utilization, memo, route_stops, manually_grouped
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,true)
     RETURNING id`,
    [runId, draft.proposalKey, draft.proposalType, draft.phase, draft.sourceKind, draft.sourceLocationId,
      draft.sourceName, draft.destinationLocationId, draft.destinationName, draft.vendor, draft.plant,
      draft.status, draft.urgent, draft.provisional, draft.totalPallets, draft.totalWeight,
      draft.utilization, draft.memo, JSON.stringify(draft.routeStops)]
  );
  for (const line of draft.lines) {
    await query(
      `INSERT INTO scm_smart_proposal_lines (
         proposal_id, item_id, item_name, item_description, unit, required_pallets, proposed_pallets,
         confirmed_pallets, residual_pallets, sales_quantity, pallet_weight_lbs, line_weight_lbs,
         to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason,
         destination_location_id, destination_name, added_source, added_by, urgent, provisional
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,'manual',$19,$20,$21)`,
      [proposal.rows[0].id, line.itemId, line.itemName, line.itemDescription, line.unit,
        line.requiredPallets, line.proposedPallets, line.salesQuantity, line.palletWeight,
        line.lineWeight, line.toPlt, line.toLyr, line.toSec, line.toPcs,
        line.manualPlanningRequired, JSON.stringify(line.reason || {}), line.destinationLocationId,
        line.destinationName, draft.operatorId, Boolean(line.urgent), Boolean(line.provisional)]
    );
  }
  return Number(proposal.rows[0].id);
}

export async function groupSmartScmProposals(proposalIds = [], operatorId = null) {
  const ids = [...new Set(proposalIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length < 2) throw Object.assign(new Error("Select at least two loads to group."), { status: 400 });
  if (ids.length > 20) throw Object.assign(new Error("Group no more than 20 loads at once."), { status: 400 });
  const outcome = await withTransaction(async () => {
    const selectedResult = await query(
      "SELECT * FROM scm_smart_proposals WHERE id = ANY($1::bigint[]) FOR UPDATE",
      [ids]
    );
    if (selectedResult.rowCount !== ids.length) throw Object.assign(new Error("One or more selected loads no longer exist."), { status: 404 });
    const byId = new Map(selectedResult.rows.map((row) => [Number(row.id), row]));
    const selected = ids.map((id) => byId.get(id));
    selected.forEach(assertEditableProposal);
    const first = selected[0];
    if (selected.some((proposal) => Number(proposal.run_id) !== Number(first.run_id))) {
      throw Object.assign(new Error("Loads must belong to the same planning run."), { status: 409 });
    }
    if (selected.some((proposal) => proposal.proposal_type !== first.proposal_type || proposal.phase !== first.phase)) {
      throw Object.assign(new Error("Only loads of the same PO/TO type and planning phase can be grouped."), { status: 409 });
    }
    if (first.proposal_type === "TO") {
      if (selected.some((proposal) => Number(proposal.source_location_id) !== Number(first.source_location_id)
        || Number(proposal.destination_location_id) !== Number(first.destination_location_id))) {
        throw Object.assign(new Error("TO loads can be grouped only when source and destination yards are the same."), { status: 409 });
      }
    } else {
      const pickup = normalized(first.plant || first.source_name);
      const vendor = normalized(first.vendor);
      if (selected.some((proposal) => normalized(proposal.plant || proposal.source_name) !== pickup
        || normalized(proposal.vendor) !== vendor)) {
        throw Object.assign(new Error("PO loads can be grouped only when they use the same vendor and pickup point."), { status: 409 });
      }
      const vendors = await query(
        `SELECT ARRAY_REMOVE(ARRAY_AGG(DISTINCT item.vendor_id), NULL) AS vendor_ids
           FROM scm_smart_proposal_lines line
           JOIN inventory_items item ON item.item_id = line.item_id
          WHERE line.proposal_id = ANY($1::bigint[])`,
        [ids]
      );
      if ((vendors.rows[0]?.vendor_ids || []).length !== 1) {
        throw Object.assign(new Error("A grouped PO load must contain exactly one NetSuite vendor."), { status: 409 });
      }
    }
    const rawLines = await rawProposalLines(ids);
    const combined = [];
    rawLines.map(draftLine).forEach((line) => combineLines(combined, line));
    if (first.proposal_type === "PO" && new Set(combined.map((line) => line.destinationLocationId)).size > 2) {
      throw Object.assign(new Error("A grouped PO truck may have at most two destination yards. Select loads with no more than two combined drops."), { status: 409 });
    }
    const settings = await settingsRow();
    const routeRule = await getSmartScmRouteRule(first.source_name);
    const allocations = smartScmAllocateProRata(combined, settings.truck_capacity_lbs);
    const deferredPallets = round(allocations.flat().reduce(
      (sum, line) => sum + positive(line.reason?.groupingDeferredPallets), 0
    ));
    const capacityLimited = deferredPallets > EPSILON;
    const namespace = `${Date.now()}-${ids.join("-")}`;
    await query("DELETE FROM scm_smart_proposals WHERE id = ANY($1::bigint[])", [ids]);
    const createdIds = [];
    for (let index = 0; index < allocations.length; index += 1) {
      const lines = allocations[index];
      const routeStops = routeStopsForLines(lines, routeRule);
      const totalPallets = round(lines.reduce((sum, line) => sum + line.proposedPallets, 0));
      const totalWeight = round(lines.reduce((sum, line) => sum + line.lineWeight, 0));
      const utilization = round(totalWeight / positive(settings.truck_capacity_lbs));
      const urgent = lines.some((line) => Boolean(line.urgent));
      const provisional = lines.some((line) => Boolean(line.provisional));
      const coverageReviewRequired = lines.some((line) => Boolean(line.reason?.coverageReviewRequired));
      const status = first.proposal_type === "PO" || coverageReviewRequired
        || utilization < positive(settings.hold_load_ratio, 0.5) ? "held" : "draft";
      createdIds.push(await insertGroupedDraft(first.run_id, {
        proposalKey: `manual-group:${namespace}:${index + 1}`,
        proposalType: first.proposal_type,
        phase: first.phase,
        sourceKind: first.source_kind,
        sourceLocationId: first.source_location_id,
        sourceName: first.source_name,
        destinationLocationId: routeStops[0].locationId,
        destinationName: routeStops[0].name,
        vendor: first.vendor,
        plant: first.plant,
        status,
        urgent,
        provisional,
        totalPallets,
        totalWeight,
        utilization,
        memo: `manually grouped load · ${lines.length} line${lines.length === 1 ? "" : "s"}${capacityLimited ? ` · ${deferredPallets} PLT deferred` : ""}`,
        routeStops,
        lines,
        operatorId
      }));
    }
    const revision = await recordRevision(first.run_id, "Manual proposal load grouping", {
      groupedProposalIds: ids,
      createdProposalIds: createdIds,
      proportionalCapacityAllocation: capacityLimited,
      wholePalletAllocation: true,
      deferredPallets
    }, operatorId);
    return { runId: Number(first.run_id), createdIds, revision, allocations: allocations.length, capacityLimited, deferredPallets };
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.proposal.group",
    details: { proposalIds: ids, ...outcome }
  });
  return getSmartScmPlanningRun(outcome.runId);
}

export async function recalculateSmartScmPoProposal(proposalId, operatorId = null) {
  const id = Number(proposalId);
  const outcome = await withTransaction(async () => {
    const proposal = await rawProposal(id, { lock: true });
    assertEditableProposal(proposal);
    if (proposal.proposal_type !== "PO") {
      throw Object.assign(new Error("Only a PO proposal can be recalculated into purchase loads."), { status: 400 });
    }
    const sourceLines = (await rawProposalLines([id])).map(draftLine);
    if (!sourceLines.length) throw Object.assign(new Error("This PO proposal has no lines to recalculate."), { status: 409 });
    const normalizedLines = sourceLines.map((line) => {
      const pallets = wholePalletQuantity(line.proposedPallets);
      if (pallets <= 0) throw Object.assign(new Error("Every PO line must contain at least one whole pallet."), { status: 409 });
      return {
        ...line,
        proposedPallets: pallets,
        confirmedPallets: 0,
        residualPallets: pallets,
        salesQuantity: round(pallets * positive(line.toPlt)),
        lineWeight: round(pallets * positive(line.palletWeight)),
        reason: {
          ...(line.reason || {}),
          poRecalculated: true,
          poRecalculatedFromPallets: round(positive(line.proposedPallets))
        }
      };
    });
    const settings = await settingsRow();
    const routeRule = await getSmartScmRouteRule(proposal.source_name);
    const packed = smartScmPackWholePalletLines(normalizedLines, settings.truck_capacity_lbs, {
      proposalType: "PO", sourceName: proposal.source_name, maxStops: 2, routeRule
    });
    if (!packed.length) throw Object.assign(new Error("The PO recalculation did not produce a load."), { status: 409 });
    const beforePallets = round(normalizedLines.reduce((sum, line) => sum + line.proposedPallets, 0));
    const afterPallets = round(packed.flatMap((load) => load.lines).reduce((sum, line) => sum + positive(line.proposedPallets), 0));
    if (beforePallets !== afterPallets) throw new Error("PO recalculation did not preserve the whole-pallet purchase quantity.");
    await query("DELETE FROM scm_smart_proposals WHERE id = $1", [id]);
    const namespace = `${Date.now()}-${id}`;
    const createdIds = [];
    for (let index = 0; index < packed.length; index += 1) {
      const load = packed[index];
      const routeStops = load.routeStops || routeStopsForLines(load.lines, routeRule);
      const urgent = load.lines.some((line) => Boolean(line.urgent));
      const provisional = load.lines.some((line) => Boolean(line.provisional));
      const utilization = round(load.totalWeight / positive(settings.truck_capacity_lbs));
      createdIds.push(await insertGroupedDraft(proposal.run_id, {
        proposalKey: `po-recalculated:${namespace}:${index + 1}`,
        proposalType: "PO",
        phase: proposal.phase,
        sourceKind: proposal.source_kind,
        sourceLocationId: proposal.source_location_id,
        sourceName: proposal.source_name,
        destinationLocationId: routeStops[0].locationId,
        destinationName: routeStops[0].name,
        vendor: proposal.vendor,
        plant: proposal.plant,
        status: "held",
        urgent,
        provisional,
        totalPallets: load.totalPallets,
        totalWeight: load.totalWeight,
        utilization,
        memo: `PO recalculated load ${index + 1}/${packed.length} · ${routeStops.map((stop) => stop.name).join(" → ")}`,
        routeStops,
        lines: load.lines,
        operatorId
      }));
    }
    const revision = await recordRevision(proposal.run_id, "PO proposal loads recalculated", {
      originalProposalId: id,
      createdProposalIds: createdIds,
      loadCount: createdIds.length,
      maxDropsPerLoad: 2,
      wholePallets: afterPallets,
      gormleyHubRedirected: packed.some((load) => load.lines.some((line) => line.reason?.gormleyHubRedirected))
    }, operatorId);
    return { runId: Number(proposal.run_id), createdIds, revision, loadCount: createdIds.length };
  });
  await writeAudit({
    actorOperatorId: operatorId,
    source: "smart_scm",
    action: "smart_scm.po_proposal.recalculate",
    details: { proposalId: id, ...outcome }
  });
  return getSmartScmPlanningRun(outcome.runId);
}

async function itemPolicy(itemId, destinationLocationId) {
  const result = await query(
    `SELECT item.item_id, item.item_name, item.item_description, item.stock_unit, item.vendor_id, item.vendor,
            COALESCE(item.to_plt, policy.to_plt) AS to_plt,
            COALESCE(item.to_lyr, policy.to_lyr) AS to_lyr,
            COALESCE(item.to_sec, policy.to_sec) AS to_sec,
            COALESCE(item.to_pcs, policy.to_pcs) AS to_pcs,
            CASE WHEN COALESCE(item.item_weight, 0) > 0 AND COALESCE(item.to_plt, policy.to_plt, 0) > 0
                 THEN item.item_weight * COALESCE(item.to_plt, policy.to_plt) ELSE policy.pallet_weight_lbs END AS pallet_weight_lbs
       FROM inventory_items item
       JOIN scm_smart_item_policies policy ON policy.item_id = item.item_id
       JOIN scm_smart_item_yard_policies yard ON yard.item_id = item.item_id AND yard.location_id = $2 AND yard.eligible = true
      WHERE item.item_id = $1 AND policy.planning_enabled = true AND policy.inactive = false AND policy.discontinued = false`,
    [Number(itemId), Number(destinationLocationId)]
  );
  return result.rows[0] || null;
}

async function inventorySnapshot(itemId, locationId, toPlt) {
  const result = await query(
    `SELECT COALESCE(balance.quantity_available, 0) AS available,
            COALESCE((
              SELECT SUM(GREATEST(COALESCE(line.quantity, 0) - COALESCE(line.netsuite_received_qty, 0), 0))
                FROM purchase_order_lines line JOIN purchase_orders po ON po.netsuite_id = line.purchase_order_id
               WHERE line.item_id = $1 AND COALESCE(line.location_id, po.destination_location_id) = $2 AND line.netsuite_active = true AND po.netsuite_active = true
            ), 0) + COALESCE((
              SELECT SUM(GREATEST(COALESCE(line.quantity, 0) - COALESCE(line.netsuite_received_qty, 0), 0))
                FROM transfer_order_lines line JOIN transfer_orders transfer ON transfer.netsuite_id = line.transfer_order_id
               WHERE line.item_id = $1 AND transfer.to_location_id = $2 AND line.line_stage = 'receiving'
                 AND line.netsuite_active = true AND transfer.netsuite_active = true
            ), 0) AS on_order,
            COALESCE((
              SELECT SUM(GREATEST(COALESCE(line.netsuite_backordered_qty, 0), 0))
                FROM sales_order_lines line JOIN sales_orders sales ON sales.netsuite_id = line.sales_order_id
               WHERE line.item_id = $1
                 AND COALESCE(line.location_id, sales.outbound_location_id, sales.order_location_id) = $2
                 AND line.netsuite_active = true AND sales.netsuite_active = true
            ), 0) AS backordered,
            COALESCE((
              SELECT SUM(reserved_sales_quantity) FROM scm_smart_inventory_reservations
               WHERE item_id = $1 AND source_location_id = $2 AND status = 'active'
            ), 0) AS reserved
       FROM (SELECT 1) seed
       LEFT JOIN inventory_balances balance ON balance.item_id = $1 AND balance.location_id = $2`,
    [Number(itemId), Number(locationId)]
  );
  const row = result.rows[0] || {};
  const conversion = positive(toPlt);
  const availableSales = positive(row.available);
  const onOrderSales = positive(row.on_order);
  const backorderedSales = positive(row.backordered);
  const reservedSales = positive(row.reserved);
  return {
    quantityAvailable: availableSales,
    quantityOnOrder: onOrderSales,
    quantityBackordered: backorderedSales,
    quantityReservedOutbound: reservedSales,
    availablePallets: conversion > EPSILON ? round(Math.max(0, availableSales - reservedSales) / conversion) : 0,
    expectedAvailablePallets: conversion > EPSILON ? round(Math.max(0, availableSales + onOrderSales - backorderedSales) / conversion) : 0
  };
}

async function assertSamePoVendor(proposalId, candidateVendorId) {
  const result = await query(
    `SELECT ARRAY_REMOVE(ARRAY_AGG(DISTINCT item.vendor_id), NULL) AS vendor_ids
       FROM scm_smart_proposal_lines line JOIN inventory_items item ON item.item_id = line.item_id
      WHERE line.proposal_id = $1`,
    [Number(proposalId)]
  );
  const vendorIds = (result.rows[0]?.vendor_ids || []).map(Number);
  if (!candidateVendorId || vendorIds.length !== 1 || vendorIds[0] !== Number(candidateVendorId)) {
    throw Object.assign(new Error("A PO load can contain items from only one NetSuite vendor."), { status: 409 });
  }
}

export async function searchSmartScmProposalItems(proposalId, { search = "", destinationLocationId = null, limit = 12 } = {}) {
  const proposal = await rawProposal(proposalId);
  assertEditableProposal(proposal);
  const term = text(search);
  const destination = proposal.proposal_type === "PO" ? Number(destinationLocationId || proposal.destination_location_id) : Number(proposal.destination_location_id);
  if (!YARD_BY_ID.has(destination)) throw Object.assign(new Error("Select a valid destination yard."), { status: 400 });
  const params = [destination, `%${term}%`, Math.min(30, Math.max(1, Number(limit) || 12))];
  let vendorClause = "";
  if (proposal.proposal_type === "PO") {
    const vendor = await query(
      `SELECT MIN(item.vendor_id) AS vendor_id FROM scm_smart_proposal_lines line
       JOIN inventory_items item ON item.item_id = line.item_id WHERE line.proposal_id = $1`,
      [Number(proposalId)]
    );
    params.push(Number(vendor.rows[0]?.vendor_id || 0));
    vendorClause = `AND item.vendor_id = $${params.length}`;
  }
  const result = await query(
    `SELECT item.item_id, item.item_name, item.item_description, item.vendor, item.stock_unit,
            COALESCE(item.to_plt, policy.to_plt) AS to_plt,
            CASE WHEN COALESCE(item.item_weight, 0) > 0 AND COALESCE(item.to_plt, policy.to_plt, 0) > 0
                 THEN item.item_weight * COALESCE(item.to_plt, policy.to_plt) ELSE policy.pallet_weight_lbs END AS pallet_weight_lbs
       FROM inventory_items item
       JOIN scm_smart_item_policies policy ON policy.item_id = item.item_id
       JOIN scm_smart_item_yard_policies yard ON yard.item_id = item.item_id AND yard.location_id = $1 AND yard.eligible = true
      WHERE policy.planning_enabled = true AND policy.inactive = false AND policy.discontinued = false
        AND (item.item_name ILIKE $2 OR item.item_description ILIKE $2 OR item.item_id::text ILIKE $2)
        ${vendorClause}
      ORDER BY item.item_name, item.item_id LIMIT $3`,
    params
  );
  return result.rows.map((row) => ({
    itemId: Number(row.item_id), itemName: row.item_name, itemDescription: row.item_description,
    vendor: row.vendor, unit: row.stock_unit, toPlt: positive(row.to_plt), palletWeightLbs: positive(row.pallet_weight_lbs)
  }));
}

export async function addSmartScmProposalLine(proposalId, values = {}, operatorId = null) {
  const id = Number(proposalId);
  const itemId = Number(values.itemId);
  const pallets = Number(values.proposedPallets ?? values.pallets);
  if (!Number.isInteger(itemId) || itemId <= 0) throw Object.assign(new Error("Select an item to add."), { status: 400 });
  if (!Number.isInteger(pallets) || pallets <= 0) throw Object.assign(new Error("Proposed pallets must be a positive whole number."), { status: 400 });
  const result = await withTransaction(async () => {
    const proposal = await rawProposal(id, { lock: true });
    assertEditableProposal(proposal);
    const destinationLocationId = proposal.proposal_type === "PO"
      ? Number(values.destinationLocationId || proposal.destination_location_id)
      : Number(proposal.destination_location_id);
    const yard = YARD_BY_ID.get(destinationLocationId);
    if (!yard) throw Object.assign(new Error("Select a valid destination yard."), { status: 400 });
    const item = await itemPolicy(itemId, destinationLocationId);
    if (!item) throw Object.assign(new Error("This item is not enabled for planning at the selected destination yard."), { status: 409 });
    const toPlt = positive(item.to_plt);
    const palletWeight = positive(item.pallet_weight_lbs);
    if (toPlt <= EPSILON || palletWeight <= EPSILON) {
      throw Object.assign(new Error("The selected item needs a pallet conversion and pallet weight."), { status: 409 });
    }
    if (proposal.proposal_type === "PO") await assertSamePoVendor(id, item.vendor_id);
    if (proposal.proposal_type === "TO") {
      const sourcePolicy = await itemPolicy(itemId, proposal.source_location_id);
      if (!sourcePolicy) throw Object.assign(new Error("This item is not enabled at the TO source yard."), { status: 409 });
    }
    const [destinationInventory, sourceInventory, settings] = await Promise.all([
      inventorySnapshot(itemId, destinationLocationId, toPlt),
      proposal.proposal_type === "TO" ? inventorySnapshot(itemId, proposal.source_location_id, toPlt) : Promise.resolve(null),
      settingsRow()
    ]);
    const addedWeight = pallets * palletWeight;
    if (proposal.proposal_type !== "PO" && positive(proposal.total_weight_lbs) + addedWeight > positive(settings.truck_capacity_lbs) + EPSILON) {
      throw Object.assign(new Error("Adding this quantity would exceed the configured truck capacity."), { status: 409 });
    }
    const reason = {
      ...destinationInventory,
      sourceAvailablePallets: sourceInventory?.availablePallets ?? null,
      destinationAvailablePallets: destinationInventory.availablePallets,
      destinationExpectedAvailablePallets: destinationInventory.expectedAvailablePallets,
      manuallyAdded: true
    };
    await query(
      `INSERT INTO scm_smart_proposal_lines (
         proposal_id, item_id, item_name, item_description, unit, required_pallets, proposed_pallets,
         confirmed_pallets, residual_pallets, sales_quantity, pallet_weight_lbs, line_weight_lbs,
         to_plt, to_lyr, to_sec, to_pcs, manual_planning_required, reason,
         destination_location_id, destination_name, added_source, added_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$6,0,$6,$7,$8,$9,$10,$11,$12,$13,false,$14::jsonb,$15,$16,'manual',$17)
       ON CONFLICT (proposal_id, item_id, destination_location_id) DO UPDATE SET
         required_pallets = scm_smart_proposal_lines.required_pallets + EXCLUDED.required_pallets,
         proposed_pallets = scm_smart_proposal_lines.proposed_pallets + EXCLUDED.proposed_pallets,
         residual_pallets = scm_smart_proposal_lines.residual_pallets + EXCLUDED.residual_pallets,
         sales_quantity = scm_smart_proposal_lines.sales_quantity + EXCLUDED.sales_quantity,
         line_weight_lbs = scm_smart_proposal_lines.line_weight_lbs + EXCLUDED.line_weight_lbs,
         reason = scm_smart_proposal_lines.reason || EXCLUDED.reason, updated_at = now()`,
      [id, itemId, item.item_name, item.item_description, item.stock_unit, pallets,
        round(pallets * toPlt), palletWeight, round(addedWeight), toPlt, positive(item.to_lyr),
        positive(item.to_sec), positive(item.to_pcs), JSON.stringify(reason), destinationLocationId, yard.code, operatorId]
    );
    await updateDerivedProposal(id);
    const revision = await recordRevision(proposal.run_id, "Proposal line added", { proposalId: id, itemId, pallets, destinationLocationId }, operatorId);
    return { runId: Number(proposal.run_id), revision };
  });
  await writeAudit({ actorOperatorId: operatorId, source: "smart_scm", action: "smart_scm.proposal_line.add", details: { proposalId: id, itemId, pallets, ...result } });
  return getSmartScmProposal(id);
}

export async function updateSmartScmProposalLine(proposalId, lineId, values = {}, operatorId = null) {
  const id = Number(proposalId);
  const targetLineId = Number(lineId);
  const pallets = Number(values.proposedPallets ?? values.pallets);
  const destinationWasProvided = Object.prototype.hasOwnProperty.call(values, "destinationLocationId");
  if (!Number.isInteger(pallets) || pallets <= 0) throw Object.assign(new Error("Proposed pallets must be a positive whole number; use Remove for this line."), { status: 400 });
  const outcome = await withTransaction(async () => {
    const proposal = await rawProposal(id, { lock: true });
    assertEditableProposal(proposal);
    const lineResult = await query("SELECT * FROM scm_smart_proposal_lines WHERE id = $1 AND proposal_id = $2 FOR UPDATE", [targetLineId, id]);
    if (!lineResult.rowCount) throw Object.assign(new Error("Proposal line was not found."), { status: 404 });
    const line = lineResult.rows[0];
    const beforeDestinationLocationId = Number(line.destination_location_id);
    const destinationLocationId = destinationWasProvided ? Number(values.destinationLocationId) : beforeDestinationLocationId;
    const destinationChanged = destinationLocationId !== beforeDestinationLocationId;
    if (!YARD_BY_ID.has(destinationLocationId)) {
      throw Object.assign(new Error("Select a valid destination yard."), { status: 400 });
    }
    if (proposal.proposal_type !== "PO" && destinationChanged) {
      throw Object.assign(new Error("A TO line destination is fixed by its transfer route. Edit PO line destinations only."), { status: 409 });
    }
    let destinationName = line.destination_name;
    let toPlt = positive(line.to_plt);
    let toLyr = positive(line.to_lyr);
    let toSec = positive(line.to_sec);
    let toPcs = positive(line.to_pcs);
    let palletWeight = positive(line.pallet_weight_lbs);
    let unit = line.unit;
    let reason = { ...(line.reason || {}), manuallyAdjusted: true };
    if (proposal.proposal_type === "PO" && destinationWasProvided) {
      const yard = YARD_BY_ID.get(destinationLocationId);
      const policy = await itemPolicy(line.item_id, destinationLocationId);
      if (!policy) {
        throw Object.assign(new Error(`${line.item_name} is not enabled for Smart SCM planning at ${yard.code}.`), { status: 409 });
      }
      toPlt = positive(policy.to_plt);
      toLyr = positive(policy.to_lyr);
      toSec = positive(policy.to_sec);
      toPcs = positive(policy.to_pcs);
      palletWeight = positive(policy.pallet_weight_lbs);
      unit = policy.stock_unit || unit;
      destinationName = yard.code;
      if (toPlt <= EPSILON || palletWeight <= EPSILON) {
        throw Object.assign(new Error(`${line.item_name} needs a pallet conversion and pallet weight at ${yard.code}.`), { status: 409 });
      }
      if (destinationChanged) {
        const duplicate = await query(
          "SELECT id FROM scm_smart_proposal_lines WHERE proposal_id = $1 AND item_id = $2 AND destination_location_id = $3 AND id <> $4",
          [id, Number(line.item_id), destinationLocationId, targetLineId]
        );
        if (duplicate.rowCount) {
          throw Object.assign(new Error(`${line.item_name} already has a line for ${yard.code} in this load. Adjust or remove that line first.`), { status: 409 });
        }
        const destinations = await query(
          "SELECT DISTINCT destination_location_id FROM scm_smart_proposal_lines WHERE proposal_id = $1 AND id <> $2",
          [id, targetLineId]
        );
        const nextDestinations = new Set(destinations.rows.map((row) => Number(row.destination_location_id)));
        nextDestinations.add(destinationLocationId);
        const routeRule = await getSmartScmRouteRule(proposal.source_name);
        const maximumDrops = routeRule.enabled === false ? 2 : Math.max(1, Math.min(2, Number(routeRule.maxDrops) || 2));
        if (nextDestinations.size > maximumDrops) {
          throw Object.assign(new Error(`${proposal.source_name || "This source"} allows at most ${maximumDrops} destination${maximumDrops === 1 ? "" : "s"} per load. Move or remove another line first.`), { status: 409 });
        }
      }
      const inventory = await inventorySnapshot(line.item_id, destinationLocationId, toPlt);
      reason = {
        ...reason,
        ...inventory,
        destinationAvailablePallets: inventory.availablePallets,
        destinationExpectedAvailablePallets: inventory.expectedAvailablePallets,
        ...(destinationChanged ? {
          destinationManuallyAdjusted: true,
          previousDestinationLocationId: beforeDestinationLocationId,
          previousDestinationName: line.destination_name
        } : {})
      };
      if (destinationChanged) {
        for (const key of [
          "gormleyHubRedirected", "gormleyOriginalDestinations", "routeRulePartialRedirected",
          "routeRuleOriginalDestinations", "routeRuleSource", "actualDestinationYard"
        ]) delete reason[key];
      }
    }
    const settings = await settingsRow();
    const nextWeight = pallets * palletWeight;
    const proposalWeight = positive(proposal.total_weight_lbs) - positive(line.line_weight_lbs) + nextWeight;
    if (proposal.proposal_type !== "PO" && pallets > positive(line.proposed_pallets) + EPSILON && proposalWeight > positive(settings.truck_capacity_lbs) + EPSILON) {
      throw Object.assign(new Error("This quantity would exceed the configured truck capacity."), { status: 409 });
    }
    await query(
      `UPDATE scm_smart_proposal_lines
          SET proposed_pallets = $3, residual_pallets = $3, confirmed_pallets = 0,
        sales_quantity = $3::numeric * $4::numeric,
        line_weight_lbs = $3::numeric * $5::numeric,
              destination_location_id = $6, destination_name = $7,
              unit = $8, to_plt = $4, to_lyr = $9, to_sec = $10, to_pcs = $11,
              pallet_weight_lbs = $5, reason = $12::jsonb, updated_at = now()
        WHERE id = $1 AND proposal_id = $2`,
      [targetLineId, id, pallets, toPlt, palletWeight, destinationLocationId, destinationName,
        unit, toLyr, toSec, toPcs, JSON.stringify(reason)]
    );
    await updateDerivedProposal(id);
    const revision = await recordRevision(proposal.run_id, "Proposal line adjusted", {
      proposalId: id,
      lineId: targetLineId,
      beforePallets: positive(line.proposed_pallets),
      afterPallets: pallets,
      beforeDestinationLocationId,
      destinationLocationId
    }, operatorId);
    return { runId: Number(proposal.run_id), revision, beforeDestinationLocationId, destinationLocationId };
  });
  await writeAudit({ actorOperatorId: operatorId, source: "smart_scm", action: "smart_scm.proposal_line.update", details: { proposalId: id, lineId: targetLineId, pallets, ...outcome } });
  return getSmartScmProposal(id);
}

export async function removeSmartScmProposalLine(proposalId, lineId, operatorId = null) {
  const id = Number(proposalId);
  const targetLineId = Number(lineId);
  const outcome = await withTransaction(async () => {
    const proposal = await rawProposal(id, { lock: true });
    assertEditableProposal(proposal);
    const removed = await query("DELETE FROM scm_smart_proposal_lines WHERE id = $1 AND proposal_id = $2 RETURNING item_id, proposed_pallets", [targetLineId, id]);
    if (!removed.rowCount) throw Object.assign(new Error("Proposal line was not found."), { status: 404 });
    const remaining = await query("SELECT COUNT(*)::int AS count FROM scm_smart_proposal_lines WHERE proposal_id = $1", [id]);
    const deletedProposal = Number(remaining.rows[0]?.count || 0) === 0;
    if (deletedProposal) await query("DELETE FROM scm_smart_proposals WHERE id = $1", [id]);
    else await updateDerivedProposal(id);
    const revision = await recordRevision(proposal.run_id, "Proposal line removed", { proposalId: id, lineId: targetLineId, deletedProposal }, operatorId);
    return { runId: Number(proposal.run_id), revision, deletedProposal, removed: removed.rows[0] };
  });
  await writeAudit({ actorOperatorId: operatorId, source: "smart_scm", action: "smart_scm.proposal_line.remove", details: { proposalId: id, lineId: targetLineId, ...outcome } });
  if (outcome.deletedProposal) return { deleted: true, runId: outcome.runId };
  return getSmartScmProposal(id);
}
