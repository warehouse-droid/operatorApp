import {
  DELAYED_STATUS_REFRESH_BATCH_SIZE,
  DELAYED_STATUS_REFRESH_LEASE_MS,
  delayedStatusRefreshDecision,
  normalizeDelayedStatusRefreshIdentity
} from "./netsuite-delayed-status-refresh-policy.js";

function numericValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

export function summarizeSalesOrderAllocationRefresh(lines = []) {
  const summary = (Array.isArray(lines) ? lines : []).reduce((totals, line) => {
    const quantity = numericValue(line.quantity);
    const committed = numericValue(line.netsuite_committed_qty);
    const backordered = numericValue(line.netsuite_backordered_qty);
    const processed = numericValue(line.netsuite_received_qty);
    totals.backorderedQuantity += backordered;
    if (backordered > 0) {
      totals.backorderedLineCount += 1;
    }
    if (quantity > 0 && committed <= 0 && backordered <= 0 && processed <= 0) {
      totals.unsettledLineCount += 1;
    }
    return totals;
  }, {
    lineCount: Array.isArray(lines) ? lines.length : 0,
    backorderedLineCount: 0,
    backorderedQuantity: 0,
    unsettledLineCount: 0
  });
  summary.backorderedQuantity = Number(summary.backorderedQuantity.toFixed(6));
  return summary;
}

function statusText(row = {}) {
  return String(row?.statusText ?? row?.status_text ?? "").trim();
}

function statusCode(row = {}) {
  return String(row?.status ?? "").trim();
}

function errorMessage(error) {
  return String(error?.message || error || "Unknown delayed status refresh error.").slice(0, 8_000);
}

function failureMessage({ decision, operationError, allocationRefreshError }) {
  if (operationError) {
    return errorMessage(operationError);
  }
  if (allocationRefreshError) {
    return String(allocationRefreshError).slice(0, 8_000);
  }
  if (decision.reason === "missing_status") {
    return "No matching NetSuite transaction status was returned.";
  }
  if (decision.reason === "pending_approval") {
    return "NetSuite still reports Pending Approval.";
  }
  if (decision.reason === "sales_order_allocations_unsettled") {
    return "Sales order allocation lines remain unsettled.";
  }
  return "";
}

function auditAction({ remoteStatus, operationError }) {
  if (operationError) {
    return "netsuite.webhook.delayed_status_failed";
  }
  return remoteStatus
    ? "netsuite.webhook.delayed_status_refresh"
    : "netsuite.webhook.delayed_status_missing";
}

function normalizedJob(input = {}) {
  const identity = normalizeDelayedStatusRefreshIdentity(input);
  const jobId = Number(input.jobId);
  const attemptNumber = Number(input.attemptNumber);
  const leaseToken = String(input.leaseToken || "").trim();
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    throw new TypeError("Delayed status refresh job ID must be a positive integer.");
  }
  if (!Number.isInteger(attemptNumber) || attemptNumber <= 0) {
    throw new TypeError("Delayed status refresh attempt number must be a positive integer.");
  }
  if (!leaseToken) {
    throw new TypeError("Delayed status refresh lease token is required.");
  }
  const leaseMs = Number(input.leaseMs || DELAYED_STATUS_REFRESH_LEASE_MS);
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new TypeError("Delayed status refresh lease duration must be a positive integer.");
  }
  return { ...identity, jobId, attemptNumber, leaseToken, leaseMs };
}

function auditEntry({
  job,
  remoteStatus,
  updated,
  decision,
  allocationRefresh,
  allocationRefreshError,
  operationError
}) {
  return {
    actorType: "system",
    source: "netsuite-webhook",
    action: auditAction({ remoteStatus, operationError }),
    details: {
      jobId: job.jobId,
      attemptNumber: job.attemptNumber,
      refreshAttempt: job.attemptNumber,
      netsuiteOrderId: job.netsuiteOrderId,
      orderType: job.orderType,
      tranid: String(remoteStatus?.tranid || job.tranid || ""),
      status: statusCode(remoteStatus),
      statusText: statusText(remoteStatus),
      updated: Boolean(updated),
      outcome: decision.outcome,
      reason: decision.reason,
      allocationRefresh,
      allocationRefreshError,
      error: operationError ? errorMessage(operationError) : ""
    }
  };
}

function normalizedCommitState(input = {}) {
  return {
    job: input.job,
    remoteStatus: input.remoteStatus || null,
    lines: Array.isArray(input.lines) ? input.lines : [],
    allocationRefresh: input.allocationRefresh || null,
    allocationRefreshError: String(input.allocationRefreshError || ""),
    operationError: input.operationError || null
  };
}

