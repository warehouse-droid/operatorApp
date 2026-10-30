// @ts-check

/**
 * @typedef {Object} RequestedPoLine
 * @property {unknown} [proposal_id]
 * @property {unknown} [line_id]
 * @property {unknown} [proposal_type]
 * @property {unknown} [proposal_origin]
 * @property {unknown} [status]
 * @property {unknown} [order_requested_at]
 * @property {unknown} [netsuite_purchase_order_id]
 * @property {unknown} [netsuite_purchase_order_ref]
 * @property {unknown} [vendor_resolution_kind]
 * @property {unknown} [vendor_decision]
 * @property {unknown} [item_id]
 * @property {unknown} [destination_location_id]
 * @property {unknown} [proposed_pallets]
 * @property {unknown} [confirmed_pallets]
 */

const PENDING_STATUSES = new Set(["order_requested", "vendor_replied", "confirmed", "executing", "attention"]);

/** @param {unknown} value */
function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0;
}

/** @param {number} value */
function round(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

/** @param {RequestedPoLine} row */
function requestedLineEligible(row) {
  if (row.proposal_type !== "PO" || row.proposal_origin !== "inventory" || !row.order_requested_at) {
    return false;
  }
  // Real PO quantities are already in inventory/split inbound. Blanket
  // reservations also have their own coverage path.
  return PENDING_STATUSES.has(String(row.status))
    && (row.netsuite_purchase_order_id === null || row.netsuite_purchase_order_id === undefined)
    && !String(row.netsuite_purchase_order_ref ?? "").trim()
    && row.vendor_decision !== "cancel";
}

/** @param {RequestedPoLine} row */
function requestedLineEvidence(row) {
  const ids = [row.proposal_id, row.line_id, row.item_id, row.destination_location_id];
  const quantity = Number(row.vendor_resolution_kind === "netsuite_po_review"
    ? row.confirmed_pallets : row.proposed_pallets);
  if (!requestedLineEligible(row) || !ids.every(validId) || !Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }
  return {
    proposalId: Number(row.proposal_id), lineId: Number(row.line_id), itemId: Number(row.item_id),
    locationId: Number(row.destination_location_id), requestedPallets: round(quantity),
    orderRequestedAt: row.order_requested_at
  };
}

/**
 * Pending requests cover demand without turning proposed purchases into
 * physical source stock or changing the frozen inventory/policy calculation.
 * @template {{key: string, requiredPallets: number, residualRequiredPallets?: number}} State
 * @param {State[]} states
 * @param {RequestedPoLine[]} lines
 */
export function smartScmRequestedPoHandoff(states, lines) {
  /** @type {Map<string, number>} */
  const coverage = new Map();
  const requestedPoLines = [];
  const seenLines = new Set();
  for (const row of lines) {
    const evidence = requestedLineEvidence(row);
    if (!evidence || seenLines.has(evidence.lineId)) {
      continue;
    }
    seenLines.add(evidence.lineId);
    requestedPoLines.push(evidence);
    const key = `${evidence.itemId}:${evidence.locationId}`;
    coverage.set(key, round((coverage.get(key) ?? 0) + evidence.requestedPallets));
  }
  return {
    requestedPoLines,
    states: states.map((state) => {
      const requested = coverage.get(state.key) ?? 0;
      return {
        ...state,
        requiredBeforeRequestedPoPallets: state.requiredPallets,
        requestedPoCoveragePallets: requested,
        requiredPallets: round(Math.max(0, state.requiredPallets - requested)),
        residualRequiredPallets: round(Math.max(0,
          (state.residualRequiredPallets ?? state.requiredPallets) - requested))
      };
    })
  };
}
