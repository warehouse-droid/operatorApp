const ORDER_DEFINITIONS = Object.freeze([
  { orderType: "sales_order", summaryKey: "salesOrders" },
  { orderType: "purchase_order", summaryKey: "purchaseOrders" },
  { orderType: "transfer_order", summaryKey: "transferOrders" }
]);
const SUPPORTED_ORDER_TYPES = new Set(ORDER_DEFINITIONS.map(({ orderType }) => orderType));

function statusCode(row = {}) {
  return String(row.status ?? "").trim().toUpperCase();
}

function statusText(row = {}) {
  return String(row.statusText ?? row.status_text ?? "").trim();
}

export function isPendingApprovalStatus(row = {}) {
  const text = statusText(row)
    .replace(/^(?:sales|purchase|transfer)\s+order\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return statusCode(row) === "A" || /^pending(?: supervisor)? approval$/i.test(text);
}

export function isOrderOpenAfterApproval(orderType, row = {}) {
  if (!SUPPORTED_ORDER_TYPES.has(orderType)) {return false;}
  const code = statusCode(row);
  const text = statusText(row);
  if (code === "B") {return true;}
  if (orderType === "purchase_order") {return /pending receipt|partially received/i.test(text);}
  if (orderType === "sales_order" || orderType === "transfer_order") {
    return /pending fulfillment|partially fulfilled/i.test(text);
  }
  return false;
}

function emptyFamilySummary() {
  return {
    claimed: 0,
    found: 0,
    updated: 0,
    transitioned: 0,
    unchanged: 0,
    missing: 0,
    concurrentSkipped: 0,
    failed: 0,
    distribution: {}
  };
}

function emptyTotalsSummary() {
  const { distribution: _distribution, ...totals } = emptyFamilySummary();
  return totals;
}

function remoteStatusLabel(row) {
  return `${statusCode(row)} | ${statusText(row)}`;
}

function comparableStatusText(row) {
  return statusText(row)
    .replace(/^(?:sales|purchase|transfer)\s+order\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function changedStatus(before, after) {
  return statusCode(before) !== statusCode(after)
    || comparableStatusText(before) !== comparableStatusText(after);
}

function pendingCandidates(listed, orderType) {
  const rows = listed?.[orderType];
  return Array.isArray(rows) ? rows.filter(isPendingApprovalStatus) : [];
}

function candidateNetSuiteId(candidate) {
  return Number(candidate.netsuiteId ?? candidate.netsuite_id);
}

async function applyRemoteStatus({
  definition,
  candidate,
  latestById,
  family,
  scope,
  applyIfStillPending,
  writeAudit
}) {
  const netsuiteId = candidateNetSuiteId(candidate);
  const latest = latestById.get(String(netsuiteId));
  if (!latest) {
    family.missing += 1;
    return;
  }

  family.found += 1;
  const label = remoteStatusLabel(latest);
  family.distribution[label] = (family.distribution[label] || 0) + 1;
  const change = {
    orderType: definition.orderType,
    netsuiteId,
    tranid: String(candidate.tranid || latest.tranid || "").trim(),
    status: statusCode(latest),
    statusText: statusText(latest),
    netsuiteActive: isOrderOpenAfterApproval(definition.orderType, latest),
    previousStatus: statusCode(candidate),
    previousStatusText: statusText(candidate)
  };
  const updated = await applyIfStillPending(change);
  if (!updated) {
    family.concurrentSkipped += 1;
    return;
  }

  family.updated += 1;
  if (!changedStatus(candidate, latest)) {
    family.unchanged += 1;
    return;
  }
  family.transitioned += 1;
  await writeAudit({
    actorType: "system",
    source: "netsuite",
    action: "netsuite.pending_approval_status_update",
    orderId: netsuiteId,
    details: {
      scope,
      orderType: definition.orderType,
      tranid: change.tranid,
      before: { status: change.previousStatus, statusText: change.previousStatusText },
      after: { status: change.status, statusText: change.statusText, netsuiteActive: change.netsuiteActive }
    }
  });
}

async function reconcileOrderFamily({
  definition,
  listed,
  summary,
  fetchStatuses,
  applyIfStillPending,
  writeAudit
}) {
  const family = summary[definition.summaryKey];
  const candidates = pendingCandidates(listed, definition.orderType);
  family.claimed = candidates.length;
  if (!candidates.length) {
    return;
  }

  let remoteRows;
  try {
    remoteRows = await fetchStatuses({
      orderType: definition.orderType,
      ids: candidates.map(candidateNetSuiteId)
    });
  } catch (error) {
    family.failed = candidates.length;
    summary.failures.push({
      orderType: definition.orderType,
      count: candidates.length,
      error: String(error?.message || error).slice(0, 500)
    });
    return;
  }

  const latestById = new Map((remoteRows || []).map((row) => [String(row.id ?? row.netsuiteId), row]));
  for (const candidate of candidates) {
    await applyRemoteStatus({
      definition,
      candidate,
      latestById,
      family,
      scope: summary.scope,
      applyIfStillPending,
      writeAudit
    });
  }
}

function calculateTotals(summary) {
  for (const key of Object.keys(summary.totals)) {
    summary.totals[key] = ORDER_DEFINITIONS.reduce(
      (total, definition) => total + Number(summary[definition.summaryKey][key] || 0),
      0
    );
  }
}

export async function reconcilePendingApprovalOrders({
  listCandidates,
  fetchStatuses,
  applyIfStillPending,
  writeAudit = async () => {}
} = {}) {
  if (typeof listCandidates !== "function") {
    throw new TypeError("A Pending Approval candidate reader is required.");
  }
  if (typeof fetchStatuses !== "function") {
    throw new TypeError("A NetSuite status reader is required.");
  }
  if (typeof applyIfStillPending !== "function") {
    throw new TypeError("A conditional Pending Approval updater is required.");
  }
  const listed = await listCandidates();
  const summary = {
    scope: "pending_approval_only",
    salesOrders: emptyFamilySummary(),
    purchaseOrders: emptyFamilySummary(),
    transferOrders: emptyFamilySummary(),
    totals: emptyTotalsSummary(),
    failures: []
  };

  for (const definition of ORDER_DEFINITIONS) {
    await reconcileOrderFamily({
      definition,
      listed,
      summary,
      fetchStatuses,
      applyIfStillPending,
      writeAudit
    });
  }

  calculateTotals(summary);
  await writeAudit({
    actorType: "system",
    source: "netsuite",
    action: "netsuite.pending_approval_status_reconcile",
    details: summary
  });
  return summary;
}