function outcomeTiming({ decision, completedAt, operationError, allocationRefreshError }) {
  const nextAvailableAt = decision.retryDelayMs === null
    ? null
    : new Date(completedAt.getTime() + decision.retryDelayMs);
  const finishError = decision.outcome === "succeeded"
    ? ""
    : failureMessage({ decision, operationError, allocationRefreshError });
  return { nextAvailableAt, finishError };
}

function attemptDetails({ job, remoteStatus, updated, decision, allocationRefresh, allocationRefreshError }) {
  return {
    reason: decision.reason,
    remoteStatus: remoteStatus ? {
      tranid: String(remoteStatus.tranid || job.tranid || ""),
      status: statusCode(remoteStatus),
      statusText: statusText(remoteStatus)
    } : null,
    updated: Boolean(updated),
    allocationRefresh,
    allocationRefreshError
  };
}

function completedOutcome(decision, nextAvailableAt) {
  return {
    outcome: decision.outcome,
    reason: decision.reason,
    ...(nextAvailableAt ? { nextAvailableAt } : {})
  };
}

async function safeSupplementalAudit({ withTransaction, writeAudit, entry, logger }) {
  try {
    await withTransaction(() => writeAudit(entry));
  } catch (error) {
    logger.error("Delayed NetSuite status refresh audit failed:", errorMessage(error));
  }
}

function requiredFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`Delayed status refresh dependency ${name} is required.`);
  }
  return value;
}

