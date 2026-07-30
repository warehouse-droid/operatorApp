import { query, withTransaction } from "./db.js";
import {
  fetchPoToLinkedTransactionsFromNetSuite,
  fetchPoToReconciliationOrdersFromNetSuite,
  fetchTransactionProgressFromNetSuite,
  fetchTransactionReferenceByTranidFromNetSuite,
  fetchTransactionStatusFromNetSuite
} from "./netsuite.js";
import {
  markMissingInboundOrderLines,
  markMissingOutboundOrderLines,
  upsertInboundTransferOrderLines,
  upsertInboundTransferOrders,
  upsertOutboundTransferOrderLines,
  upsertOutboundTransferOrders,
  upsertPurchaseOrderLines,
  upsertPurchaseOrders
} from "./order-sync-repository.js";
import {
  approveInitialScmReconciliationRun,
  assertScmReconciliationRunReadyToApply,
  cancelMissingScmPurchaseOrderLocally,
  clearScmReconciliationMissingLookup,
  createScmReconciliationRun,
  findScmReconciliationSource,
  finishScmReconciliationRun,
  getScmReconciliationSettings,
  initializeScmReconciliationRunTargets,
  listScmReconciliationRunTargetDecisions,
  listLocalScmReconciliationSources,
  listScmReconciliationBroadExcludedSources,
  loadLocalScmReconciliationOrder,
  markScmReconciliationNightlyRun,
  markScmReconciliationRunRunning,
  listScmReconciliationRunTargetsForResume,
  queueScmReconciliationRunResume,
  reconcileScmOrderFamily,
  recordScmReconciliationMissingLookup,
  resolveScmReconciliationReview,
  scmReconciliationReviewFingerprint,
  storeLinkedScmReconciliationTransactions,
  updateScmReconciliationRunTarget
} from "./scm-reconciliation-repository.js";

const VALID_KINDS = new Set(["PO", "TO"]);
const VALID_SCOPES = new Set(["all", "PO", "TO", "order_family"]);
const VALID_TRIGGERS = new Set(["nightly", "manual", "webhook", "backfill", "resume"]);
const TORONTO_TIME_ZONE = "America/Toronto";
const RUN_FINAL_STATUSES = new Set([
  "awaiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted"
]);
const RUN_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_TARGET_ORDER_REFS = 100;
const MAX_TARGET_ORDER_REF_LENGTH = 64;
export const SCM_RECONCILIATION_LINKED_BATCH_SIZE = 15;
export const SCM_RECONCILIATION_LINKED_TIMEOUT_ATTEMPTS = 2;
export const SCM_RECONCILIATION_LINKED_EXTRA_REQUEST_BUDGET = 6;

let executionTail = Promise.resolve();
let nightlyTickInProgress = false;
let lastNightlyAttemptLocalDate = "";

function text(value) {
  return String(value ?? "").trim();
}

function positiveId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function reconciliationDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isScmReconciliationNetSuiteTimeout(error) {
  return error?.code === "NETSUITE_REQUEST_TIMEOUT";
}

/**
 * Fetches authoritative IF/IR evidence in small sequential batches. Timeout
 * retries happen outside NetSuite's global SuiteQL queue so operational work
 * can use the queue between attempts. A repeatedly slow batch is split until
 * the exact source order causing the timeout is isolated.
 */
export async function fetchScmReconciliationLinkedTransactionsInBatches(
  orderIds = [],
  {
    fetchBatch = fetchPoToLinkedTransactionsFromNetSuite,
    batchSize = SCM_RECONCILIATION_LINKED_BATCH_SIZE,
    maxTimeoutAttempts = SCM_RECONCILIATION_LINKED_TIMEOUT_ATTEMPTS,
    maxRequestCount = null,
    retryDelayMs = 1_000,
    delay = reconciliationDelay,
    beforeAttempt = async () => {},
    onAttempt = async () => {},
    onRetry = async () => {},
    onSplit = async () => {},
    onBatch = async () => {}
  } = {}
) {
  const ids = [...new Set((orderIds || []).map(positiveId).filter(Boolean))];
  if (!ids.length) return { rows: [], processedOrderIds: [], requestCount: 0 };
  if (typeof fetchBatch !== "function") {
    throw new TypeError("A linked-transaction batch fetcher is required.");
  }
  const size = Math.max(1, Math.min(50, Number(batchSize) || SCM_RECONCILIATION_LINKED_BATCH_SIZE));
  const timeoutAttempts = Math.max(1, Math.min(5, Number(maxTimeoutAttempts)
    || SCM_RECONCILIATION_LINKED_TIMEOUT_ATTEMPTS));
  const baselineRequestCount = Math.ceil(ids.length / size);
  const configuredRequestBudget = Number(maxRequestCount);
  const requestBudget = Number.isFinite(configuredRequestBudget)
    && configuredRequestBudget > 0
    ? Math.max(1, Math.min(200, Math.floor(configuredRequestBudget)))
    : baselineRequestCount + SCM_RECONCILIATION_LINKED_EXTRA_REQUEST_BUDGET;
  const queue = [];
  for (let offset = 0; offset < ids.length; offset += size) {
    queue.push(ids.slice(offset, offset + size));
  }
  const rows = [];
  const processedOrderIds = [];
  let requestCount = 0;
  let timeoutCount = 0;

  while (queue.length) {
    const batchIds = queue.shift();
    const batchStartedAt = new Date().toISOString();
    let batchRows = null;
    let attempt = 0;
    let wasSplit = false;
    while (attempt < timeoutAttempts) {
      if (requestCount >= requestBudget) {
        const budgetError = new Error(
          `NetSuite IF / IR retry budget reached after ${requestCount} requests.`
        );
        budgetError.code = "SCM_RECONCILIATION_LINKED_TIMEOUT";
        budgetError.resumable = true;
        budgetError.sourceOrderId = batchIds.length === 1
          ? batchIds[0]
          : null;
        throw budgetError;
      }
      attempt += 1;
      await beforeAttempt({
        orderIds: batchIds,
        attempt,
        maxAttempts: timeoutAttempts,
        batchStartedAt
      });
      requestCount += 1;
      await onAttempt({
        orderIds: batchIds,
        attempt,
        maxAttempts: timeoutAttempts,
        requestCount,
        batchStartedAt
      });
      try {
        batchRows = await fetchBatch(batchIds);
        break;
      } catch (error) {
        if (!isScmReconciliationNetSuiteTimeout(error)) throw error;
        timeoutCount += 1;
        if (
          timeoutCount >= SCM_RECONCILIATION_LINKED_EXTRA_REQUEST_BUDGET
        ) {
          error.code = "SCM_RECONCILIATION_LINKED_TIMEOUT";
          error.resumable = true;
          error.sourceOrderId = batchIds.length === 1
            ? batchIds[0]
            : null;
          throw error;
        }
        if (attempt < timeoutAttempts) {
          await onRetry({
            orderIds: batchIds,
            attempt,
            maxAttempts: timeoutAttempts,
            error,
            batchStartedAt
          });
          await delay(Math.max(0, Number(retryDelayMs) || 0) * attempt);
          continue;
        }
        if (batchIds.length > 1) {
          const middle = Math.ceil(batchIds.length / 2);
          const left = batchIds.slice(0, middle);
          const right = batchIds.slice(middle);
          queue.unshift(right);
          queue.unshift(left);
          wasSplit = true;
          await onSplit({
            orderIds: batchIds,
            left,
            right,
            error,
            batchStartedAt
          });
          break;
        }
        error.code = "SCM_RECONCILIATION_LINKED_TIMEOUT";
        error.resumable = true;
        error.sourceOrderId = batchIds[0];
        throw error;
      }
    }
    if (wasSplit) continue;
    const normalizedRows = Array.isArray(batchRows) ? batchRows : [];
    rows.push(...normalizedRows);
    processedOrderIds.push(...batchIds);
    await onBatch({
      orderIds: batchIds,
      rows: normalizedRows,
      attempts: attempt,
      processedOrderIds: [...processedOrderIds],
      totalSourceOrders: ids.length,
      batchStartedAt
    });
  }
  return { rows, processedOrderIds, requestCount };
}

function normalizeKind(value) {
  const kind = text(value).toUpperCase();
  return VALID_KINDS.has(kind) ? kind : "";
}

function normalizeScope(value) {
  const raw = text(value);
  if (!raw) return "all";
  if (/^po$/i.test(raw)) return "PO";
  if (/^to$/i.test(raw)) return "TO";
  if (/^order[_ -]?family$/i.test(raw)) return "order_family";
  return VALID_SCOPES.has(raw) ? raw : "all";
}

function normalizeTrigger(value) {
  const trigger = text(value).toLowerCase();
  return VALID_TRIGGERS.has(trigger) ? trigger : "manual";
}

export function normalizeScmReconciliationTargetRefs(...values) {
  const refs = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    String(value ?? "")
      .split(/[\r\n,]+/)
      .map((item) => item.trim().replace(/^"(.*)"$/, "$1").trim().toUpperCase())
      .filter(Boolean)
      .forEach((item) => refs.push(item));
  };
  values.forEach(visit);
  const unique = [...new Set(refs)];
  if (unique.length > MAX_TARGET_ORDER_REFS) {
    throw Object.assign(
      new Error(`Enter no more than ${MAX_TARGET_ORDER_REFS} source order references per run.`),
      { status: 400 }
    );
  }
  const invalid = unique.find((item) =>
    item.length > MAX_TARGET_ORDER_REF_LENGTH
    || /[\u0000-\u001f\u007f]/.test(item)
  );
  if (invalid) {
    throw Object.assign(
      new Error(`Each source order reference must be ${MAX_TARGET_ORDER_REF_LENGTH} characters or fewer.`),
      { status: 400 }
    );
  }
  return unique;
}

function reconciliationSourceName(value) {
  const trigger = normalizeTrigger(value);
  return trigger === "resume" ? "manual" : trigger;
}

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|on)$/i.test(text(value));
}

function sourceKey(source) {
  return `${normalizeKind(source?.kind)}:${positiveId(source?.id) || ""}`;
}

function uniqueSources(sources = []) {
  const result = new Map();
  for (const source of sources || []) {
    const kind = normalizeKind(source?.kind);
    const id = positiveId(source?.id);
    if (!kind || !id) continue;
    const key = `${kind}:${id}`;
    const previous = result.get(key);
    result.set(key, {
      kind,
      id,
      tranid: text(source?.tranid || previous?.tranid).toUpperCase()
    });
  }
  return [...result.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.id - right.id
  );
}

function mapRunRow(row = {}) {
  return {
    id: Number(row.id),
    runKey: row.run_key || row.runKey || "",
    triggerSource: row.trigger_source || row.triggerSource || "manual",
    scope: row.scope_kind || row.scope || "all",
    targetOrderKind: row.target_order_kind || row.targetOrderKind || "",
    targetOrderId: row.target_order_netsuite_id || row.targetOrderId || null,
    targetOrderRef: row.target_order_ref || row.targetOrderRef || "",
    includeTerminalOrders: row.include_terminal_orders === undefined
      ? row.includeTerminalOrders === true
      : row.include_terminal_orders === true,
    cancelRequestedAt: row.cancel_requested_at || row.cancelRequestedAt || null,
    cancelRequestedBy: row.cancel_requested_by || row.cancelRequestedBy || "",
    cancelRequestNote: row.cancel_request_note || row.cancelRequestNote || "",
    dryRun: row.dry_run === undefined ? row.dryRun === true : row.dry_run === true,
    applyUnambiguous: row.apply_unambiguous === undefined
      ? row.applyUnambiguous === true
      : row.apply_unambiguous === true,
    status: row.status || "",
    resumeOfRunId: positiveId(row.resume_of_run_id ?? row.resumeOfRunId),
    requestedBy: row.requested_by || row.requestedBy || "",
    approvedBy: row.approved_by || row.approvedBy || "",
    approvedAt: row.approved_at || row.approvedAt || null,
    checkpoint: row.checkpoint || {},
    summary: row.summary || {},
    error: row.error || "",
    apiRequestCount: Number(row.api_request_count ?? row.apiRequestCount ?? 0),
    createdAt: row.created_at || row.createdAt || null,
    startedAt: row.started_at || row.startedAt || null,
    completedAt: row.completed_at || row.completedAt || null
  };
}

