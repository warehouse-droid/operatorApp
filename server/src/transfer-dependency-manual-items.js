import { query, withTransaction } from "./db.js";
import { writeDispatchAudit } from "./dispatch-audit-repository.js";

const EPSILON = 0.000001;
const EDITABLE_PROPOSAL_STATUSES = new Set(["draft", "failed"]);
const LOCKED_BATCH_STATUSES = new Set(["creating", "created", "cancelled"]);

function numeric(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function nonnegative(value, label) {
  const parsed = numeric(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw badRequest(`${label} must be zero or greater.`);
  }
  return parsed;
}

function positive(value) {
  const parsed = numeric(value);
  return Number.isFinite(parsed) && parsed > EPSILON ? parsed : 0;
}

function text(value) {
  return String(value ?? "").trim();
}

function roundQuantity(value) {
  return Number(Number(value || 0).toFixed(6));
}

function appError(message, status = 400, code = "") {
  return Object.assign(new Error(message), {
    status,
    ...(code ? { code } : {})
  });
}

function badRequest(message) {
  return appError(message, 400, "TRANSFER_DEPENDENCY_MANUAL_ITEM_INVALID");
}

function conflict(message) {
  return appError(message, 409, "TRANSFER_DEPENDENCY_MANUAL_ITEM_CONFLICT");
}

function notFound(message) {
  return appError(message, 404, "TRANSFER_DEPENDENCY_MANUAL_ITEM_NOT_FOUND");
}

function validId(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw badRequest(`${label} is invalid.`);
  return parsed;
}

function conversionsFor(row = {}) {
  return {
    pallets: positive(row.to_plt ?? row.toPlt),
    layers: positive(row.to_lyr ?? row.toLyr),
    sections: positive(row.to_sec ?? row.toSec),
    pieces: positive(row.to_pcs ?? row.toPcs)
  };
}

function isPalletItem(row = {}) {
  return [row.item_name, row.itemName, row.display_name, row.displayName]
    .some((value) => text(value).toUpperCase() === "PALLET");
}

function itemResult(row = {}) {
  const conversions = conversionsFor(row);
  const quantityAvailable = positive(row.quantity_available);
  const reservedQuantity = positive(row.reserved_quantity);
  const effectiveAvailable = Math.max(0, roundQuantity(
    row.effective_available ?? quantityAvailable - reservedQuantity
  ));
  return {
    itemId: Number(row.item_id),
    itemName: row.item_name,
    displayName: row.display_name,
    itemDescription: row.item_description,
    itemType: row.item_type,
    itemTypeText: row.item_type_text,
    unit: row.stock_unit || "UOM",
    conversions,
    quantityOnHand: positive(row.quantity_on_hand),
    quantityAvailable,
    reservedQuantity,
    effectiveAvailable,
    inventorySyncedAt: row.balance_synced_at || null
  };
}

async function dependencyProposalHeader(batchId, proposalId, { lock = false } = {}) {
  const result = await query(
    `SELECT batch.id AS batch_id,
            batch.sales_order_id,
            batch.sales_order_ref,
            batch.status AS batch_status,
            proposal.id AS proposal_id,
            proposal.creation_status,
            proposal.from_location_id,
            proposal.from_location,
            proposal.to_location_id,
            proposal.to_location,
            proposal.pallet_transfer_qty,
            proposal.pallet_qty_overridden
       FROM scm_transfer_dependency_batches batch
       JOIN scm_transfer_dependency_proposals proposal ON proposal.batch_id = batch.id
      WHERE batch.id = $1 AND proposal.id = $2
      ${lock ? "FOR UPDATE OF batch, proposal" : ""}`,
    [validId(batchId, "Dependency batch"), validId(proposalId, "Transfer proposal")]
  );
  if (!result.rowCount) throw notFound("Transfer proposal was not found in this dependency batch.");
  const header = result.rows[0];
  if (LOCKED_BATCH_STATUSES.has(String(header.batch_status))) {
    throw conflict("This dependency batch can no longer accept manual items.");
  }
  if (!EDITABLE_PROPOSAL_STATUSES.has(String(header.creation_status))) {
    throw conflict("This transfer proposal can no longer be edited.");
  }
  return header;
}

function normalizedSelectedQuantities(input = {}, item = {}) {
  const source = input.quantities && typeof input.quantities === "object"
    ? input.quantities
    : {
      pallets: input.palletQty,
      layers: input.layerQty,
      sections: input.sectionQty,
      pieces: input.pieceQty,
      salesQty: input.salesQty
    };
  const selected = {
    pallets: nonnegative(source.pallets, "PLT quantity"),
    layers: nonnegative(source.layers, "LYR quantity"),
    sections: nonnegative(source.sections, "SEC quantity"),
    pieces: nonnegative(source.pieces, "PCS quantity"),
    salesQty: nonnegative(source.salesQty, "Sales-unit quantity")
  };
  if (Math.abs(selected.layers - Math.round(selected.layers)) > EPSILON) {
    throw badRequest("LYR quantity must be a whole number.");
  }
  selected.layers = Math.round(selected.layers);
  const conversions = conversionsFor(item);
  for (const [field, label] of [
    ["pallets", "PLT"],
    ["layers", "LYR"],
    ["sections", "SEC"],
    ["pieces", "PCS"]
  ]) {
    if (selected[field] > EPSILON && conversions[field] <= EPSILON) {
      throw badRequest(`${item.item_name || item.itemName} has no ${label} conversion.`);
    }
  }
  const convertedQuantity = ["pallets", "layers", "sections", "pieces"]
    .reduce((total, field) => total + (selected[field] * conversions[field]), 0);
  if (convertedQuantity > EPSILON && selected.salesQty > EPSILON) {
    throw badRequest("Use PLT/LYR/SEC/PCS quantities or a sales-unit quantity, not both.");
  }
  let proposedQuantity = convertedQuantity > EPSILON ? convertedQuantity : selected.salesQty;
  if (proposedQuantity <= EPSILON && input.proposedQuantity !== undefined) {
    proposedQuantity = nonnegative(input.proposedQuantity, "Transfer quantity");
    selected.salesQty = proposedQuantity;
  }
  proposedQuantity = roundQuantity(proposedQuantity);
  if (proposedQuantity <= EPSILON) throw badRequest("Enter a transfer quantity above zero.");
  return {
    proposedQuantity,
    palletQty: roundQuantity(selected.pallets),
    layerQty: roundQuantity(selected.layers),
    sectionQty: roundQuantity(selected.sections),
    pieceQty: roundQuantity(selected.pieces),
    conversions
  };
}

function proposalPalletCalculation(lines = []) {
  const materialByItem = new Map();
  let explicitQuantity = 0;
  for (const line of lines) {
    const quantity = positive(line.proposed_quantity);
    if (quantity <= EPSILON) continue;
    if (isPalletItem(line)) {
      explicitQuantity += quantity;
      continue;
    }
    const itemId = String(line.item_id);
    const current = materialByItem.get(itemId) || {
      quantity: 0,
      toPlt: positive(line.to_plt)
    };
    current.quantity += quantity;
    if (!current.toPlt) current.toPlt = positive(line.to_plt);
    materialByItem.set(itemId, current);
  }
  let calculatedQuantity = 0;
  let complete = true;
  for (const material of materialByItem.values()) {
    if (material.toPlt <= EPSILON) {
      complete = false;
      continue;
    }
    calculatedQuantity += Math.ceil(Math.max(0, material.quantity - EPSILON) / material.toPlt);
  }
  calculatedQuantity = roundQuantity(calculatedQuantity);
  explicitQuantity = roundQuantity(explicitQuantity);
  return {
    calculatedQuantity,
    explicitQuantity,
    complete,
    recommendedQuantity: Math.max(calculatedQuantity, explicitQuantity)
  };
}

async function recalculateProposalPallets(proposalId) {
  const lines = await query(
    `SELECT proposal_line.*,
            COALESCE(proposal_line.to_plt, sales_line.to_plt, item.to_plt, 0) AS to_plt
       FROM scm_transfer_dependency_proposal_lines proposal_line
       LEFT JOIN sales_order_lines sales_line ON sales_line.id = proposal_line.sales_line_id
       LEFT JOIN inventory_items item ON item.item_id = proposal_line.item_id
      WHERE proposal_line.proposal_id = $1
      ORDER BY proposal_line.id`,
    [Number(proposalId)]
  );
  const calculation = proposalPalletCalculation(lines.rows);
  const updated = await query(
    `UPDATE scm_transfer_dependency_proposals
        SET calculated_pallet_qty = $2,
            pallet_transfer_qty = CASE
              WHEN pallet_qty_overridden THEN pallet_transfer_qty
              ELSE $3
            END,
            pallet_calculation_complete = $4,
            updated_at = now()
      WHERE id = $1
      RETURNING pallet_transfer_qty, pallet_qty_overridden`,
    [Number(proposalId), calculation.calculatedQuantity, calculation.recommendedQuantity, calculation.complete]
  );
  return {
    ...calculation,
    finalQuantity: positive(updated.rows[0]?.pallet_transfer_qty),
    overridden: updated.rows[0]?.pallet_qty_overridden === true
  };
}

async function sourceItemRow(header, itemId, { excludeCurrentProposal = true } = {}) {
  const result = await query(
    `WITH dependency_reserved AS (
       SELECT COALESCE(SUM(line.allocated_quantity), 0) AS quantity
        FROM order_dependency_lines line
         JOIN order_dependencies dependency ON dependency.id = line.dependency_id
        WHERE dependency.status <> 'cancelled'
          AND dependency.source_location_id = $1
          AND line.item_id = $2
     ), proposal_reserved AS (
       SELECT COALESCE(SUM(line.proposed_quantity), 0) AS quantity
         FROM scm_transfer_dependency_proposal_lines line
         JOIN scm_transfer_dependency_proposals proposal ON proposal.id = line.proposal_id
        WHERE proposal.creation_status IN ('draft', 'creating')
          AND proposal.from_location_id = $1
          AND line.item_id = $2
          AND (NOT $3::boolean OR proposal.id <> $4)
     )
     SELECT item.*,
            balance.quantity_on_hand,
            balance.quantity_available,
            balance.synced_at AS balance_synced_at,
            dependency_reserved.quantity + proposal_reserved.quantity AS reserved_quantity,
            GREATEST(
              COALESCE(balance.quantity_available, 0)
              - dependency_reserved.quantity
              - proposal_reserved.quantity,
              0
            ) AS effective_available
       FROM inventory_items item
       JOIN inventory_balances balance
         ON balance.item_id = item.item_id AND balance.location_id = $1
       CROSS JOIN dependency_reserved
       CROSS JOIN proposal_reserved
      WHERE item.item_id = $2
        AND UPPER(COALESCE(NULLIF(item.raw ->> 'isinactive', ''), 'F')) <> 'T'`,
    [
      Number(header.from_location_id),
      Number(itemId),
      Boolean(excludeCurrentProposal),
      Number(header.proposal_id)
    ]
  );
  return result.rows[0] || null;
}

export async function searchTransferDependencyProposalItems(
  batchId,
  proposalId,
  { search = "", limit = 12 } = {}
) {
  const header = await dependencyProposalHeader(batchId, proposalId);
  const term = text(search);
  if (!term) return [];
  const cleanLimit = Math.min(30, Math.max(1, Number(limit) || 12));
  const match = `%${term}%`;
  const result = await query(
    `WITH dependency_reserved AS (
       SELECT line.item_id, SUM(line.allocated_quantity) AS quantity
         FROM order_dependency_lines line
         JOIN order_dependencies dependency ON dependency.id = line.dependency_id
        WHERE dependency.status <> 'cancelled'
          AND dependency.source_location_id = $1
        GROUP BY line.item_id
     ), proposal_reserved AS (
       SELECT line.item_id, SUM(line.proposed_quantity) AS quantity
         FROM scm_transfer_dependency_proposal_lines line
         JOIN scm_transfer_dependency_proposals proposal ON proposal.id = line.proposal_id
        WHERE proposal.creation_status IN ('draft', 'creating')
          AND proposal.from_location_id = $1
          AND proposal.id <> $2
        GROUP BY line.item_id
     )
     SELECT item.*,
            balance.quantity_on_hand,
            balance.quantity_available,
            balance.synced_at AS balance_synced_at,
            COALESCE(dependency_reserved.quantity, 0)
              + COALESCE(proposal_reserved.quantity, 0) AS reserved_quantity,
            GREATEST(
              COALESCE(balance.quantity_available, 0)
              - COALESCE(dependency_reserved.quantity, 0)
              - COALESCE(proposal_reserved.quantity, 0),
              0
            ) AS effective_available
       FROM inventory_items item
       JOIN inventory_balances balance
         ON balance.item_id = item.item_id AND balance.location_id = $1
       LEFT JOIN dependency_reserved ON dependency_reserved.item_id = item.item_id
       LEFT JOIN proposal_reserved ON proposal_reserved.item_id = item.item_id
      WHERE UPPER(COALESCE(NULLIF(item.raw ->> 'isinactive', ''), 'F')) <> 'T'
        AND UPPER(COALESCE(item.item_name, '')) <> 'PALLET'
        AND UPPER(COALESCE(item.display_name, '')) <> 'PALLET'
        AND NOT EXISTS (
          SELECT 1
            FROM scm_transfer_dependency_proposal_lines existing
           WHERE existing.proposal_id = $2 AND existing.item_id = item.item_id
        )
        AND (
          item.item_id::text ILIKE $3
          OR item.item_name ILIKE $3
          OR COALESCE(item.display_name, '') ILIKE $3
          OR COALESCE(item.item_description, '') ILIKE $3
        )
      ORDER BY CASE
                 WHEN item.item_id::text = $4 THEN 0
                 WHEN LOWER(item.item_name) = LOWER($4) THEN 1
                 ELSE 2
               END,
               CASE WHEN GREATEST(
                 COALESCE(balance.quantity_available, 0)
                 - COALESCE(dependency_reserved.quantity, 0)
                 - COALESCE(proposal_reserved.quantity, 0),
                 0
               ) > 0 THEN 0 ELSE 1 END,
               item.item_name,
               item.item_id
      LIMIT $5`,
    [Number(header.from_location_id), Number(header.proposal_id), match, term, cleanLimit]
  );
  return result.rows.map(itemResult);
}

export async function addTransferDependencyProposalLine(
  batchId,
  proposalId,
  input = {},
  operatorId = null
) {
  const itemId = validId(input.itemId, "NetSuite item");
  return withTransaction(async () => {
    const header = await dependencyProposalHeader(batchId, proposalId, { lock: true });
    const duplicate = await query(
      `SELECT id, item_name
         FROM scm_transfer_dependency_proposal_lines
        WHERE proposal_id = $1 AND item_id = $2
        LIMIT 1`,
      [Number(header.proposal_id), itemId]
    );
    if (duplicate.rowCount) {
      throw conflict(`${duplicate.rows[0].item_name || `Item ${itemId}`} is already in this transfer proposal.`);
    }
    const item = await sourceItemRow(header, itemId);
    if (!item) {
      throw conflict("The selected NetSuite item has no inventory balance at this proposal's source yard.");
    }
    if (isPalletItem(item)) {
      throw conflict("PALLET is managed by the proposal's Final PALLET quantity and cannot be added as a manual item.");
    }
    const selected = normalizedSelectedQuantities(input, item);
    const effectiveAvailable = positive(item.effective_available);
    if (selected.proposedQuantity > effectiveAvailable + EPSILON) {
      throw conflict(
        `${item.item_name || itemId} has ${roundQuantity(effectiveAvailable)} available at ${header.from_location}, below the requested ${selected.proposedQuantity}.`
      );
    }
    const inserted = await query(
      `INSERT INTO scm_transfer_dependency_proposal_lines (
         proposal_id, sales_line_id, item_id, item_name, unit, proposed_quantity,
         pallet_qty, layer_qty, section_qty, piece_qty, line_source,
         to_plt, to_lyr, to_sec, to_pcs
       ) VALUES ($1, null, $2, $3, $4, $5, $6, $7, $8, $9, 'manual', $10, $11, $12, $13)
       RETURNING *`,
      [
        Number(header.proposal_id),
        itemId,
        item.item_name || item.display_name || String(itemId),
        item.stock_unit || "UOM",
        selected.proposedQuantity,
        selected.palletQty,
        selected.layerQty,
        selected.sectionQty,
        selected.pieceQty,
        selected.conversions.pallets,
        selected.conversions.layers,
        selected.conversions.sections,
        selected.conversions.pieces
      ]
    );
    const pallet = await recalculateProposalPallets(header.proposal_id);
    await query(
      `UPDATE scm_transfer_dependency_batches
          SET updated_by = $2, updated_at = now()
        WHERE id = $1`,
      [Number(header.batch_id), operatorId]
    );
    await writeDispatchAudit({
      action: "scm.transfer_dependency.manual_item_added",
      source: "scm",
      entityType: "dependency_proposal",
      entityId: String(header.proposal_id),
      orderId: header.sales_order_ref,
      operatorId,
      details: {
        batchId: Number(header.batch_id),
        proposalId: Number(header.proposal_id),
        proposalLineId: Number(inserted.rows[0].id),
        itemId,
        itemName: inserted.rows[0].item_name,
        proposedQuantity: selected.proposedQuantity,
        unit: inserted.rows[0].unit,
        quantities: {
          pallets: selected.palletQty,
          layers: selected.layerQty,
          sections: selected.sectionQty,
          pieces: selected.pieceQty
        },
        sourceLocationId: Number(header.from_location_id),
        sourceLocation: header.from_location,
        effectiveAvailableBefore: roundQuantity(effectiveAvailable),
        effectiveAvailableAfter: roundQuantity(effectiveAvailable - selected.proposedQuantity)
      }
    });
    return {
      batchId: Number(header.batch_id),
      proposalId: Number(header.proposal_id),
      proposalLineId: Number(inserted.rows[0].id),
      line: {
        id: Number(inserted.rows[0].id),
        salesLineId: null,
        lineSource: "manual",
        itemId,
        itemName: inserted.rows[0].item_name,
        unit: inserted.rows[0].unit,
        proposedQuantity: selected.proposedQuantity,
        palletQty: selected.palletQty,
        layerQty: selected.layerQty,
        sectionQty: selected.sectionQty,
        pieceQty: selected.pieceQty,
        conversions: selected.conversions
      },
      pallet,
      sourceAvailability: {
        locationId: Number(header.from_location_id),
        location: header.from_location,
        before: roundQuantity(effectiveAvailable),
        after: roundQuantity(effectiveAvailable - selected.proposedQuantity)
      }
    };
  });
}

export const transferDependencyManualItemContract = Object.freeze({
  lineSource: "manual",
  dependencyLineRole: "manual_transfer",
  editableProposalStatuses: [...EDITABLE_PROPOSAL_STATUSES],
  lockedBatchStatuses: [...LOCKED_BATCH_STATUSES]
});