export function createDelayedStatusRefreshWorker(dependencies = {}) {
  const claimJobs = requiredFunction(dependencies.claimJobs, "claimJobs");
  const lockLease = requiredFunction(dependencies.lockLease, "lockLease");
  const finishAttempt = requiredFunction(dependencies.finishAttempt, "finishAttempt");
  const renewLease = typeof dependencies.renewLease === "function"
    ? dependencies.renewLease
    : async () => true;
  const fetchTransactionStatus = requiredFunction(
    dependencies.fetchTransactionStatus,
    "fetchTransactionStatus"
  );
  const fetchSalesOrderLines = requiredFunction(
    dependencies.fetchSalesOrderLines,
    "fetchSalesOrderLines"
  );
  const applyStatus = requiredFunction(dependencies.applyStatus, "applyStatus");
  const applySalesOrderLines = requiredFunction(
    dependencies.applySalesOrderLines,
    "applySalesOrderLines"
  );
  const runInTransaction = requiredFunction(dependencies.withTransaction, "withTransaction");
  const writeAudit = requiredFunction(dependencies.writeAudit, "writeAudit");
  const emitEvents = requiredFunction(dependencies.emitEvents, "emitEvents");
  const now = typeof dependencies.now === "function" ? dependencies.now : () => new Date();
  const logger = dependencies.logger || console;
  const setIntervalFn = dependencies.setIntervalFn || setInterval;
  const clearIntervalFn = dependencies.clearIntervalFn || clearInterval;
  let running = false;

  function startLeaseHeartbeat(job) {
    let renewalRunning = false;
    const intervalMs = Math.max(1_000, Math.floor(job.leaseMs / 3));
    const timer = setIntervalFn(async () => {
      if (renewalRunning) {
        return;
      }
      renewalRunning = true;
      try {
        const renewed = await renewLease({
          jobId: job.jobId,
          leaseToken: job.leaseToken,
          leaseMs: job.leaseMs,
          now: now()
        });
        if (!renewed) {
          logger.error("Delayed NetSuite status refresh lease renewal was fenced.");
        }
      } catch (error) {
        logger.error("Delayed NetSuite status refresh lease renewal failed:", errorMessage(error));
      } finally {
        renewalRunning = false;
      }
    }, intervalMs);
    timer?.unref?.();
    return () => clearIntervalFn(timer);
  }

  async function fetchRemoteState(job) {
    const netSuiteTypes = {
      sales_order: "SalesOrd",
      purchase_order: "PurchOrd",
      transfer_order: "TrnfrOrd"
    };
    const remoteStatus = await fetchTransactionStatus({
      orderType: job.orderType,
      netsuiteOrderId: job.netsuiteOrderId,
      netsuiteType: netSuiteTypes[job.orderType]
    });
    let lines = [];
    let allocationRefresh = null;
    let allocationRefreshError = "";
    if (job.orderType === "sales_order") {
      try {
        lines = await fetchSalesOrderLines(job.netsuiteOrderId);
        allocationRefresh = summarizeSalesOrderAllocationRefresh(lines);
      } catch (error) {
        allocationRefreshError = errorMessage(error);
      }
    }
    return { remoteStatus, lines, allocationRefresh, allocationRefreshError };
  }

  async function applyRemoteState({ job, remoteStatus, lines }) {
    if (!remoteStatus) {
      return null;
    }
    const updated = await applyStatus({
      orderType: job.orderType,
      netsuiteOrderId: job.netsuiteOrderId,
      tranid: String(remoteStatus.tranid || job.tranid || ""),
      status: statusCode(remoteStatus),
      statusText: statusText(remoteStatus)
    });
    if (job.orderType === "sales_order" && lines.length > 0) {
      await applySalesOrderLines({ netsuiteOrderId: job.netsuiteOrderId, lines });
    }
    return updated;
  }

  function emitCommittedEvents({ job, remoteStatus, decision, operationError }) {
    if (operationError || (!remoteStatus && decision.reason !== "missing_status")) {
      return;
    }
    try {
      emitEvents({
        orderType: job.orderType,
        netsuiteOrderId: job.netsuiteOrderId,
        tranid: String(remoteStatus?.tranid || job.tranid || "")
      });
    } catch (error) {
      logger.error("Delayed NetSuite status refresh event emission failed:", errorMessage(error));
    }
  }

  async function commitOutcome(input) {
    const state = normalizedCommitState(input);
    const { job, remoteStatus, allocationRefresh, allocationRefreshError, operationError } = state;
    const decision = delayedStatusRefreshDecision({
      attemptNumber: job.attemptNumber,
      remoteStatus,
      error: operationError,
      allocationRefresh,
      allocationRefreshError
    });
    const completedAt = now();
    const { nextAvailableAt, finishError } = outcomeTiming({
      decision,
      completedAt,
      operationError,
      allocationRefreshError
    });
    let committed = false;
    let updated = null;
    await runInTransaction(async () => {
      const ownsLease = await lockLease({ jobId: job.jobId, leaseToken: job.leaseToken });
      if (!ownsLease) {
        return;
      }
      updated = await applyRemoteState(state);
      const details = attemptDetails({
        job,
        remoteStatus,
        updated,
        decision,
        allocationRefresh,
        allocationRefreshError
      });
      committed = await finishAttempt({
        jobId: job.jobId,
        leaseToken: job.leaseToken,
        outcome: decision.outcome,
        nextAvailableAt,
        finishedAt: completedAt,
        error: finishError,
        details
      });
      if (!committed) {
        throw new Error("Delayed status refresh lease was lost during finalization.");
      }
      await safeSupplementalAudit({
        withTransaction: runInTransaction,
        writeAudit,
        logger,
        entry: auditEntry({
          job,
          remoteStatus,
          updated,
          decision,
          allocationRefresh,
          allocationRefreshError,
          operationError
        })
      });
    });
    if (!committed) {
      return { outcome: "stale", reason: "lease_lost" };
    }
    emitCommittedEvents({ job, remoteStatus, decision, operationError });
    return completedOutcome(decision, nextAvailableAt);
  }

  async function recordUnhandledFailure(job, error) {
    try {
      return await commitOutcome({ job, operationError: error });
    } catch (finalizeError) {
      logger.error("Delayed NetSuite status refresh could not record its failure:", errorMessage(finalizeError));
      return { outcome: "stale", reason: "failure_record_deferred" };
    }
  }

  async function processJob(input) {
    const job = normalizedJob(input);
    const stopLeaseHeartbeat = startLeaseHeartbeat(job);
    try {
      let remote;
      try {
        remote = await fetchRemoteState(job);
      } catch (error) {
        return recordUnhandledFailure(job, error);
      }
      try {
        return await commitOutcome({ job, ...remote });
      } catch (error) {
        return recordUnhandledFailure(job, error);
      }
    } finally {
      stopLeaseHeartbeat();
    }
  }

  async function runOnce({
    workerId,
    limit = DELAYED_STATUS_REFRESH_BATCH_SIZE,
    leaseMs = DELAYED_STATUS_REFRESH_LEASE_MS,
    now: claimAt = now()
  } = {}) {
    if (running) {
      return { skipped: true, reason: "already_running" };
    }
    running = true;
    const summary = { skipped: false, claimed: 0, succeeded: 0, retried: 0, failed: 0, stale: 0 };
    try {
      const jobs = await claimJobs({ workerId, limit, leaseMs, now: claimAt });
      summary.claimed = jobs.length;
      const results = await Promise.all(jobs.map((claimedJob) => (
        processJob({ ...claimedJob, leaseMs })
      )));
      for (const result of results) {
        if (result.outcome === "succeeded") {
          summary.succeeded += 1;
        } else if (result.outcome === "retry") {
          summary.retried += 1;
        } else if (result.outcome === "failed") {
          summary.failed += 1;
        } else {
          summary.stale += 1;
        }
      }
      return summary;
    } finally {
      running = false;
    }
  }

  return { processJob, runOnce };
}