async function loadRun(runOrId) {
  const id = positiveId(runOrId && typeof runOrId === "object" ? runOrId.id : runOrId);
  if (!id) throw Object.assign(new Error("A valid reconciliation run ID is required."), { status: 400 });
  const result = await query(
    `SELECT *
       FROM scm_reconciliation_runs
      WHERE id = $1`,
    [id]
  );
  if (!result.rows[0]) {
    throw Object.assign(new Error("The PO/TO reconciliation run was not found."), { status: 404 });
  }
  return mapRunRow(result.rows[0]);
}

function serialExecution(work) {
  const next = executionTail.catch(() => null).then(work);
  executionTail = next.catch(() => null);
  return next;
}

async function operationalWorkIsRunning(callback) {
  if (typeof callback !== "function") return false;
  try {
    return (await callback()) === true;
  } catch {
    // A broken operational guard must fail safe: reconciliation can wait, while
    // delivery/order synchronization must retain the NetSuite request slot.
    return true;
  }
}

function exactLineKey(line) {
  const key = text(line?.sourceLineKey);
  const id = Number(key);
  if (!key || !/^\d+$/.test(key) || !Number.isSafeInteger(id) || id <= 0) {
    throw Object.assign(
      new Error(`NetSuite did not return a safe unique source-line key for ${line?.itemName || "an order line"}.`),
      { code: "SCM_RECONCILIATION_LINE_IDENTITY", status: 409 }
    );
  }
  return key;
}

function mappedOrderHeader(order) {
  const firstLineLocation = (order.lines || []).find((line) => positiveId(line.locationId));
  const destinationLocationId = positiveId(order.destinationLocationId)
    || (order.kind === "PO" ? positiveId(firstLineLocation?.locationId) : null);
  const destinationLocation = text(order.destinationLocation)
    || (order.kind === "PO" ? text(firstLineLocation?.location) : "");
  return {
    id: positiveId(order.id),
    tranid: text(order.tranid),
    trandate: order.trandate || null,
    status: text(order.status),
    status_text: text(order.statusText),
    expected_delivery_date: order.expectedDeliveryDate || null,
    memo: text(order.memo),
    foreigntotal: order.foreignTotal,
    vendor_id: positiveId(order.entityId),
    vendor: text(order.entity),
    source_location_id: positiveId(order.sourceLocationId),
    source_location: text(order.sourceLocation),
    outbound_location_id: positiveId(order.sourceLocationId),
    outbound_location: text(order.sourceLocation),
    destination_location_id: destinationLocationId,
    destination_location: destinationLocation
  };
}

function mappedOrderLine(line) {
  const lineKey = exactLineKey(line);
  return {
    uniquekey: lineKey,
    line_unique_key: lineKey,
    line_id: lineKey,
    item_id: positiveId(line.itemId),
    item_name: text(line.itemName),
    item_type: text(line.itemType),
    item_type_text: text(line.itemTypeText),
    item_description: text(line.itemDescription),
    sku: text(line.sku || line.itemName),
    quantity: Number(line.quantity) || 0,
    netsuite_received_qty: Number(line.cumulativeProgressQuantity) || 0,
    unit: text(line.unit),
    item_weight: line.itemWeight ?? null,
    location_id: positiveId(line.locationId),
    location: text(line.location),
    pallet_qty: Number(line.palletQty) || 0,
    layer_qty: Number(line.layerQty) || 0,
    piece_qty: Number(line.pieceQty) || 0,
    section_qty: Number(line.sectionQty) || 0,
    to_plt: line.toPlt ?? null,
    to_lyr: line.toLyr ?? null,
    to_sec: line.toSec ?? null,
    to_pcs: line.toPcs ?? null,
    raw: {
      ...(line.raw && typeof line.raw === "object" ? line.raw : {}),
      sourceLineKey: lineKey,
      sourceLineAliases: Array.isArray(line.sourceLineAliases)
        ? line.sourceLineAliases.map(text).filter(Boolean)
        : [lineKey],
      orderLine: line.orderLine,
      orderLineAliases: Array.isArray(line.orderLineAliases)
        ? line.orderLineAliases.map(text).filter(Boolean)
        : [text(line.orderLine)].filter(Boolean),
      identityStatus: text(line.identityStatus || "exact"),
      identityIssue: text(line.identityIssue),
      logicalLineIdentity: text(line.logicalLineIdentity),
      reconciliationStage: line.stage
    }
  };
}

function normalizeFetchedOrder(order = {}) {
  const kind = normalizeKind(order.kind);
  const id = positiveId(order.id);
  if (!kind || !id) return null;
  return {
    ...order,
    id,
    kind,
    tranid: text(order.tranid).toUpperCase(),
    lines: (Array.isArray(order.lines) ? order.lines : []).map((line) => ({
      ...line,
      sourceLineKey: text(line.sourceLineKey),
      sourceLineAliases: Array.isArray(line.sourceLineAliases)
        ? [...new Set(line.sourceLineAliases.map(text).filter(Boolean))]
        : [text(line.sourceLineKey)].filter(Boolean),
      orderLineAliases: Array.isArray(line.orderLineAliases)
        ? [...new Set(line.orderLineAliases.map(text).filter(Boolean))]
        : [text(line.orderLine)].filter(Boolean),
      identityStatus: text(line.identityStatus || "exact"),
      identityIssue: text(line.identityIssue),
      stage: kind === "PO"
        ? "receiving"
        : text(line.stage).toLowerCase() === "receiving"
          ? "receiving"
          : "outbound"
    }))
  };
}

function legacyProgressOrder(progress, kind) {
  if (!progress) return null;
  const cleanKind = normalizeKind(kind);
  const id = positiveId(progress.id);
  if (!cleanKind || !id) return null;
  return normalizeFetchedOrder({
    id,
    kind: cleanKind,
    recordType: cleanKind === "PO" ? "PurchOrd" : "TrnfrOrd",
    tranid: progress.tranid || "",
    trandate: progress.trandate || null,
    status: progress.status || "",
    statusText: progress.status_text || "",
    sourceLocationId: positiveId(progress.source_location_id),
    sourceLocation: progress.source_location || "",
    destinationLocationId: positiveId(progress.destination_location_id),
    destinationLocation: progress.destination_location || "",
    headerOnlyFallback: !(progress.lines || []).length,
    lines: (progress.lines || []).map((line) => ({
      sourceLineKey: text(line.line_id),
      orderLine: line.order_line ?? line.line_id,
      stage: cleanKind === "PO"
        ? "receiving"
        : Number(line.quantity) < 0
          ? "outbound"
          : "receiving",
      itemId: positiveId(line.item_id),
      itemName: line.item_name || "",
      itemDescription: line.item_description || "",
      itemType: line.item_type || "",
      itemTypeText: line.item_type_text || "",
      quantity: Math.abs(Number(line.quantity) || 0),
      cumulativeProgressQuantity: Math.abs(Number(line.netsuite_received_qty) || 0),
      unit: line.unit || "",
      locationId: positiveId(line.location_id),
      location: line.location || "",
      itemWeight: line.item_weight,
      palletQty: line.pallet_qty,
      layerQty: line.layer_qty,
      pieceQty: line.piece_qty,
      sectionQty: line.section_qty,
      toPlt: line.to_plt,
      toLyr: line.to_lyr,
      toSec: line.to_sec,
      toPcs: line.to_pcs,
      raw: line
    }))
  });
}

async function syncFetchedSourceOrder(order) {
  const normalized = normalizeFetchedOrder(order);
  if (!normalized) throw new Error("NetSuite returned an invalid PO/TO source order.");
  const header = mappedOrderHeader(normalized);
  if (normalized.kind === "PO") {
    const lines = normalized.lines.map(mappedOrderLine);
    await upsertPurchaseOrders([header]);
    await upsertPurchaseOrderLines(normalized.id, lines);
    await markMissingInboundOrderLines(
      normalized.id,
      lines.map((line) => Number(line.line_id))
    );
    return;
  }

  const outboundLines = normalized.lines
    .filter((line) => line.stage === "outbound")
    .map(mappedOrderLine);
  const receivingLines = normalized.lines
    .filter((line) => line.stage === "receiving")
    .map(mappedOrderLine);
  await upsertOutboundTransferOrders([header]);
  await upsertInboundTransferOrders([header]);
  await upsertOutboundTransferOrderLines(normalized.id, outboundLines);
  await upsertInboundTransferOrderLines(normalized.id, receivingLines);
  await markMissingOutboundOrderLines(
    normalized.id,
    outboundLines.map((line) => Number(line.line_id))
  );
  await markMissingInboundOrderLines(
    normalized.id,
    receivingLines.map((line) => Number(line.line_id))
  );
}

async function resolveSingleOrderFamilySource({
  kind,
  orderId = null,
  orderRef = ""
} = {}) {
  const local = await findScmReconciliationSource({
    kind,
    orderId: positiveId(orderId),
    orderRef
  });
  if (local) return { source: local, apiRequests: 0 };
  const directId = positiveId(orderId);
  if (directId) {
    return {
      source: { kind, id: directId, tranid: text(orderRef).toUpperCase() },
      apiRequests: 0
    };
  }
  const cleanOrderRef = text(orderRef).toUpperCase();
  if (!cleanOrderRef) {
    throw Object.assign(new Error("Enter a PO/TO number or internal ID."), { status: 400 });
  }
  const reference = await fetchTransactionReferenceByTranidFromNetSuite(
    cleanOrderRef,
    kind === "PO" ? "PurchOrd" : "TrnfrOrd"
  );
  if (!reference?.id) {
    throw Object.assign(new Error(`${cleanOrderRef} was not found in NetSuite.`), { status: 404 });
  }
  return {
    source: {
      kind,
      id: positiveId(reference.id),
      tranid: text(reference.tranid || cleanOrderRef).toUpperCase()
    },
    apiRequests: 1
  };
}

