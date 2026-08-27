export const SCM_SCHEDULE_STATUS_REFRESH_BATCH_SIZE = 10;
export const SCM_SCHEDULE_STATUS_REFRESH_CANDIDATE_LIMIT = 30;
export const SCM_SCHEDULE_STATUS_REFRESH_STALE_AFTER_MS = 6 * 60 * 60 * 1000;
export const SCM_SCHEDULE_STATUS_REFRESH_RECENT_ATTEMPT_MS = 60 * 60 * 1000;
export const SCM_SCHEDULE_STATUS_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

function requiredFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`SCM schedule status refresh dependency ${name} is required.`);
  }
  return value;
}

function normalizedCandidate(row = {}) {
  const candidate = row && typeof row === "object" ? row : {};
  const orderKind = String(candidate.orderKind || candidate.order_kind || "").trim().toUpperCase();
  const orderRef = String(candidate.orderRef || candidate.order_ref || "").trim();
  if (!["PO", "TO"].includes(orderKind) || !orderRef) return null;
  return { orderKind, orderRef };
}

export function selectBoundedScmScheduleStatusRefreshBatch(rows = [], {
  limit = SCM_SCHEDULE_STATUS_REFRESH_BATCH_SIZE
} = {}) {
  const boundedLimit = Math.max(1, Math.min(
    SCM_SCHEDULE_STATUS_REFRESH_BATCH_SIZE,
    Number(limit) || SCM_SCHEDULE_STATUS_REFRESH_BATCH_SIZE
  ));
  const unique = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const candidate = normalizedCandidate(row);
    if (!candidate) continue;
    const key = `${candidate.orderKind}:${candidate.orderRef.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  if (!unique.length) return [];
  const selectedKind = unique[0].orderKind;
  return unique
    .filter((candidate) => candidate.orderKind === selectedKind)
    .slice(0, boundedLimit);
}

export function createScmScheduleStatusRefresh(dependencies = {}) {
  const getSettings = requiredFunction(dependencies.getSettings, "getSettings");
  const hasActiveReconciliation = requiredFunction(
    dependencies.hasActiveReconciliation,
    "hasActiveReconciliation"
  );
  const listCandidates = requiredFunction(dependencies.listCandidates, "listCandidates");
  const startRun = requiredFunction(dependencies.startRun, "startRun");
  const operationalSyncRunning = typeof dependencies.operationalSyncRunning === "function"
    ? dependencies.operationalSyncRunning
    : () => false;
  let running = false;

  async function runOnce({ now = new Date() } = {}) {
    if (running) return { started: false, reason: "tick_in_progress" };
    running = true;
    try {
      const settings = await getSettings();
      if (!settings?.initialDryRunApprovedAt) {
        return { started: false, reason: "initial_dry_run_not_approved" };
      }
      if (await operationalSyncRunning()) {
        return { started: false, reason: "operational_sync_running" };
      }
      if (await hasActiveReconciliation()) {
        return { started: false, reason: "reconciliation_active" };
      }
      const candidates = await listCandidates({
        now,
        limit: SCM_SCHEDULE_STATUS_REFRESH_CANDIDATE_LIMIT,
        staleAfterMs: SCM_SCHEDULE_STATUS_REFRESH_STALE_AFTER_MS,
        recentAttemptMs: SCM_SCHEDULE_STATUS_REFRESH_RECENT_ATTEMPT_MS
      });
      const batch = selectBoundedScmScheduleStatusRefreshBatch(candidates);
      if (!batch.length) return { started: false, reason: "no_stale_scheduled_orders" };
      const orderKind = batch[0].orderKind;
      const orderRefs = batch.map((candidate) => candidate.orderRef);
      const run = await startRun({
        triggerSource: "backfill",
        scope: "order_family",
        targetOrderKind: orderKind,
        targetOrderRefs: orderRefs,
        includeTerminalOrders: true,
        dryRun: false,
        applyUnambiguous: true,
        requestedBy: "scheduled-stale-scm-status-refresh"
      }, {
        background: true,
        operationalSyncRunning
      });
      return {
        started: true,
        runId: Number(run?.id || 0) || null,
        orderKind,
        orderRefs
      };
    } finally {
      running = false;
    }
  }

  return { runOnce };
}
