// These notes and markers are emitted by the retained Dispatch regression
// fixtures, which seed both valid and intentionally invalid boards directly.
function syntheticCoOrders(orders) {
  return orders.every(order => order.testOnly === true
    || /^(?:CO-)?(?:SOA|GOA)-GLOBAL-[A-F0-9]{8}-/u.test(String(order.id)));
}

function syntheticCoLifecycle(header,orders,date) {
  return header.note === "global CO lifecycle regression" && date >= "2200-01-01" && syntheticCoOrders(orders);
}

export function historicalReplayInScope(header) {
  const date = String(header.date_text || header.planDate || "");
  return date >= "2026-08-01" && date <= "2026-09-30";
}

export function historicalReplayDraftReason(state) {
  if (state.archive_reason === "save_recovery" && state.checkpoint_kind === "recovery"
    && state.summary?.saveRecovery?.applied === false) { return "Rejected unapplied recovery draft"; }
  return null;
}

export function historicalReplayFixtureReason(header,state) {
  const date = String(header.date_text || header.planDate || "");
  const orders = state.orders || [];
  if (header.note === "isolated dispatch v2 fixture" && date >= "2030-01-01"
    && state.summary?.testOnly === true) { return "Dispatch V2 synthetic regression fixture"; }
  if (header.note === "dependency fence digest regression" && date >= "2200-01-01"
    && orders.length === 0) { return "Synthetic empty dependency-fence fixture"; }
  if (syntheticCoLifecycle(header,orders,date)) {
    return "Synthetic global CO lifecycle fixture";
  }
  return null;
}