async function resolveOrderFamilySources(run, workerLeaseToken) {
  const kind = normalizeKind(run.targetOrderKind);
  if (!kind) {
    throw Object.assign(new Error("Select PO or TO for this reconciliation."), { status: 400 });
  }
  const directId = positiveId(run.targetOrderId);
  const refs = normalizeScmReconciliationTargetRefs(run.targetOrderRef);
  if (directId && refs.length > 1) {
    throw Object.assign(
      new Error("A numeric internal ID cannot be combined with multiple source order references."),
      { status: 400 }
    );
  }
  if (!directId && !refs.length) {
    throw Object.assign(
      new Error("Enter one or more PO/TO numbers or one internal ID."),
      { status: 400 }
    );
  }
  const targets = directId
    ? [{ orderId: directId, orderRef: refs[0] || "" }]
    : refs.map((orderRef) => ({ orderId: null, orderRef }));
  const sources = [];
  const resolutionErrors = [];
  let apiRequests = 0;
  for (const target of targets) {
    await assertScmReconciliationRunActive(run.id, workerLeaseToken);
    try {
      const resolved = await resolveSingleOrderFamilySource({ kind, ...target });
      sources.push(resolved.source);
      apiRequests += resolved.apiRequests;
    } catch (error) {
      if (Number(error?.status) !== 404) throw error;
      resolutionErrors.push({
        orderKind: kind,
        orderRef: target.orderRef,
        error: text(error?.message || error)
      });
    }
  }
  if (!sources.length && resolutionErrors.length) {
    throw Object.assign(
      new Error(
        `None of the ${resolutionErrors.length} source order reference(s) were found in NetSuite.`
      ),
      {
        status: 404,
        code: "SCM_RECONCILIATION_TARGETS_NOT_FOUND",
        resolutionErrors
      }
    );
  }
  return {
    sources: uniqueSources(sources),
    resolutionErrors,
    apiRequests
  };
}

async function resolveRunSources(run, workerLeaseToken) {
  const scope = normalizeScope(run.scope);
  let sources = [];
  let apiRequests = 0;
  let resolutionErrors = [];
  if (scope === "order_family") {
    const resolved = await resolveOrderFamilySources(run, workerLeaseToken);
    sources = resolved.sources;
    apiRequests = resolved.apiRequests;
    resolutionErrors = resolved.resolutionErrors || [];
  } else {
    sources = await listLocalScmReconciliationSources({
      kind: scope === "PO" || scope === "TO" ? scope : "",
      includeTerminalOrders: run.includeTerminalOrders
    });
  }
  const excludedSources = run.includeTerminalOrders
    ? []
    : await listScmReconciliationBroadExcludedSources({
      kind: scope === "PO" || scope === "TO"
        ? scope
        : scope === "order_family"
          ? normalizeKind(run.targetOrderKind)
          : ""
    });
  const candidateKeys = new Set(sources.map(sourceKey));
  const applicableExcludedSources = scope === "order_family"
    ? excludedSources.filter((source) => candidateKeys.has(sourceKey(source)))
    : excludedSources;
  const excludedKeys = new Set(applicableExcludedSources.map(sourceKey));
  return {
    sources: sources.filter((source) => !excludedKeys.has(sourceKey(source))),
    excludedSources: applicableExcludedSources,
    resolutionErrors,
    apiRequests
  };
}

async function directFetchSource(source) {
  const orders = await fetchPoToReconciliationOrdersFromNetSuite({
    orderIds: [source.id],
    kind: source.kind,
    modifiedSince: "1900-01-01",
    includeOpen: false,
    targetOnly: true
  });
  const exact = (orders || [])
    .map(normalizeFetchedOrder)
    .find((order) => order && order.kind === source.kind && order.id === source.id);
  if (exact) return { order: exact, apiRequests: 1 };

  // A transaction with every item line removed still exists, but the source
  // reconciliation query intentionally filters non-item lines. The header
  // fallback distinguishes that case from a genuinely deleted/missing record.
  const progress = await fetchTransactionProgressFromNetSuite(
    source.id,
    source.kind === "PO" ? "PurchOrd" : "TrnfrOrd"
  );
  return {
    order: legacyProgressOrder(progress, source.kind),
    // Exact line query + progress query + its header-status fallback.
    apiRequests: 3
  };
}

export async function verifyMissingScmPurchaseOrderInNetSuite(source = {}, options = {}) {
  const orderId = positiveId(source.id ?? source.orderId ?? source.sourceOrderId);
  const orderRef = text(
    source.tranid ?? source.orderRef ?? source.sourceOrderRef
  ).toUpperCase();
  if (!orderId || !orderRef) {
    throw Object.assign(
      new Error("A valid local Purchase Order ID and transaction number are required."),
      { status: 400 }
    );
  }
  const fetchOrders = options.fetchOrders
    || fetchPoToReconciliationOrdersFromNetSuite;
  const fetchHeader = options.fetchHeader
    || fetchTransactionStatusFromNetSuite;
  const fetchReference = options.fetchReference
    || fetchTransactionReferenceByTranidFromNetSuite;
  const orders = await fetchOrders({
    orderIds: [orderId],
    kind: "PO",
    modifiedSince: "1900-01-01",
    includeOpen: false,
    targetOnly: true
  });
  const exactOrder = (orders || [])
    .map(normalizeFetchedOrder)
    .find((order) => order && order.kind === "PO" && order.id === orderId);
  const header = await fetchHeader(orderId, "PurchOrd");
  const reference = await fetchReference(orderRef, "PurchOrd");
  const verification = {
    verifiedAt: new Date().toISOString(),
    orderKind: "PO",
    sourceOrderId: orderId,
    sourceOrderRef: orderRef,
    lineQueryFound: Boolean(exactOrder),
    headerQueryFound: Boolean(header),
    referenceQueryFound: Boolean(reference),
    visibleOrder: exactOrder ? {
      id: exactOrder.id,
      tranid: exactOrder.tranid,
      status: exactOrder.status,
      statusText: exactOrder.statusText,
      lastModifiedAt: exactOrder.lastModifiedAt || null
    } : null,
    visibleHeader: header ? {
      id: positiveId(header.id),
      tranid: text(header.tranid).toUpperCase(),
      status: text(header.status),
      statusText: text(header.status_text ?? header.statusText),
      lastModifiedAt: header.lastmodifieddate ?? header.lastModifiedAt ?? null
    } : null,
    visibleReference: reference ? {
      id: positiveId(reference.id),
      tranid: text(reference.tranid).toUpperCase(),
      status: text(reference.status),
      statusText: text(reference.status_text ?? reference.statusText)
    } : null
  };
  if (
    verification.lineQueryFound
    || verification.headerQueryFound
    || verification.referenceQueryFound
  ) {
    throw Object.assign(
      new Error(
        `${orderRef} is currently visible in NetSuite and cannot be marked locally Cancelled.`
      ),
      {
        status: 409,
        code: "SCM_RECONCILIATION_SOURCE_VISIBLE",
        verification
      }
    );
  }
  return verification;
}

export async function cancelMissingScmPurchaseOrder(
  {
    orderId = null,
    orderRef = "",
    reviewCaseId = null,
    expectedLastDetectedAt = null,
    confirmed = false,
    note = "",
    actor = ""
  } = {},
  options = {}
) {
  if (confirmed !== true) {
    throw Object.assign(
      new Error("Confirm that this missing Purchase Order should be marked locally Cancelled."),
      { status: 400, code: "SCM_RECONCILIATION_CANCEL_CONFIRMATION_REQUIRED" }
    );
  }
  const cleanNote = text(note);
  const cleanActor = text(actor);
  if (!cleanNote) {
    throw Object.assign(
      new Error("Enter an audit note before cancelling the missing Purchase Order."),
      { status: 400 }
    );
  }
  if (!cleanActor) {
    throw Object.assign(new Error("Admin identity is required."), { status: 401 });
  }
  if (typeof options.operationalSyncRunning === "function"
    && await options.operationalSyncRunning()) {
    throw Object.assign(
      new Error("Wait for the active NetSuite synchronization to finish, then verify this order again."),
      { status: 409, code: "SCM_RECONCILIATION_OPERATIONAL_SYNC_ACTIVE" }
    );
  }
  const source = await findScmReconciliationSource({
    kind: "PO",
    orderId: positiveId(orderId),
    orderRef: text(orderRef).toUpperCase()
  });
  if (!source) {
    throw Object.assign(
      new Error("The local Purchase Order was not found."),
      { status: 404 }
    );
  }
  const verification = await verifyMissingScmPurchaseOrderInNetSuite(
    source,
    options
  );
  if (typeof options.operationalSyncRunning === "function"
    && await options.operationalSyncRunning()) {
    throw Object.assign(
      new Error("A NetSuite synchronization started during verification. Try again after it finishes."),
      { status: 409, code: "SCM_RECONCILIATION_OPERATIONAL_SYNC_ACTIVE" }
    );
  }
  return cancelMissingScmPurchaseOrderLocally({
    sourceOrderId: source.id,
    sourceOrderRef: source.tranid,
    reviewCaseId,
    expectedLastDetectedAt,
    verification,
    note: cleanNote,
    actor: cleanActor,
    actorRole: "admin"
  });
}

async function ensureMissingOrderState(source, sourceName, runId) {
  const local = await loadLocalScmReconciliationOrder(source.kind, source.id);
  const reference = text(local?.tranid || source.tranid || `${source.kind}${source.id}`).toUpperCase();
  await query(
    `INSERT INTO scm_reconciliation_order_state (
       order_kind, source_order_netsuite_id, source_order_ref,
       netsuite_status_code, netsuite_status_text, netsuite_terminal_state,
       application_status, reconciliation_status, reconciliation_source,
       source_location_id, source_location, destination_location_id,
       destination_location, order_snapshot, last_run_id, created_at, updated_at
     ) VALUES (
       $1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), 'unknown',
       'Queued', 'pending', $6, $7, NULLIF($8, ''), $9,
       NULLIF($10, ''), $11::jsonb, $12, now(), now()
     )
     ON CONFLICT (order_kind, source_order_netsuite_id) DO UPDATE SET
       source_order_ref = EXCLUDED.source_order_ref,
       netsuite_status_code = COALESCE(EXCLUDED.netsuite_status_code, scm_reconciliation_order_state.netsuite_status_code),
       netsuite_status_text = COALESCE(EXCLUDED.netsuite_status_text, scm_reconciliation_order_state.netsuite_status_text),
       reconciliation_source = EXCLUDED.reconciliation_source,
       order_snapshot = CASE
         WHEN scm_reconciliation_order_state.order_snapshot = '{}'::jsonb
         THEN EXCLUDED.order_snapshot
         ELSE scm_reconciliation_order_state.order_snapshot
       END,
       last_run_id = EXCLUDED.last_run_id,
       updated_at = now()`,
    [
      source.kind,
      source.id,
      reference,
      text(local?.status),
      text(local?.statusText),
      sourceName,
      positiveId(local?.sourceLocationId),
      text(local?.sourceLocation),
      positiveId(local?.destinationLocationId),
      text(local?.destinationLocation),
      JSON.stringify(local || { kind: source.kind, id: source.id, tranid: reference }),
      positiveId(runId)
    ]
  );
}

async function recordDryRunMissingLookup(source, sourceName, runId) {
  const reason = "The order was absent from two successful direct NetSuite lookups.";
  const result = await query(
    `UPDATE scm_reconciliation_order_state
        SET missing_success_count = missing_success_count + 1,
            last_direct_lookup_at = now(),
            netsuite_terminal_state = CASE
              WHEN missing_success_count + 1 >= 2 THEN 'missing'
              ELSE netsuite_terminal_state
            END,
            reconciliation_status = CASE
              WHEN missing_success_count + 1 >= 2 THEN 'missing'
              ELSE reconciliation_status
            END,
            reconciliation_reason = CASE
              WHEN missing_success_count + 1 >= 2 THEN $3
              ELSE reconciliation_reason
            END,
            reconciliation_source = $4,
            last_run_id = $5,
            proposed_state = CASE
              WHEN missing_success_count + 1 >= 2
              THEN jsonb_build_object(
                'applicationStatus', 'Reconcile Review',
                'reconciliationStatus', 'missing',
                'reason', $3
              )
              ELSE proposed_state
            END,
            updated_at = now()
      WHERE order_kind = $1
        AND source_order_netsuite_id = $2
      RETURNING missing_success_count, reconciliation_status, reconciliation_reason`,
    [source.kind, source.id, reason, sourceName, positiveId(runId)]
  );
  return result.rows[0] || {
    missing_success_count: 1,
    reconciliation_status: "pending",
    reconciliation_reason: ""
  };
}

