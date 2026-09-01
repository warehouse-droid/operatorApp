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

const EPSILON = 0.000001;
const URGENCY_RANK = new Map([
  ["normal", 0],
  ["urgent", 1],
  ["super_urgent", 2],
  ["ultimate_urgent", 3]
]);

function value(row, camel, snake) {
  return row?.[camel] ?? row?.[snake];
}

function urgencyRank(state = {}) {
  const supplied = String(state.urgencyLevel ?? state.urgency_level ?? "").trim().toLowerCase();
  if (URGENCY_RANK.has(supplied)) {
    return supplied === "normal" && state.urgent === true ? 1 : URGENCY_RANK.get(supplied);
  }
  return state.urgent === true ? 1 : 0;
}

export function smartScmBlanketDemandCompare(left = {}, right = {}) {
  const urgency = urgencyRank(right) - urgencyRank(left);
  if (urgency) return urgency;
  const score = positive(right.urgencyScore ?? right.urgency_score)
    - positive(left.urgencyScore ?? left.urgency_score);
  if (Math.abs(score) > EPSILON) return score;
  return number(left?.policy?.location_id, Number.MAX_SAFE_INTEGER)
    - number(right?.policy?.location_id, Number.MAX_SAFE_INTEGER);
}

function sourceDate(row = {}) {
  const timestamp = Date.parse(String(value(row, "transactionDate", "trandate") || ""));
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
}

function comparePoolRows(left, right) {
  const dateDifference = sourceDate(left.row) - sourceDate(right.row);
  if (Number.isFinite(dateDifference) && dateDifference) return dateDifference;
  const poDifference = number(value(left.row, "sourcePoId", "source_po_id"), Number.MAX_SAFE_INTEGER)
    - number(value(right.row, "sourcePoId", "source_po_id"), Number.MAX_SAFE_INTEGER);
  if (poDifference) return poDifference;
  const lineDifference = number(value(left.row, "sourceLineId", "source_line_id"), Number.MAX_SAFE_INTEGER)
    - number(value(right.row, "sourceLineId", "source_line_id"), Number.MAX_SAFE_INTEGER);
  return lineDifference || left.index - right.index;
}

function stateKey(state = {}) {
  return state.key || `${Number(state.policy?.item_id)}:${Number(state.policy?.location_id)}`;
}

function coverageRow(state = {}) {
  return {
    key: stateKey(state),
    itemId: Number(state.policy?.item_id),
    locationId: Number(state.policy?.location_id),
    yard: state.policy?.yard_code || "",
    requiredPallets: round(positive(state.requiredPallets)),
    coveredPallets: round(positive(state.blanketCoveragePallets)),
    residualPallets: round(positive(state.residualRequiredPallets)),
    sourcePoRefs: Array.isArray(state.blanketSourcePoRefs) ? [...state.blanketSourcePoRefs] : []
  };
}

export function smartScmBlanketCoverageSnapshot(states = []) {
  const blanketCoverage = (Array.isArray(states) ? states : [])
    .map(coverageRow)
    .filter((row) => row.requiredPallets > EPSILON || row.coveredPallets > EPSILON);
  return {
    blanketCoverage,
    blanketCoveredLines: blanketCoverage.filter((row) => row.coveredPallets > EPSILON).length,
    blanketCoveredPallets: round(blanketCoverage
      .reduce((sum, row) => sum + positive(row.coveredPallets), 0)),
    residualRequiredPallets: round(blanketCoverage
      .reduce((sum, row) => sum + positive(row.residualPallets), 0))
  };
}

export function smartScmAllocateBlanketCoverage({ states = [], poolRows = [] } = {}) {
  const coveredStates = (Array.isArray(states) ? states : []).map((state) => ({
    ...state,
    blanketCoveragePallets: 0,
    residualRequiredPallets: round(positive(state?.requiredPallets)),
    blanketSourcePoRefs: [],
    blanketCoverageAllocations: []
  }));
  const mutablePool = (Array.isArray(poolRows) ? poolRows : [])
    .map((row, index) => ({
      row,
      index,
      remainingPallets: Math.floor(positive(value(row, "remainingPallets", "remaining_pallets")))
    }))
    .filter((source) => source.remainingPallets >= 1)
    .sort(comparePoolRows);
  const allocations = [];

  for (const state of [...coveredStates].sort(smartScmBlanketDemandCompare)) {
    if (state.policy?.temporarily_excluded === true) continue;
    let needed = Math.floor(positive(state.requiredPallets));
    if (needed < 1) continue;
    const itemId = Number(state.policy?.item_id);
    const locationId = Number(state.policy?.location_id);
    const toPlt = positive(state.toPlt ?? state.policy?.to_plt);
    if (!Number.isFinite(itemId) || !Number.isFinite(locationId) || toPlt <= EPSILON) continue;

    for (const source of mutablePool) {
      if (needed < 1) break;
      if (source.remainingPallets < 1
        || Number(value(source.row, "itemId", "item_id")) !== itemId
        || Math.abs(positive(value(source.row, "toPlt", "to_plt")) - toPlt) > EPSILON) continue;
      const pallets = Math.min(needed, source.remainingPallets);
      const sourcePoRef = String(value(source.row, "sourcePoRef", "source_po_ref") || "").trim();
      const allocation = {
        key: stateKey(state),
        itemId,
        locationId,
        yard: state.policy?.yard_code || "",
        sourcePoId: Number(value(source.row, "sourcePoId", "source_po_id")),
        sourcePoRef,
        sourceLineId: Number(value(source.row, "sourceLineId", "source_line_id")),
        toPlt,
        pallets,
        salesQuantity: round(pallets * toPlt),
        sourceRemainingBeforePallets: source.remainingPallets,
        source: source.row
      };
      allocations.push(allocation);
      state.blanketCoverageAllocations.push(allocation);
      if (sourcePoRef && !state.blanketSourcePoRefs.includes(sourcePoRef)) {
        state.blanketSourcePoRefs.push(sourcePoRef);
      }
      state.blanketCoveragePallets = round(state.blanketCoveragePallets + pallets);
      source.remainingPallets -= pallets;
      needed -= pallets;
    }
    state.residualRequiredPallets = round(
      Math.max(0, positive(state.requiredPallets) - positive(state.blanketCoveragePallets))
    );
  }

  return {
    states: coveredStates,
    allocations,
    coverage: smartScmBlanketCoverageSnapshot(coveredStates).blanketCoverage
  };
}