async function updateRunCheckpoint(
  runId,
  checkpoint,
  apiRequestCount = null,
  summary = null
) {
  const workerLeaseToken = text(checkpoint?.workerLeaseToken);
  const result = await query(
    `UPDATE scm_reconciliation_runs
        SET checkpoint = $2::jsonb,
            api_request_count = CASE
              WHEN $3::integer IS NULL THEN api_request_count
              ELSE GREATEST(api_request_count, $3::integer)
            END,
            summary = CASE
              WHEN $5::jsonb IS NULL THEN summary
              ELSE $5::jsonb
            END,
            heartbeat_at = now(),
            updated_at = now()
      WHERE id = $1
        AND status = 'running'
        AND cancel_requested_at IS NULL
        AND checkpoint->>'workerLeaseToken' = $4
      RETURNING id`,
    [
      Number(runId),
      JSON.stringify(checkpoint || {}),
      apiRequestCount === null
        ? null
        : Math.max(0, Number(apiRequestCount) || 0),
      workerLeaseToken,
      summary === null ? null : JSON.stringify(summary || {})
    ]
  );
  if (!result.rows[0]) {
    const error = new Error(
      "The reconciliation worker no longer owns this run."
    );
    error.code = "SCM_RECONCILIATION_LEASE_LOST";
    throw error;
  }
}

function startRunHeartbeat(runId, workerLeaseToken) {
  let stopped = false;
  let timer = null;
  let pending = Promise.resolve();

  const heartbeat = () => {
    if (stopped) return;
    pending = pending
      .then(async () => {
        const result = await query(
          `UPDATE scm_reconciliation_runs
              SET heartbeat_at = now(),
                  updated_at = now()
            WHERE id = $1
              AND status = 'running'
              AND checkpoint->>'workerLeaseToken' = $2
            RETURNING id`,
          [Number(runId), text(workerLeaseToken)]
        );
        if (!result.rows[0]) {
          stopped = true;
          if (timer) clearInterval(timer);
        }
      })
      .catch((error) => {
        console.error(
          `PO/TO reconciliation heartbeat failed for run ${runId}:`,
          error
        );
      });
  };

  timer = setInterval(heartbeat, RUN_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    await pending.catch(() => null);
  };
}

async function assertScmReconciliationRunActive(runId, workerLeaseToken) {
  const result = await query(
    `SELECT status, cancel_requested_at,
            checkpoint->>'workerLeaseToken' AS worker_lease_token
       FROM scm_reconciliation_runs
      WHERE id = $1`,
    [Number(runId)]
  );
  if (
    result.rows[0]?.status !== "running"
    || result.rows[0]?.cancel_requested_at
    || result.rows[0]?.worker_lease_token !== text(workerLeaseToken)
  ) {
    const error = new Error("The reconciliation worker no longer owns this run.");
    error.code = result.rows[0]?.cancel_requested_at
      ? "SCM_RECONCILIATION_CANCEL_REQUESTED"
      : "SCM_RECONCILIATION_LEASE_LOST";
    throw error;
  }
}

async function assertScmReconciliationMutationAllowed(
  runId,
  workerLeaseToken
) {
  const result = await query(
    `SELECT status, cancel_requested_at,
            checkpoint->>'workerLeaseToken' AS worker_lease_token
       FROM scm_reconciliation_runs
      WHERE id = $1
      FOR SHARE`,
    [Number(runId)]
  );
  if (
    result.rows[0]?.status !== "running"
    || result.rows[0]?.cancel_requested_at
    || result.rows[0]?.worker_lease_token !== text(workerLeaseToken)
  ) {
    const error = new Error("The reconciliation Stop request was acknowledged.");
    error.code = result.rows[0]?.cancel_requested_at
      ? "SCM_RECONCILIATION_CANCEL_REQUESTED"
      : "SCM_RECONCILIATION_LEASE_LOST";
    throw error;
  }
}

function initialSummary(run, effectiveDryRun) {
  return {
    runId: run.id,
    triggerSource: run.triggerSource,
    scope: run.scope,
    dryRun: effectiveDryRun,
    sourceOrders: 0,
    discoveredOrders: 0,
    unresolvedTargetReferences: 0,
    recoveredOrders: 0,
    reconciledOrders: 0,
    reviewOrders: 0,
    missingFirstLookup: 0,
    missingConfirmed: 0,
    failedOrders: 0,
    linkedTransactionsStored: 0,
    linkedTransactionsDeleted: 0,
    locallyExcludedOrders: 0,
    decisionSkippedOrders: 0,
    decisionAcceptedOrders: 0,
    decisionKeptReviewOrders: 0,
    decisionChangedOrders: 0,
    yielded: false,
    errors: []
  };
}

function savedTargetResolutionErrors(run = {}) {
  const saved = Array.isArray(run.checkpoint?.targetResolutionErrors)
    ? run.checkpoint.targetResolutionErrors
    : [];
  if (saved.length) return saved;
  const expected = Math.max(
    0,
    Number(run.summary?.unresolvedTargetReferences || 0)
  );
  if (!expected) return [];
  return (Array.isArray(run.summary?.errors) ? run.summary.errors : [])
    .filter((entry) =>
      entry
      && text(entry.orderRef)
      && !positiveId(entry.orderId)
      && !text(entry.code)
    )
    .slice(0, expected);
}

async function markRunInterrupted(
  run,
  reason,
  apiRequestCount = Number(run?.apiRequestCount || 0),
  checkpoint = run?.checkpoint || {}
) {
  return finishScmReconciliationRun(run.id, {
    status: "interrupted",
    summary: {
      ...(run.summary || {}),
      yielded: true,
      reason
    },
    checkpoint,
    error: reason,
    apiRequestCount
  });
}

async function executeRunCore(runOrId, {
  operationalSyncRunning,
  allowInitialApply = false
} = {}) {
  let run = await loadRun(runOrId);
  if (RUN_FINAL_STATUSES.has(run.status)) return run;

  if (await operationalWorkIsRunning(operationalSyncRunning)) {
    if (run.triggerSource === "webhook" && run.status === "queued") {
      // The webhook payload is already durable. Keep targeted work in the
      // queue while operational synchronization owns the NetSuite slot so the
      // scheduled dispatcher can retry it without requiring a resend.
      return run;
    }
    return markRunInterrupted(run, "Yielded to active operational NetSuite synchronization.");
  }

  const settings = await getScmReconciliationSettings();
  // Until the reviewed full proposal has been successfully applied, every
  // ordinary entry point remains proposal-only. The private override is used
  // solely by an explicit Apply action after it validates a completed dry run.
  // Only a successfully applied initial all-scope proposal enables nightly
  // automation.
  const durableLiveApplyIntent = run.dryRun === false
    && Boolean(run.resumeOfRunId);
  const forcedInitialDryRun = !settings.initialDryRunApprovedAt
    && allowInitialApply !== true
    && !durableLiveApplyIntent;
  const effectiveDryRun = forcedInitialDryRun || run.dryRun === true;
  if (effectiveDryRun !== run.dryRun || (effectiveDryRun && run.applyUnambiguous)) {
    const adjusted = await query(
      `UPDATE scm_reconciliation_runs
          SET dry_run = $2,
              apply_unambiguous = CASE WHEN $2 THEN false ELSE apply_unambiguous END,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [run.id, effectiveDryRun]
    );
    run = mapRunRow(adjusted.rows[0] || run);
  }

  try {
    run = await markScmReconciliationRunRunning(run.id);
  } catch (error) {
    if (error?.code === "23505" || error?.status === 409) {
      const current = await loadRun(run.id);
      if (current.status === "running" || RUN_FINAL_STATUSES.has(current.status)) return current;
      // A targeted webhook can wait durably behind a worker owned by another
      // application process. Leave it queued for the scheduled dispatcher
      // instead of converting accepted webhook work into an interruption.
      if (current.status === "queued") return current;
      return current;
    }
    throw error;
  }

  const workerLeaseToken = text(run.checkpoint?.workerLeaseToken);
  if (!workerLeaseToken) {
    throw new Error("The reconciliation worker lease could not be established.");
  }
  const finishOwnedRun = (options) => finishScmReconciliationRun(run.id, {
    ...(options || {}),
    expectedWorkerLeaseToken: workerLeaseToken
  });
  const updateOwnedRunTarget = (source, options) =>
    updateScmReconciliationRunTarget(run.id, source, {
      ...(options || {}),
      workerLeaseToken
    });
  let apiRequestCount = Number(run.apiRequestCount || 0);
  const resumeRequested = run.checkpoint?.resumeRequested === true;
  const existingTargets = resumeRequested
    ? await listScmReconciliationRunTargetsForResume(run.id)
    : [];
  const recordedManifestCount = Number(
    run.checkpoint?.targetManifestCount
    ?? run.checkpoint?.total
    ?? 0
  );
  const legacyManifestPhase = new Set([
    "direct_lookup",
    "fetch_linked_transactions",
    "reconcile",
    "complete"
  ]).has(text(run.checkpoint?.phase));
  const resumeUsesFrozenTargets = resumeRequested
    && existingTargets.length > 0
    && (
      run.checkpoint?.targetManifestComplete === true
      || (
        legacyManifestPhase
        && recordedManifestCount === existingTargets.length
      )
    );
  const reusableTargets = resumeUsesFrozenTargets ? existingTargets : [];
  const completedTargetStatuses = new Set(["succeeded", "review", "skipped"]);
  const completedTargets = reusableTargets.filter((target) =>
    completedTargetStatuses.has(text(target.status).toLowerCase()));
  const failedTargets = reusableTargets.filter((target) =>
    text(target.status).toLowerCase() === "failed");
  const remainingTargets = reusableTargets.filter((target) =>
    ["pending", "running"].includes(text(target.status).toLowerCase()));
  const previousSummary = run.summary || {};
  const {
    errors: _previousErrors,
    yielded: _previousYielded,
    stopped: _previousStopped,
    stoppedBy: _previousStoppedBy,
    stoppedAt: _previousStoppedAt,
    reason: _previousInterruptionReason,
    resumed: _previousResumed,
    resumeCount: _previousResumeCount,
    ...durablePreviousSummary
  } = previousSummary;
  const retainedResolutionErrors = resumeUsesFrozenTargets
    ? savedTargetResolutionErrors(run)
    : [];
  const failedTargetErrors = failedTargets.map((target) => ({
    orderKind: target.orderKind,
    orderId: target.orderId,
    orderRef: target.orderRef,
    error: target.error
  }));
  const summary = resumeRequested
    ? {
      ...initialSummary(run, effectiveDryRun),
      ...durablePreviousSummary,
      failedOrders: failedTargets.length,
      unresolvedTargetReferences: resumeUsesFrozenTargets
        ? Math.max(
          Number(previousSummary.unresolvedTargetReferences || 0),
          retainedResolutionErrors.length
        )
        : 0,
      errors: [...retainedResolutionErrors, ...failedTargetErrors],
      yielded: false,
      resumed: true,
      resumeCount: Number(run.checkpoint?.resumeCount || 1)
    }
    : initialSummary(run, effectiveDryRun);
  let reconciledCompletedTargets = [];
  if (resumeUsesFrozenTargets) {
    const missingCompletedTargets = completedTargets.filter((target) =>
      Number(target.result?.missingLookupCount || 0) > 0);
    const missingCompletedKeys = new Set(
      missingCompletedTargets.map((target) => sourceKey({
        kind: target.orderKind,
        id: target.orderId
      }))
    );
    reconciledCompletedTargets = completedTargets.filter((target) =>
      !missingCompletedKeys.has(sourceKey({
        kind: target.orderKind,
        id: target.orderId
      }))
      && ["succeeded", "review"].includes(text(target.status).toLowerCase()));
    summary.reconciledOrders = Math.max(
      Number(summary.reconciledOrders || 0),
      reconciledCompletedTargets.length
    );
    summary.reviewOrders = Math.max(
      Number(summary.reviewOrders || 0),
      reconciledCompletedTargets.filter((target) =>
        text(target.status).toLowerCase() === "review").length
    );
    summary.missingConfirmed = Math.max(
      Number(summary.missingConfirmed || 0),
      missingCompletedTargets.filter((target) =>
        text(target.status).toLowerCase() === "review").length
    );
    summary.missingFirstLookup = Math.max(
      Number(summary.missingFirstLookup || 0),
      missingCompletedTargets.filter((target) =>
        text(target.status).toLowerCase() === "skipped").length
    );
    summary.decisionSkippedOrders = Math.max(
      Number(summary.decisionSkippedOrders || 0),
      completedTargets.filter((target) =>
        text(target.result?.reviewDecision).toLowerCase() === "skip").length
    );
  }
  const checkpoint = {
    ...(run.checkpoint || {}),
    phase: "resolve_sources",
    processed: completedTargets.length + failedTargets.length,
    total: reusableTargets.length
  };
  const stopRunHeartbeat = startRunHeartbeat(run.id, workerLeaseToken);

  try {
    const scope = normalizeScope(run.scope);
    const reviewDecisions = new Map(
      !effectiveDryRun && run.resumeOfRunId
        ? (await listScmReconciliationRunTargetDecisions(run.resumeOfRunId))
          .map((target) => [sourceKey({
            kind: target.orderKind,
            id: target.orderId
          }), target])
        : []
    );
    const resolved = resumeUsesFrozenTargets
      ? {
        sources: remainingTargets.map((target) => ({
          kind: target.orderKind,
          id: target.orderId,
          tranid: target.orderRef
        })),
        excludedSources: [],
        resolutionErrors: [],
        apiRequests: 0
      }
      : await resolveRunSources(run, workerLeaseToken);
    apiRequestCount += resolved.apiRequests;
    const targetResolutionErrors = resolved.resolutionErrors || [];
    if (!resumeUsesFrozenTargets) {
      summary.unresolvedTargetReferences = targetResolutionErrors.length;
      checkpoint.targetResolutionErrors = targetResolutionErrors;
    } else if (
      retainedResolutionErrors.length
      && !Array.isArray(checkpoint.targetResolutionErrors)
    ) {
      checkpoint.targetResolutionErrors = retainedResolutionErrors;
    }
    summary.errors.push(...targetResolutionErrors);
    const broadExcludedKeys = new Set(
      (resolved.excludedSources || []).map(sourceKey)
    );
    summary.locallyExcludedOrders = resumeUsesFrozenTargets
      ? Math.max(
        Number(summary.locallyExcludedOrders || 0),
        broadExcludedKeys.size
      )
      : broadExcludedKeys.size;
    const localSources = uniqueSources(resolved.sources);
    const localPresenceSources = resumeUsesFrozenTargets
      ? await listLocalScmReconciliationSources({
        kind: scope === "PO" || scope === "TO"
          ? scope
          : scope === "order_family"
            ? normalizeKind(run.targetOrderKind)
            : "",
        includeTerminalOrders: true
      })
      : localSources;
    const localKeys = new Set(localPresenceSources.map(sourceKey));
    checkpoint.phase = "fetch_sources";
    checkpoint.total = reusableTargets.length || localSources.length;
    await updateRunCheckpoint(run.id, checkpoint);

    if (await operationalWorkIsRunning(operationalSyncRunning)) {
      summary.yielded = true;
      return finishOwnedRun({
        status: "interrupted",
        summary,
        checkpoint,
        error: "Yielded to active operational NetSuite synchronization.",
        apiRequestCount
      });
    }

    const targetOnly = scope === "order_family"
      || resumeUsesFrozenTargets;
    const fetchKind = scope === "PO" || scope === "TO"
      ? scope
      : targetOnly
        ? normalizeKind(run.targetOrderKind)
        : "";
    const trackedIds = localSources.map((source) => source.id);
    const fetched = [];
    const fetchSourceBatch = async (options) => {
      if (await operationalWorkIsRunning(operationalSyncRunning)) {
        const error = new Error("Yielded to active operational NetSuite synchronization.");
        error.code = "SCM_RECONCILIATION_YIELD";
        throw error;
      }
      const rows = await fetchPoToReconciliationOrdersFromNetSuite(options);
      apiRequestCount += 1;
      await assertScmReconciliationRunActive(run.id, workerLeaseToken);
      fetched.push(...(rows || []));
    };
    if (targetOnly && !trackedIds.length) {
      // A resumed run can already have every durable target completed.
    } else if (targetOnly || trackedIds.length <= 200) {
      await fetchSourceBatch({
        orderIds: trackedIds,
        kind: fetchKind,
        modifiedSince: settings.initialBackfillModifiedSince || "2026-01-01",
        includeOpen: !targetOnly,
        targetOnly
      });
    } else {
      // Discover all open/recent orders once, then fetch older tracked sources
      // in bounded exact-ID batches. This avoids an oversized SuiteQL IN list
      // while still retaining indefinite local history.
      await fetchSourceBatch({
        orderIds: [],
        kind: fetchKind,
        modifiedSince: settings.initialBackfillModifiedSince || "2026-01-01",
        includeOpen: true,
        targetOnly: false
      });
      for (let offset = 0; offset < trackedIds.length; offset += 200) {
        await fetchSourceBatch({
          orderIds: trackedIds.slice(offset, offset + 200),
          kind: fetchKind,
          modifiedSince: settings.initialBackfillModifiedSince || "2026-01-01",
          includeOpen: false,
          targetOnly: true
        });
      }
    }
    await assertScmReconciliationRunActive(run.id, workerLeaseToken);
    const ordersByKey = new Map();
    for (const fetchedOrder of fetched || []) {
      const order = normalizeFetchedOrder(fetchedOrder);
      if (!order) continue;
      if (broadExcludedKeys.has(sourceKey(order))) continue;
      ordersByKey.set(sourceKey(order), order);
    }
    summary.discoveredOrders = resumeUsesFrozenTargets
      ? Math.max(
        Number(summary.discoveredOrders || 0),
        ordersByKey.size + reconciledCompletedTargets.length
      )
      : ordersByKey.size;

    const missingSources = [];
    for (const source of localSources) {
      checkpoint.phase = "direct_lookup";
      checkpoint.source = source;
      await updateRunCheckpoint(run.id, checkpoint);
      if (ordersByKey.has(sourceKey(source))) continue;
      if (await operationalWorkIsRunning(operationalSyncRunning)) {
        summary.yielded = true;
        checkpoint.phase = "direct_lookup";
        checkpoint.source = source;
        return finishOwnedRun({
          status: "interrupted",
          summary,
          checkpoint,
          error: "Yielded to active operational NetSuite synchronization.",
          apiRequestCount
        });
      }
      const direct = await directFetchSource(source);
      apiRequestCount += direct.apiRequests;
      await assertScmReconciliationRunActive(run.id, workerLeaseToken);
      if (direct.order) {
        ordersByKey.set(sourceKey(source), direct.order);
        continue;
      }
      missingSources.push(source);
    }

    const allSources = uniqueSources([
      ...localSources,
      ...[...ordersByKey.values()].map((order) => ({
        kind: order.kind,
        id: order.id,
        tranid: order.tranid
      }))
    ]);
    let totalRunTargets = reusableTargets.length || allSources.length;
    summary.sourceOrders = totalRunTargets;
    checkpoint.total = totalRunTargets;
    await initializeScmReconciliationRunTargets(run.id, allSources, {
      replacePendingManifest: resumeRequested && !resumeUsesFrozenTargets,
      workerLeaseToken
    });
    if (!resumeUsesFrozenTargets) {
      totalRunTargets = (
        await listScmReconciliationRunTargetsForResume(run.id)
      ).length;
      summary.sourceOrders = totalRunTargets;
      checkpoint.total = totalRunTargets;
    }
    checkpoint.targetManifestComplete = true;
    checkpoint.targetManifestCount = totalRunTargets;
    await updateRunCheckpoint(run.id, checkpoint, apiRequestCount);

    let missingProcessed = completedTargets.length + failedTargets.length;
    for (const source of missingSources) {
      const reviewDecision = reviewDecisions.get(sourceKey(source));
      if (reviewDecision?.reviewDecision === "skip") {
        summary.decisionSkippedOrders += 1;
        await updateOwnedRunTarget(source, {
          status: "skipped",
          result: {
            reviewDecision: "skip",
            reviewDecisionNote: reviewDecision.reviewDecisionNote,
            proposalRunId: run.resumeOfRunId,
            reason: "Skipped by the reviewed dry-run decision; local order data was not changed."
          },
          checkpoint: { skippedAt: new Date().toISOString() }
        });
        missingProcessed += 1;
        checkpoint.processed = missingProcessed;
        await updateRunCheckpoint(
          run.id,
          checkpoint,
          apiRequestCount,
          summary
        );
        continue;
      }
      if (reviewDecision?.reviewDecision === "keep_review") {
        summary.decisionKeptReviewOrders += 1;
      }
      await updateOwnedRunTarget(source, { status: "running" });
      try {
        const sourceName = reconciliationSourceName(run.triggerSource);
        const missing = await withTransaction(async () => {
          await assertScmReconciliationMutationAllowed(
            run.id,
            workerLeaseToken
          );
          let outcome;
          if (effectiveDryRun) {
            await ensureMissingOrderState(source, sourceName, run.id);
            outcome = await recordDryRunMissingLookup(source, sourceName, run.id);
          } else {
            outcome = await recordScmReconciliationMissingLookup(source, {
              sourceName,
              runId: run.id
            });
          }
          const confirmedMissing = Number(outcome.missing_success_count || 0) >= 2;
          await updateOwnedRunTarget(source, {
            status: confirmedMissing ? "review" : "skipped",
            proposedChange: {
              reconciliationStatus: confirmedMissing ? "missing" : "pending",
              reason: confirmedMissing
                ? "The order was absent from two successful direct NetSuite lookups."
                : "One successful direct NetSuite lookup did not find the order."
            },
            result: {
              missingLookupCount: Number(outcome.missing_success_count || 0),
              dryRun: effectiveDryRun
            }
          });
          return outcome;
        });
        const confirmed = Number(missing.missing_success_count || 0) >= 2;
        if (confirmed) {
          summary.missingConfirmed += 1;
        } else {
          summary.missingFirstLookup += 1;
        }
      } catch (error) {
        if (
          error?.code === "SCM_RECONCILIATION_CANCEL_REQUESTED"
          || error?.code === "SCM_RECONCILIATION_LEASE_LOST"
        ) {
          throw error;
        }
        summary.failedOrders += 1;
        summary.errors.push({
          orderKind: source.kind,
          orderId: source.id,
          orderRef: source.tranid,
          error: text(error?.message || error)
        });
        await updateOwnedRunTarget(source, {
          status: "failed",
          error: text(error?.message || error)
        });
      }
      missingProcessed += 1;
      checkpoint.processed = missingProcessed;
      await updateRunCheckpoint(
        run.id,
        checkpoint,
        apiRequestCount,
        summary
      );
    }

    const fetchedOrders = [...ordersByKey.values()].sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.id - right.id
    );
    const fetchedIds = fetchedOrders.map((order) => order.id);
    const fetchedOrdersById = new Map(
      fetchedOrders.map((order) => [order.id, order])
    );
    const authoritativeLinkedSnapshot = run.triggerSource !== "webhook";
    let processed = completedTargets.length + failedTargets.length + missingSources.length;
    let linkedProcessed = 0;
    if (fetchedIds.length && authoritativeLinkedSnapshot) {
      checkpoint.phase = "fetch_linked_transactions";
      checkpoint.processedSourceOrders = 0;
      checkpoint.totalSourceOrders = fetchedIds.length;
      delete checkpoint.source;
      await updateRunCheckpoint(run.id, checkpoint);
      await fetchScmReconciliationLinkedTransactionsInBatches(fetchedIds, {
        beforeAttempt: async () => {
          await assertScmReconciliationRunActive(run.id, workerLeaseToken);
          if (await operationalWorkIsRunning(operationalSyncRunning)) {
            const error = new Error(
              "Yielded to active operational NetSuite synchronization."
            );
            error.code = "SCM_RECONCILIATION_YIELD";
            throw error;
          }
        },
        onAttempt: async ({ orderIds, attempt, maxAttempts }) => {
          apiRequestCount += 1;
          checkpoint.phase = "fetch_linked_transactions";
          checkpoint.processedSourceOrders = linkedProcessed;
          checkpoint.linkedBatchOrderIds = orderIds;
          checkpoint.linkedBatchOrderRefs = orderIds
            .map((id) => fetchedOrdersById.get(id)?.tranid)
            .filter(Boolean);
          checkpoint.linkedBatchSize = orderIds.length;
          checkpoint.linkedBatchAttempt = attempt;
          checkpoint.linkedBatchMaxAttempts = maxAttempts;
          checkpoint.linkedBatchRetrying = false;
          await updateRunCheckpoint(
            run.id,
            checkpoint,
            apiRequestCount,
            summary
          );
        },
        onRetry: async ({ error }) => {
          checkpoint.linkedBatchRetrying = true;
          checkpoint.linkedBatchLastError = text(error?.message || error);
          await updateRunCheckpoint(
            run.id,
            checkpoint,
            apiRequestCount,
            summary
          );
        },
        onSplit: async ({ left, right, error }) => {
          checkpoint.linkedBatchRetrying = false;
          checkpoint.linkedBatchSplit = [left.length, right.length];
          checkpoint.linkedBatchLastError = text(error?.message || error);
          await updateRunCheckpoint(run.id, checkpoint, apiRequestCount);
        },
        onBatch: async ({
          orderIds,
          rows,
          processedOrderIds,
          batchStartedAt
        }) => {
          const linkedBySource = new Map();
          for (const transaction of rows || []) {
            const id = positiveId(transaction.sourceOrderId);
            if (!id) continue;
            if (!linkedBySource.has(id)) linkedBySource.set(id, []);
            linkedBySource.get(id).push(transaction);
          }
          checkpoint.phase = "reconcile";
          checkpoint.processedSourceOrders = linkedProcessed;
          for (const orderId of orderIds) {
            const order = fetchedOrdersById.get(orderId);
            if (!order) continue;
            await reconcileFetchedOrder(
              order,
              linkedBySource,
              batchStartedAt
            );
          }
          linkedProcessed = processedOrderIds.length;
          checkpoint.phase = "fetch_linked_transactions";
          checkpoint.processedSourceOrders = linkedProcessed;
          delete checkpoint.source;
          await updateRunCheckpoint(run.id, checkpoint, apiRequestCount);
        }
      });
    } else if (fetchedOrders.length) {
      checkpoint.phase = "reconcile";
      await updateRunCheckpoint(run.id, checkpoint, apiRequestCount);
      const linkedBySource = new Map();
      for (const order of fetchedOrders) {
        await reconcileFetchedOrder(order, linkedBySource, null);
      }
    }

    checkpoint.phase = "reconcile";
    delete checkpoint.processedSourceOrders;
    delete checkpoint.totalSourceOrders;
    delete checkpoint.linkedBatchOrderIds;
    delete checkpoint.linkedBatchOrderRefs;
    delete checkpoint.linkedBatchSize;
    delete checkpoint.linkedBatchAttempt;
    delete checkpoint.linkedBatchMaxAttempts;
    delete checkpoint.linkedBatchRetrying;
    delete checkpoint.linkedBatchSplit;
    delete checkpoint.linkedBatchLastError;
    await updateRunCheckpoint(
      run.id,
      checkpoint,
      apiRequestCount,
      summary
    );

    async function reconcileFetchedOrder(
      order,
      linkedBySource,
      linkedSnapshotStartedAt
    ) {
      const source = { kind: order.kind, id: order.id, tranid: order.tranid };
      const reviewDecision = reviewDecisions.get(sourceKey(source));
      checkpoint.source = source;
      checkpoint.processed = processed;
      await updateRunCheckpoint(run.id, checkpoint);
      if (await operationalWorkIsRunning(operationalSyncRunning)) {
        const error = new Error(
          "Yielded to active operational NetSuite synchronization."
        );
        error.code = "SCM_RECONCILIATION_YIELD";
        throw error;
      }
      if (reviewDecision?.reviewDecision === "skip") {
        summary.decisionSkippedOrders += 1;
        await updateOwnedRunTarget(source, {
          status: "skipped",
          result: {
            reviewDecision: "skip",
            reviewDecisionNote: reviewDecision.reviewDecisionNote,
            proposalRunId: run.resumeOfRunId,
            reason: "Skipped by the reviewed dry-run decision; local order data was not changed."
          },
          checkpoint: { skippedAt: new Date().toISOString() }
        });
        processed += 1;
        checkpoint.processed = processed;
        await updateRunCheckpoint(run.id, checkpoint, apiRequestCount, summary);
        return;
      }
      await updateOwnedRunTarget(source, { status: "running" });
      try {
        const recovered = !localKeys.has(sourceKey(source));
        for (const line of order.lines || []) exactLineKey(line);
        const sourceName = reconciliationSourceName(run.triggerSource);
        const applied = await withTransaction(async () => {
          await query("SET LOCAL lock_timeout = '30s'");
          await query("SET LOCAL statement_timeout = '5min'");
          await assertScmReconciliationMutationAllowed(
            run.id,
            workerLeaseToken
          );
          let linkedSnapshot = { stored: 0, deleted: 0 };
          if (authoritativeLinkedSnapshot) {
            linkedSnapshot = await storeLinkedScmReconciliationTransactions({
              order,
              transactions: linkedBySource.get(order.id) || [],
              source: sourceName,
              runId: run.id,
              authoritativeObservedBefore: linkedSnapshotStartedAt
            });
          }
          // A dry run records authoritative proposals and IF/IR evidence only.
          // It must not change the operational PO/TO source tables before an
          // administrator approves the initial proposal.
          let preflightReviewReason = "";
          let acceptedReviewDecision = false;
          let decisionEvidenceChanged = false;
          let acceptedPreflight = null;
          if (!effectiveDryRun && !order.headerOnlyFallback) {
            // Source synchronization can resize PO split children. Preflight the
            // authoritative snapshot first so a planned/operational/pinned split
            // reaches Reconcile Review without changing that existing plan.
            const preflight = await reconcileScmOrderFamily({
              kind: order.kind,
              sourceOrderId: order.id,
              source: sourceName,
              runId: run.id,
              dryRun: true,
              recovered,
              authoritativeOrder: order
            });
            acceptedPreflight = preflight;
            if (reviewDecision?.reviewDecision === "accept_current") {
              const reviewedEvidenceVersion = Number(
                reviewDecision.proposedChange?.evidenceVersion || 1
              );
              const exactMatch = scmReconciliationReviewFingerprint(preflight, {
                evidenceVersion: reviewedEvidenceVersion
              })
                === reviewDecision.reviewDecisionFingerprint;
              const resolvedConflictMatch = preflight.reconciliationStatus !== "review"
                && scmReconciliationReviewFingerprint(preflight, {
                  includeReason: false,
                  evidenceVersion: reviewedEvidenceVersion
                }) === scmReconciliationReviewFingerprint(
                  reviewDecision.proposedChange,
                  {
                    includeReason: false,
                    evidenceVersion: reviewedEvidenceVersion
                  }
                );
              if (exactMatch || resolvedConflictMatch) {
                acceptedReviewDecision = true;
                await syncFetchedSourceOrder(order);
              } else {
                decisionEvidenceChanged = true;
                preflightReviewReason = [
                  "The saved Accept NetSuite outcome decision was not applied because the current NetSuite evidence differs from the reviewed dry run.",
                  preflight.reason
                ].filter(Boolean).join(" ");
              }
            } else if (preflight.reconciliationStatus === "review") {
              preflightReviewReason = preflight.reason
                || "The authoritative NetSuite snapshot requires reconciliation review before source synchronization.";
            } else {
              await syncFetchedSourceOrder(order);
            }
          } else if (
            !effectiveDryRun
            && reviewDecision?.reviewDecision === "accept_current"
          ) {
            decisionEvidenceChanged = true;
            preflightReviewReason = "The saved Accept NetSuite outcome decision was not applied because NetSuite did not return a full line snapshot.";
          }
          if (!effectiveDryRun) await clearScmReconciliationMissingLookup(source);
          let result = await reconcileScmOrderFamily({
            kind: order.kind,
            sourceOrderId: order.id,
            source: sourceName,
            runId: run.id,
            dryRun: effectiveDryRun,
            recovered,
            authoritativeOrder: order,
            explicitReviewReason: preflightReviewReason
          });
          if (
            !effectiveDryRun
            && acceptedReviewDecision
            && result.reconciliationStatus === "review"
          ) {
            const reviewedEvidenceVersion = Number(
              reviewDecision.proposedChange?.evidenceVersion || 1
            );
            const postSyncMatchesAcceptedReview =
              scmReconciliationReviewFingerprint(result, {
                evidenceVersion: reviewedEvidenceVersion
              }) === scmReconciliationReviewFingerprint(acceptedPreflight, {
                evidenceVersion: reviewedEvidenceVersion
              });
            if (postSyncMatchesAcceptedReview) {
              const resolution = await resolveScmReconciliationReview({
                kind: order.kind,
                orderRef: order.tranid,
                resolution: "accept_current",
                note: `Pre-apply dry-run decision: ${reviewDecision.reviewDecisionNote}`,
                actor: reviewDecision.reviewDecidedBy,
                actorRole: "admin",
                reviewCode: "reconciliation_conflict"
              });
              if (Number(resolution.remainingOpenCases || 0) === 0) {
                result = {
                  ...result,
                  applicationStatus: result.calculatedApplicationStatus
                    || result.applicationStatus,
                  reconciliationStatus: "current",
                  reason: "",
                  reviewDecisionApplied: "accept_current",
                  reviewDecisionNote: reviewDecision.reviewDecisionNote,
                  proposalRunId: run.resumeOfRunId
                };
              } else {
                acceptedReviewDecision = false;
                result = {
                  ...result,
                  reviewDecisionApplied: "",
                  reviewDecisionNote: reviewDecision.reviewDecisionNote,
                  proposalRunId: run.resumeOfRunId,
                  reason: [
                    "The accepted dry-run conflict was resolved, but another reconciliation review remains open.",
                    result.reason
                  ].filter(Boolean).join(" ")
                };
              }
            } else {
              decisionEvidenceChanged = true;
              acceptedReviewDecision = false;
              result = {
                ...result,
                reviewDecisionApplied: "",
                reviewDecisionNote: reviewDecision.reviewDecisionNote,
                proposalRunId: run.resumeOfRunId,
                decisionEvidenceChanged: true,
                reason: [
                  "The accepted dry-run conflict changed while the live result was being synchronized, so the order remains in Reconcile Review.",
                  result.reason
                ].filter(Boolean).join(" ")
              };
            }
          } else if (reviewDecision?.reviewDecision) {
            result = {
              ...result,
              reviewDecisionApplied: acceptedReviewDecision
                ? "accept_current"
                : reviewDecision.reviewDecision === "keep_review"
                  ? "keep_review"
                  : "",
              reviewDecisionNote: reviewDecision.reviewDecisionNote,
              proposalRunId: run.resumeOfRunId,
              decisionEvidenceChanged
            };
          }
          await updateOwnedRunTarget(source, {
            status: result.reconciliationStatus === "review" ? "review" : "succeeded",
            proposedChange: effectiveDryRun ? result : {},
            result,
            checkpoint: { reconciledAt: new Date().toISOString() }
          });
          return {
            linkedSnapshot,
            result,
            acceptedReviewDecision,
            decisionEvidenceChanged
          };
        });
        summary.linkedTransactionsStored += Number(applied.linkedSnapshot.stored || 0);
        summary.linkedTransactionsDeleted += Number(applied.linkedSnapshot.deleted || 0);
        const result = applied.result;
        summary.reconciledOrders += 1;
        if (recovered) summary.recoveredOrders += 1;
        if (applied.acceptedReviewDecision) summary.decisionAcceptedOrders += 1;
        if (applied.decisionEvidenceChanged) summary.decisionChangedOrders += 1;
        if (reviewDecision?.reviewDecision === "keep_review") {
          summary.decisionKeptReviewOrders += 1;
        }
        if (result.reconciliationStatus === "review") summary.reviewOrders += 1;
      } catch (error) {
        if (
          error?.code === "SCM_RECONCILIATION_CANCEL_REQUESTED"
          || error?.code === "SCM_RECONCILIATION_LEASE_LOST"
        ) {
          throw error;
        }
        summary.failedOrders += 1;
        summary.errors.push({
          orderKind: source.kind,
          orderId: source.id,
          orderRef: source.tranid,
          error: text(error?.message || error)
        });
        await updateOwnedRunTarget(source, {
          status: "failed",
          error: text(error?.message || error),
          checkpoint: { failedAt: new Date().toISOString() }
        });
      }
      processed += 1;
      checkpoint.processed = processed;
      await updateRunCheckpoint(run.id, checkpoint, apiRequestCount, summary);
    }

    checkpoint.phase = "complete";
    checkpoint.processed = totalRunTargets;
    checkpoint.total = totalRunTargets;
    checkpoint.resumeRequested = false;
    delete checkpoint.source;
    const failed = summary.failedOrders > 0;
    const awaitingInitialApproval = !failed
      && effectiveDryRun
      && !settings.initialDryRunApprovedAt
      && normalizeScope(run.scope) === "all";
    return finishOwnedRun({
      status: failed
        ? "failed"
        : awaitingInitialApproval
          ? "awaiting_approval"
          : "succeeded",
      summary,
      checkpoint,
      error: failed
        ? `${summary.failedOrders} PO/TO order(s) could not be reconciled.`
        : "",
      apiRequestCount
    });
  } catch (error) {
    if (
      error?.code === "SCM_RECONCILIATION_CANCEL_REQUESTED"
      || error?.code === "SCM_RECONCILIATION_LEASE_LOST"
    ) {
      const current = await loadRun(run.id);
      if (current.status === "running" && current.cancelRequestedAt) {
        return finishOwnedRun({
          status: "cancelled",
          summary: {
            ...summary,
            stopped: true,
            stoppedBy: current.cancelRequestedBy || ""
          },
          checkpoint,
          error: current.cancelRequestNote || "Stopped by an administrator.",
          apiRequestCount
        });
      }
      return current;
    }
    if (error?.code === "SCM_RECONCILIATION_YIELD") {
      summary.yielded = true;
      return finishOwnedRun({
        status: "interrupted",
        summary,
        checkpoint,
        error: text(error.message),
        apiRequestCount
      });
    }
    if (
      error?.code === "SCM_RECONCILIATION_LINKED_TIMEOUT"
      || error?.code === "NETSUITE_REQUEST_TIMEOUT"
    ) {
      const linkedLookup = text(checkpoint.phase) === "fetch_linked_transactions";
      const sourceOrderId = positiveId(error?.sourceOrderId);
      const sourceOrderRef = sourceOrderId
        ? text(checkpoint.linkedBatchOrderRefs?.[0])
        : "";
      const reason = [
        text(error?.message || error),
        linkedLookup
          ? sourceOrderRef || sourceOrderId
            ? `The unfinished IF / IR lookup can be resumed from ${sourceOrderRef || `order ID ${sourceOrderId}`}.`
            : "The unfinished IF / IR lookup can be resumed."
          : "The unfinished NetSuite reconciliation lookup can be resumed."
      ].filter(Boolean).join(" ");
      checkpoint.resumable = true;
      checkpoint.interruptionCode = "NETSUITE_REQUEST_TIMEOUT";
      checkpoint.interruptedAt = new Date().toISOString();
      summary.yielded = true;
      summary.errors.push({
        error: text(error?.message || error),
        code: "NETSUITE_REQUEST_TIMEOUT",
        sourceOrderId,
        sourceOrderRef
      });
      return finishOwnedRun({
        status: "interrupted",
        summary,
        checkpoint,
        error: reason,
        apiRequestCount
      });
    }
    summary.errors.push({ error: text(error?.message || error) });
    return finishOwnedRun({
      status: "failed",
      summary,
      checkpoint,
      error: text(error?.message || error),
      apiRequestCount
    });
  } finally {
    await stopRunHeartbeat();
  }
}

/**
 * Executes a queued reconciliation run. Calls within this Node process are
 * serialized, while the migration's partial unique index protects deployments
 * with more than one application process.
 */
export function executeScmReconciliationRun(runOrId, options = {}) {
  return serialExecution(() => executeRunCore(runOrId, options));
}

/**
 * Creates and immediately executes a manual/nightly/targeted reconciliation.
 * By default the returned object is the final persisted run. HTTP entry points
 * may pass background=true to receive the durable queued row immediately.
 */
export async function startScmReconciliationRun(input = {}, options = {}) {
  const scope = normalizeScope(input.scope);
  const settings = await getScmReconciliationSettings();
  const initialAllDryRun = !settings.initialDryRunApprovedAt && scope === "all";
  const requestedDryRun = input.dryRun ?? input.dry_run;
  const dryRun = initialAllDryRun
    ? true
    : requestedDryRun === undefined
      ? !settings.initialDryRunApprovedAt
      : booleanValue(requestedDryRun);
  const targetOrderKind = normalizeKind(
    input.targetOrderKind ?? input.orderKind ?? input.target_order_kind
  );
  const targetOrderId = positiveId(input.targetOrderId ?? input.orderId ?? input.target_order_id);
  const targetOrderRefs = scope === "order_family"
    ? normalizeScmReconciliationTargetRefs(
      input.targetOrderRefs ?? input.orderRefs ?? input.target_order_refs ?? input.order_refs,
      input.targetOrderRef ?? input.orderRef ?? input.target_order_ref
    )
    : [];
  const targetOrderRef = targetOrderRefs.join(",");
  const includeTerminalOrders = booleanValue(
    input.includeTerminalOrders ?? input.include_terminal_orders,
    false
  );
  if (scope === "order_family" && (!targetOrderKind || (!targetOrderId && !targetOrderRef))) {
    throw Object.assign(
      new Error("Select a PO/TO order family by transaction number or internal ID."),
      { status: 400 }
    );
  }
  if (scope === "order_family" && targetOrderId && targetOrderRefs.length > 1) {
    throw Object.assign(
      new Error("A numeric internal ID cannot be combined with multiple source order references."),
      { status: 400 }
    );
  }
  const run = await createScmReconciliationRun({
    triggerSource: normalizeTrigger(input.triggerSource ?? input.trigger_source),
    scope,
    targetOrderKind: targetOrderKind || null,
    targetOrderId,
    targetOrderRef,
    includeTerminalOrders,
    dryRun,
    applyUnambiguous: !dryRun && settings.initialDryRunApprovedAt
      ? booleanValue(input.applyUnambiguous, true)
      : false,
    requestedBy: text(input.requestedBy ?? input.actor ?? input.requested_by)
  });
  if (options.background === true) {
    void executeScmReconciliationRun(run, options).catch((error) => {
      console.error(`Background PO/TO reconciliation run ${run.id} failed:`, error);
    });
    return run;
  }
  return executeScmReconciliationRun(run, options);
}

/**
 * Resumes the unfinished targets of an interrupted run under the same run ID.
 * Terminal target rows are the durable checkpoint; they are never fetched or
 * applied again. The one batch that was in flight is intentionally repeated.
 */
export async function resumeScmReconciliationRun(
  runId,
  actor,
  options = {}
) {
  const run = await queueScmReconciliationRunResume(runId, actor);
  const executionOptions = {
    ...options,
    // An interrupted initial dry-run Apply must remain a live apply when it
    // resumes; otherwise the initial-safeguard branch would convert it back to
    // proposal-only mode.
    allowInitialApply: options.allowInitialApply === true
      || Boolean(run.resumeOfRunId)
  };
  const executeResume = async () => {
    const completedRun = await executeScmReconciliationRun(
      run,
      executionOptions
    );
    if (completedRun.status === "succeeded" && run.resumeOfRunId) {
      const proposalRun = await loadRun(run.resumeOfRunId);
      if (
        proposalRun.status === "awaiting_approval"
        && normalizeScope(proposalRun.scope) === "all"
      ) {
        await approveInitialScmReconciliationRun(proposalRun.id, actor);
      }
    }
    return completedRun;
  };
  if (options.background === true) {
    if (run.status === "queued") {
      void executeResume().catch((error) => {
        console.error(`Background PO/TO reconciliation resume ${run.id} failed:`, error);
      });
    }
    return run;
  }
  return run.status === "queued"
    ? executeResume()
    : run;
}

/**
 * Applies a completed dry-run scope by executing a fresh linked live run.
 * Stored proposal snapshots are never written directly because NetSuite may
 * have changed after the dry run. The initial company-wide safeguard is
 * approved only after its linked all-scope live run succeeds.
 */
export async function applyScmReconciliationRun(
  runId,
  actor,
  options = {}
) {
  const proposalRun = await loadRun(runId);
  const scope = normalizeScope(proposalRun.scope);
  const initialCompanyWideApply = scope === "all"
    && proposalRun.status === "awaiting_approval";
  const eligibleStatus = proposalRun.status === "succeeded"
    || initialCompanyWideApply;
  if (proposalRun.dryRun !== true || !eligibleStatus) {
    throw Object.assign(
      new Error("Only a completed dry run can be applied."),
      { status: 409 }
    );
  }
  let appliedRun = await withTransaction(async () => {
    const lockedProposalResult = await query(
      `SELECT *
         FROM scm_reconciliation_runs
        WHERE id = $1
        FOR UPDATE`,
      [proposalRun.id]
    );
    const lockedProposal = lockedProposalResult.rows[0]
      ? mapRunRow(lockedProposalResult.rows[0])
      : null;
    const lockedInitialCompanyWideApply = normalizeScope(lockedProposal?.scope) === "all"
      && lockedProposal?.status === "awaiting_approval";
    if (
      lockedProposal?.dryRun !== true
      || !(
        lockedProposal.status === "succeeded"
        || lockedInitialCompanyWideApply
      )
    ) {
      throw Object.assign(
        new Error("Only a completed dry run can be applied."),
        { status: 409 }
      );
    }

    const previousApplyResult = await query(
      `SELECT *
         FROM scm_reconciliation_runs
        WHERE resume_of_run_id = $1
          AND dry_run = false
          AND status IN ('queued', 'running', 'succeeded')
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [proposalRun.id]
    );
    if (previousApplyResult.rows[0]) {
      return mapRunRow(previousApplyResult.rows[0]);
    }

    await assertScmReconciliationRunReadyToApply(proposalRun.id);
    const createdApply = await createScmReconciliationRun({
      triggerSource: "manual",
      scope,
      targetOrderKind: proposalRun.targetOrderKind || null,
      targetOrderId: proposalRun.targetOrderId,
      targetOrderRef: proposalRun.targetOrderRef,
      includeTerminalOrders: proposalRun.includeTerminalOrders,
      dryRun: false,
      applyUnambiguous: true,
      requestedBy: text(actor)
    });
    const linked = await query(
      `UPDATE scm_reconciliation_runs
          SET resume_of_run_id = $2,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [createdApply.id, proposalRun.id]
    );
    return mapRunRow(linked.rows[0] || createdApply);
  });
  if (appliedRun?.status === "running") {
    return {
      applied: false,
      approved: false,
      pending: true,
      approvedRun: null,
      applyRun: appliedRun
    };
  }
  if (appliedRun.status === "queued") {
    if (options.background === true) {
      void (async () => {
        const completedRun = await executeScmReconciliationRun(appliedRun, {
          ...options,
          background: false,
          allowInitialApply: true
        });
        if (completedRun.status === "succeeded" && initialCompanyWideApply) {
          await approveInitialScmReconciliationRun(runId, actor);
        }
      })().catch((error) => {
        console.error(`Background PO/TO reconciliation apply ${appliedRun.id} failed:`, error);
      });
      return {
        applied: false,
        approved: false,
        pending: true,
        approvedRun: null,
        applyRun: appliedRun
      };
    }
    appliedRun = await executeScmReconciliationRun(appliedRun, {
      ...options,
      allowInitialApply: true
    });
  }
  if (appliedRun.status !== "succeeded") {
    return {
      applied: false,
      approved: false,
      pending: false,
      approvedRun: null,
      applyRun: appliedRun
    };
  }
  const approvedRun = initialCompanyWideApply
    ? await approveInitialScmReconciliationRun(runId, actor)
    : null;
  return {
    applied: true,
    approved: Boolean(approvedRun),
    pending: false,
    approvedRun,
    applyRun: appliedRun
  };
}

export async function applyInitialScmReconciliationRun(
  runId,
  actor,
  options = {}
) {
  const proposalRun = await loadRun(runId);
  if (
    proposalRun.status !== "awaiting_approval"
    || proposalRun.dryRun !== true
    || normalizeScope(proposalRun.scope) !== "all"
  ) {
    throw Object.assign(
      new Error("Only the awaiting company-wide initial dry run can be applied."),
      { status: 409 }
    );
  }
  return applyScmReconciliationRun(runId, actor, options);
}

export async function retryScmReconciliationOrder(
  {
    kind = "",
    orderId = null,
    orderRef = "",
    actor = "",
    includeTerminalOrders = false
  } = {},
  options = {}
) {
  const orderKind = normalizeKind(kind);
  if (!orderKind) {
    throw Object.assign(new Error("Select PO or TO to retry reconciliation."), { status: 400 });
  }
  const source = await findScmReconciliationSource({
    kind: orderKind,
    orderId: positiveId(orderId),
    orderRef: text(orderRef)
  });
  const exclusionCandidate = source || (positiveId(orderId)
    ? { kind: orderKind, id: positiveId(orderId), tranid: text(orderRef).toUpperCase() }
    : null);
  if (exclusionCandidate && !booleanValue(includeTerminalOrders)) {
    const excludedKeys = new Set(
      (await listScmReconciliationBroadExcludedSources({ kind: orderKind }))
        .map(sourceKey)
    );
    if (excludedKeys.has(sourceKey(exclusionCandidate))) {
      throw Object.assign(
        new Error(
          `${exclusionCandidate.tranid || orderRef || orderId} is locally terminal or skipped. `
          + "An Admin can run it explicitly from PO / TO Schedule Reconciliation."
        ),
        {
          status: 409,
          code: "SCM_RECONCILIATION_LOCALLY_EXCLUDED"
        }
      );
    }
  }
  return startScmReconciliationRun({
    triggerSource: "manual",
    scope: "order_family",
    targetOrderKind: orderKind,
    targetOrderId: positiveId(orderId),
    targetOrderRef: text(orderRef).toUpperCase(),
    includeTerminalOrders: booleanValue(includeTerminalOrders),
    dryRun: false,
    applyUnambiguous: true,
    requestedBy: text(actor)
  }, options);
}

/**
 * Turns an accepted, non-stale IF/IR snapshot into a targeted reconciliation.
 * A duplicate retries only when its previous targeted run failed/interrupted.
 */
export async function processScmIfIrWebhookResult(
  stored = {},
  options = {}
) {
  if (
    !stored?.ok
    || stored.ignored
    || stored.stale
    || !normalizeKind(stored.sourceOrderKind)
    || !positiveId(stored.sourceOrderId)
  ) {
    return {
      ok: stored?.ok !== false,
      reconciled: false,
      reason: stored?.ignored
        ? stored.reason || "ignored"
        : stored?.stale
          ? "stale"
          : "no_source_order"
    };
  }
  if (stored.duplicate) {
    const previous = await query(
      `SELECT status
         FROM scm_reconciliation_runs
        WHERE trigger_source = 'webhook'
          AND scope_kind = 'order_family'
          AND target_order_kind = $1
          AND target_order_netsuite_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [normalizeKind(stored.sourceOrderKind), positiveId(stored.sourceOrderId)]
    );
    const previousStatus = text(previous.rows[0]?.status);
    if (["queued", "running", "awaiting_approval", "succeeded"].includes(previousStatus)) {
      return { ok: true, reconciled: previousStatus === "succeeded", reason: "duplicate" };
    }
    // If the first delivery was recorded but its targeted run never started or
    // ended interrupted/failed, a duplicate delivery is a safe retry signal.
  }
  const webhookSource = {
    kind: normalizeKind(stored.sourceOrderKind),
    id: positiveId(stored.sourceOrderId),
    tranid: text(stored.sourceOrderRef).toUpperCase()
  };
  const locallyExcluded = new Set(
    (await listScmReconciliationBroadExcludedSources({
      kind: webhookSource.kind
    })).map(sourceKey)
  );
  if (locallyExcluded.has(sourceKey(webhookSource))) {
    return {
      ok: true,
      reconciled: false,
      reason: "locally_excluded",
      sourceOrderKind: webhookSource.kind,
      sourceOrderId: webhookSource.id,
      sourceOrderRef: webhookSource.tranid
    };
  }
  const settings = await getScmReconciliationSettings();
  const run = await startScmReconciliationRun({
    triggerSource: "webhook",
    scope: "order_family",
    targetOrderKind: stored.sourceOrderKind,
    targetOrderId: stored.sourceOrderId,
    targetOrderRef: stored.sourceOrderRef,
    // Preserve the fast, full webhook snapshot without applying operational
    // schedule changes before the initial company-wide dry run is approved.
    dryRun: !settings.initialDryRunApprovedAt,
    applyUnambiguous: Boolean(settings.initialDryRunApprovedAt),
    requestedBy: "netsuite"
  }, options);
  return { ok: true, reconciled: run.status === "succeeded", run };
}

export function scmReconciliationTorontoClock(
  now = new Date(),
  timeZone = TORONTO_TIME_ZONE
) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new Error("A valid date is required.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
  return {
    localDate: `${values.year}-${values.month}-${values.day}`,
    localTime: `${values.hour}:${values.minute}`
  };
}

/**
 * A cheap timer callback intended to run once per minute. It catches up after
 * the configured time, but persists a Toronto local date only after a
 * successful nightly run.
 */
export async function scmReconciliationNightlyTick({
  now = new Date(),
  operationalSyncRunning
} = {}) {
  if (nightlyTickInProgress) return { started: false, reason: "tick_in_progress" };
  nightlyTickInProgress = true;
  try {
    const settings = await getScmReconciliationSettings();
    if (!settings.nightlyEnabled) return { started: false, reason: "disabled" };
    if (!settings.initialDryRunApprovedAt) {
      return { started: false, reason: "initial_dry_run_not_approved" };
    }
    const clock = scmReconciliationTorontoClock(now, settings.timeZone || TORONTO_TIME_ZONE);
    if (clock.localTime < settings.nightlyTime) {
      return { started: false, reason: "before_scheduled_time", ...clock };
    }
    if (text(settings.lastNightlyLocalDate).slice(0, 10) === clock.localDate) {
      return { started: false, reason: "already_ran", ...clock };
    }
    if (lastNightlyAttemptLocalDate === clock.localDate) {
      return { started: false, reason: "already_attempted", ...clock };
    }
    if (await operationalWorkIsRunning(operationalSyncRunning)) {
      return { started: false, reason: "operational_sync_running", ...clock };
    }
    const active = await query(
      `SELECT id
         FROM scm_reconciliation_runs
        WHERE status IN ('queued', 'running')
        LIMIT 1`
    );
    if (active.rows[0]) {
      return { started: false, reason: "reconciliation_active", ...clock };
    }
    lastNightlyAttemptLocalDate = clock.localDate;
    const run = await startScmReconciliationRun({
      triggerSource: "nightly",
      scope: "all",
      dryRun: false,
      applyUnambiguous: true,
      requestedBy: "nightly"
    }, { operationalSyncRunning });
    if (run.status === "succeeded") {
      await markScmReconciliationNightlyRun(clock.localDate);
    } else if (run.status === "interrupted") {
      // A yielded run did not consume the nightly opportunity; retry after
      // operational synchronization releases the NetSuite request slot.
      lastNightlyAttemptLocalDate = "";
    }
    return { started: true, ...clock, run };
  } finally {
    nightlyTickInProgress = false;
  }
}
