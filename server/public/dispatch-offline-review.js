const offlineReviewApp = document.getElementById("dispatchOfflineReviewApp");
const offlineReviewT = (key, fallback) => window.MBBS_I18N?.t?.(key, fallback) || fallback;
const OFFLINE_REVIEW_COUNT_ENDPOINT = "/api/dispatch/offline-review/count";
const OFFLINE_REVIEW_LIST_ENDPOINT = "/api/dispatch/offline-review";
const DRIVER_PWA_STOPS_ENDPOINT = "/api/dispatch/driver-pwa/stops";
const DRIVER_OFFLINE_OPEN_STATUSES = new Set([
  "registered",
  "waiting_photos",
  "pending",
  "applying",
  "review_required",
  "blocked",
  "resolution_pending"
]);

let offlineReviewOperator = null;
let driverPwaSurface = "stops";
let driverPwaStopsDate = driverPwaTorontoDate();
let driverPwaStops = [];
let driverPwaClientSyncIssues = [];
let driverPwaSelectedStopId = "";
let driverPwaStopsLoading = false;
let driverPwaReopening = false;
let driverPwaStopsError = "";
let driverPwaStopsRequest = 0;
let offlineReviewFilter = "open";
let offlineReviewCases = [];
let offlineReviewClientSyncIssues = [];
let offlineReviewSelectedId = "";
let offlineReviewDetailPayload = null;
let offlineReviewListLoading = false;
let offlineReviewDetailLoading = false;
let offlineReviewResolving = false;
let offlineReviewRetrying = false;
let offlineReviewDismissingDeviceSessionId = "";
let offlineReviewDeviceDismissOpenId = "";
let offlineReviewListError = "";
let offlineReviewDetailError = "";
let offlineReviewNotice = { message: "", tone: "" };
let offlineReviewListRequest = 0;
let offlineReviewDetailRequest = 0;
let offlineReviewEventSource = null;
let offlineReviewEventTimer = null;
const offlineReviewDrafts = new Map();
const offlineReviewResolutionAttempts = new Map();
const offlineReviewRetryAttempts = new Map();
const offlineReviewDeviceDismissDrafts = new Map();
const driverPwaReopenDrafts = new Map();
const driverPwaReopenAttempts = new Map();

function driverPwaTorontoDate() {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (values.year && values.month && values.day) return `${values.year}-${values.month}-${values.day}`;
  } catch {
    // Fall back to the browser date if the requested IANA timezone is unavailable.
  }
  const local = new Date();
  const offset = local.getTimezoneOffset() * 60000;
  return new Date(local.getTime() - offset).toISOString().slice(0, 10);
}

function offlineReviewEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function offlineReviewObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function offlineReviewFirst(record, ...keys) {
  const source = offlineReviewObject(record);
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
  }
  return "";
}

function offlineReviewArray(value) {
  return Array.isArray(value) ? value : [];
}

function driverPwaStopRecord(value) {
  const source = offlineReviewObject(value);
  return offlineReviewObject(source.stop || source.record || source.jobRecord || source.job_record || source);
}

function driverPwaStopId(value) {
  const record = driverPwaStopRecord(value);
  return String(offlineReviewFirst(record, "recordId", "record_id", "stopRecordId", "stop_record_id", "id") || "");
}

function driverPwaExpectedStateHash(value) {
  const record = driverPwaStopRecord(value);
  return String(offlineReviewFirst(record, "expectedStateHash", "expected_state_hash", "stateHash", "state_hash") || "");
}

function driverPwaExtractStops(payload) {
  if (Array.isArray(payload)) return payload;
  const source = offlineReviewObject(payload);
  return offlineReviewArray(source.stops || source.records || source.items || source.jobs);
}

function driverPwaExtractClientSyncIssues(payload) {
  const source = offlineReviewObject(payload);
  return offlineReviewArray(
    source.clientSyncIssues
    || source.client_sync_issues
    || source.syncIssues
    || source.sync_issues
  );
}

function offlineReviewDeviceIssueId(value) {
  return String(offlineReviewFirst(value, "sessionId", "session_id") || "");
}

function offlineReviewDeviceDismissDraft(sessionId) {
  if (!offlineReviewDeviceDismissDrafts.has(sessionId)) {
    offlineReviewDeviceDismissDrafts.set(sessionId, { auditNote: "", confirmed: false });
  }
  return offlineReviewDeviceDismissDrafts.get(sessionId);
}

function offlineReviewCaptureDeviceDismissDrafts() {
  offlineReviewApp.querySelectorAll("[data-form='device-sync-dismiss']").forEach((form) => {
    const sessionId = String(form.dataset.sessionId || "");
    if (!sessionId) return;
    offlineReviewDeviceDismissDrafts.set(sessionId, {
      auditNote: String(form.elements.auditNote?.value || ""),
      confirmed: Boolean(form.elements.confirmDismiss?.checked)
    });
  });
}

function offlineReviewDeviceDismissForm(sessionId) {
  return [...offlineReviewApp.querySelectorAll("[data-form='device-sync-dismiss']")]
    .find((form) => String(form.dataset.sessionId || "") === String(sessionId || "")) || null;
}

function driverPwaStopStatus(value) {
  const record = driverPwaStopRecord(value);
  return String(offlineReviewFirst(record, "status", "recordStatus", "record_status", "jobStatus", "job_status") || "completed")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_");
}

function driverPwaStopStatusLabel(value) {
  const status = driverPwaStopStatus(value);
  return status.split("_").filter(Boolean).map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`).join(" ") || "Completed";
}

function driverPwaStopStatusTone(value) {
  const status = driverPwaStopStatus(value);
  if (status.includes("reopen") || status.includes("undo")) return "blocked";
  if (status.includes("complete") || status.includes("deliver") || status.includes("receive")) return "resolved";
  return "";
}

function driverPwaStopJob(value, kind) {
  const record = driverPwaStopRecord(value);
  const payload = offlineReviewObject(record.payload);
  if (kind === "current") {
    return offlineReviewObject(record.currentJob || record.current_job || record.currentStop || record.current_stop
      || payload.currentJob || payload.current_job || payload.currentStop || payload.current_stop);
  }
  return offlineReviewObject(record.recordedJob || record.recorded_job || record.completedJob || record.completed_job
    || record.job || payload.recordedJob || payload.recorded_job || payload.job || record);
}

function driverPwaStopLocation(value, kind = "recorded") {
  const record = driverPwaStopRecord(value);
  const job = driverPwaStopJob(record, kind);
  const direct = kind === "current"
    ? offlineReviewFirst(record, "currentLocation", "current_location", "currentStopLocation", "current_stop_location")
    : offlineReviewFirst(record, "recordedLocation", "recorded_location", "stopLocation", "stop_location", "location");
  return direct || offlineReviewFirst(job,
    "location", "locationName", "location_name", "stopLocation", "stop_location", "address",
    "pickupLocation", "pickup_location", "fromLocation", "from_location", "from",
    "dropLocation", "drop_location", "toLocation", "to_location", "to", "destination");
}

function driverPwaStopBlocks(value) {
  const record = driverPwaStopRecord(value);
  const raw = record.blockReasons || record.block_reasons || record.blockingReasons || record.blocking_reasons
    || record.reopenBlockReasons || record.reopen_block_reasons
    || record.reopenBlocks || record.reopen_blocks || record.reasons;
  if (Array.isArray(raw)) {
    return raw.map((entry) => offlineReviewDisplayValue(entry)).filter((entry) => entry && entry !== "—");
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).filter(([, active]) => Boolean(active)).map(([reason]) => offlineReviewEventLabel(reason));
  }
  return raw ? [String(raw)] : [];
}

function driverPwaStopCanReopen(value) {
  const record = driverPwaStopRecord(value);
  const explicit = offlineReviewFirst(record, "canReopen", "can_reopen", "reopenAllowed", "reopen_allowed");
  if (explicit !== "") return explicit === true || explicit === 1 || String(explicit).toLowerCase() === "true";
  return Boolean(driverPwaExpectedStateHash(record)) && driverPwaStopBlocks(record).length === 0;
}

function driverPwaStopDraft(recordId) {
  const key = String(recordId || "");
  if (!driverPwaReopenDrafts.has(key)) driverPwaReopenDrafts.set(key, { auditNote: "", confirmed: false });
  return driverPwaReopenDrafts.get(key);
}

function driverPwaCaptureStopDraft() {
  const form = offlineReviewApp.querySelector("[data-form='driver-pwa-reopen']");
  if (!form || !driverPwaSelectedStopId) return;
  driverPwaReopenDrafts.set(driverPwaSelectedStopId, {
    auditNote: String(form.elements.auditNote?.value || ""),
    confirmed: Boolean(form.elements.confirmReopen?.checked)
  });
}

function offlineReviewCaseRecord(value = offlineReviewDetailPayload) {
  const payload = offlineReviewObject(value);
  return offlineReviewObject(payload.case || payload.review || payload.event || payload.record || payload);
}

function offlineReviewCaseId(value) {
  const record = offlineReviewCaseRecord(value);
  return String(offlineReviewFirst(record, "eventId", "event_id", "caseId", "case_id", "id") || "");
}

function offlineReviewStatus(value) {
  const record = offlineReviewCaseRecord(value);
  return String(offlineReviewFirst(record, "status", "reviewStatus", "review_status") || "review_required")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_");
}

function offlineReviewStatusLabel(value) {
  const status = offlineReviewStatus(value);
  return status.split("_").filter(Boolean).map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`).join(" ") || "Review required";
}

function offlineReviewDefaultReason(value) {
  switch (offlineReviewStatus(value)) {
    case "registered": return "The event is registered; evidence receipts may still be arriving.";
    case "waiting_photos": return "The event is waiting for durable photo receipts.";
    case "pending": return "The event is queued for server processing.";
    case "applying": return "The server is applying this event.";
    case "blocked": return "The event is blocked behind an earlier record that needs review.";
    case "resolution_pending": return "A Dispatch resolution is being applied.";
    default: return "Plan changed after this event was recorded.";
  }
}

function offlineReviewIsResolved(value) {
  const status = offlineReviewStatus(value);
  return ["resolved", "applied", "evidence_only", "closed", "completed", "suppressed"].some((part) => status.includes(part));
}

function offlineReviewIsOpen(value) {
  return DRIVER_OFFLINE_OPEN_STATUSES.has(offlineReviewStatus(value));
}

function offlineReviewCanResolve(value) {
  return offlineReviewStatus(value) === "review_required";
}

function offlineReviewStatusTone(value) {
  const status = offlineReviewStatus(value);
  if (offlineReviewIsResolved(value)) return "resolved";
  if (status.includes("blocked") || status.includes("conflict")) return "blocked";
  return "";
}

function offlineReviewFormatDateTime(value) {
  if (!value) return "—";
  return window.MBBS_I18N?.displayDateTime?.(value) || String(value);
}

function offlineReviewFormatPlanDate(value) {
  const text = String(value || "");
  if (!text) return "—";
  return window.MBBS_I18N?.displayDate?.(text) || text;
}

function offlineReviewFormatBytes(value) {
  if (value === undefined || value === null || value === "") return "—";
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function offlineReviewShortId(value) {
  const text = String(value || "");
  if (text.length <= 14) return text || "—";
  return `${text.slice(0, 8)}…${text.slice(-5)}`;
}

function offlineReviewDisplayValue(value) {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) {
    return value.map((entry) => offlineReviewDisplayValue(entry)).filter((entry) => entry !== "—").join(", ") || "—";
  }
  if (typeof value === "object") {
    const object = offlineReviewObject(value);
    const preferred = offlineReviewFirst(object, "label", "name", "displayName", "address", "orderRef", "id");
    if (preferred) return String(preferred);
    try {
      return JSON.stringify(object);
    } catch {
      return "—";
    }
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function offlineReviewBoolean(value) {
  return value === true || value === 1 || String(value || "").trim().toLowerCase() === "true";
}

function offlineReviewCompactDetails(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value.slice(0, 3000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 3000);
  } catch {
    return String(value).slice(0, 3000);
  }
}

function offlineReviewResultCount(value) {
  if (Array.isArray(value)) return value.length;
  const number = Number(value?.count ?? value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function offlineReviewErrorText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(offlineReviewFirst(value, "message", "error", "errorMessage", "error_message", "code") || "");
}

function offlineReviewEventLabel(value) {
  const text = String(value || "offline event").replaceAll("-", "_");
  return text.split("_").filter(Boolean).map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`).join(" ");
}

function offlineReviewVersion(record = offlineReviewCaseRecord()) {
  const value = offlineReviewFirst(record, "caseVersion", "case_version", "version");
  if (value === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function offlineReviewCandidates(record = offlineReviewCaseRecord()) {
  const payload = offlineReviewObject(offlineReviewDetailPayload);
  return offlineReviewArray(record.candidates || payload.candidates);
}

function offlineReviewPhotos(record = offlineReviewCaseRecord()) {
  const payload = offlineReviewObject(offlineReviewDetailPayload);
  const evidence = offlineReviewObject(record.evidence || payload.evidence);
  return offlineReviewArray(record.photos || payload.photos || evidence.photos);
}

function offlineReviewTimeline(record = offlineReviewCaseRecord()) {
  const payload = offlineReviewObject(offlineReviewDetailPayload);
  return offlineReviewArray(record.timeline || payload.timeline).slice().sort((left, right) => {
    const leftTime = new Date(offlineReviewFirst(left, "at", "createdAt", "occurredAt", "receivedAt")).getTime();
    const rightTime = new Date(offlineReviewFirst(right, "at", "createdAt", "occurredAt", "receivedAt")).getTime();
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
    return leftTime - rightTime;
  });
}

async function offlineReviewApi(path, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }
  if (!response.ok) {
    const error = new Error(payload.error || payload.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload.code || "";
    error.payload = payload;
    throw error;
  }
  return payload;
}

function offlineReviewExtractCases(payload) {
  const source = offlineReviewObject(payload);
  const cases = offlineReviewArray(source.cases || source.reviews || source.events || source.items);
  return cases.filter((item) => offlineReviewFilter === "resolved"
    ? offlineReviewIsResolved(item)
    : offlineReviewIsOpen(item));
}

async function offlineReviewBroadcastCount() {
  try {
    const payload = await offlineReviewApi(OFFLINE_REVIEW_COUNT_ENDPOINT);
    const count = Number(payload.count ?? payload.pendingCount ?? payload.unresolvedCount ?? 0);
    if (!Number.isFinite(count) || count < 0) return;
    window.dispatchEvent(new CustomEvent("mbbs-offline-review-count-updated", {
      detail: { count: Math.floor(count) }
    }));
  } catch {
    // The list remains usable even if the navigation badge cannot refresh.
  }
}

function driverPwaSelectedStop() {
  return driverPwaStops.find((item) => driverPwaStopId(item) === driverPwaSelectedStopId) || null;
}

async function driverPwaLoadStops({ keepSelection = false, quiet = false } = {}) {
  const requestId = ++driverPwaStopsRequest;
  driverPwaStopsLoading = true;
  driverPwaStopsError = "";
  if (!quiet) offlineReviewRender();
  try {
    const query = new URLSearchParams({ date: driverPwaStopsDate, limit: "200" });
    const payload = await offlineReviewApi(`${DRIVER_PWA_STOPS_ENDPOINT}?${query}`);
    if (requestId !== driverPwaStopsRequest) return;
    driverPwaStops = driverPwaExtractStops(payload);
    driverPwaClientSyncIssues = driverPwaExtractClientSyncIssues(payload);
    const selectionExists = driverPwaStops.some((item) => driverPwaStopId(item) === driverPwaSelectedStopId);
    if (!keepSelection || !selectionExists) driverPwaSelectedStopId = driverPwaStopId(driverPwaStops[0]);
  } catch (error) {
    if (requestId !== driverPwaStopsRequest) return;
    driverPwaStopsError = error.message;
    if (!driverPwaStops.length) driverPwaSelectedStopId = "";
  } finally {
    if (requestId !== driverPwaStopsRequest) return;
    driverPwaStopsLoading = false;
    offlineReviewRender();
  }
}

async function offlineReviewLoadDetail(eventId = offlineReviewSelectedId, { quiet = false } = {}) {
  const selectedId = String(eventId || "");
  const requestId = ++offlineReviewDetailRequest;
  offlineReviewDetailPayload = null;
  offlineReviewDetailError = "";
  if (!selectedId) {
    offlineReviewDetailLoading = false;
    offlineReviewRender();
    return;
  }
  offlineReviewDetailLoading = true;
  if (!quiet) offlineReviewRender();
  try {
    const payload = await offlineReviewApi(`${OFFLINE_REVIEW_LIST_ENDPOINT}/${encodeURIComponent(selectedId)}`);
    if (requestId !== offlineReviewDetailRequest || selectedId !== offlineReviewSelectedId) return;
    offlineReviewDetailPayload = payload;
  } catch (error) {
    if (requestId !== offlineReviewDetailRequest) return;
    offlineReviewDetailError = error.message;
  } finally {
    if (requestId === offlineReviewDetailRequest) {
      offlineReviewDetailLoading = false;
      offlineReviewRender();
    }
  }
}

async function offlineReviewLoadList({ keepSelection = false, quiet = false } = {}) {
  const requestId = ++offlineReviewListRequest;
  offlineReviewListLoading = true;
  offlineReviewListError = "";
  if (!quiet) offlineReviewRender();
  try {
    const query = new URLSearchParams({ status: offlineReviewFilter, limit: "100" });
    const payload = await offlineReviewApi(`${OFFLINE_REVIEW_LIST_ENDPOINT}?${query}`);
    if (requestId !== offlineReviewListRequest) return;
    offlineReviewCases = offlineReviewExtractCases(payload);
    offlineReviewClientSyncIssues = driverPwaExtractClientSyncIssues(payload);
    const selectionExists = offlineReviewCases.some((item) => offlineReviewCaseId(item) === offlineReviewSelectedId);
    if (!keepSelection || !selectionExists) {
      offlineReviewSelectedId = offlineReviewCaseId(offlineReviewCases[0]);
    }
  } catch (error) {
    if (requestId !== offlineReviewListRequest) return;
    offlineReviewCases = [];
    offlineReviewClientSyncIssues = [];
    offlineReviewSelectedId = "";
    offlineReviewListError = error.message;
  } finally {
    if (requestId !== offlineReviewListRequest) return;
    offlineReviewListLoading = false;
    offlineReviewRender();
  }
  await Promise.all([
    offlineReviewLoadDetail(offlineReviewSelectedId, { quiet: true }),
    offlineReviewBroadcastCount()
  ]);
}

function offlineReviewRenderList() {
  if (offlineReviewListLoading && !offlineReviewCases.length) {
    return `<div class="offline-review-empty">Loading review cases…</div>`;
  }
  if (offlineReviewListError) {
    return `<div class="offline-review-empty error" role="alert">${offlineReviewEscape(offlineReviewListError)}</div>`;
  }
  if (!offlineReviewCases.length) {
    return `<div class="offline-review-empty">${offlineReviewFilter === "resolved"
      ? "No resolved offline conflicts."
      : offlineReviewClientSyncIssues.length
        ? "No server-side review cases. The device sync issues above still need attention."
        : "No open synchronization records."}</div>`;
  }
  return offlineReviewCases.map((item) => {
    const record = offlineReviewCaseRecord(item);
    const eventId = offlineReviewCaseId(record);
    const eventType = offlineReviewFirst(record, "eventType", "event_type", "type");
    const driver = offlineReviewFirst(record, "driverLogin", "driver_login", "driverName", "driver_name") || "Driver";
    const planDate = offlineReviewFirst(record, "planDate", "plan_date");
    const reason = offlineReviewFirst(record, "reason", "reviewReason", "review_reason", "conflictCode", "conflict_code")
      || offlineReviewDefaultReason(record);
    const occurredAt = offlineReviewFirst(record, "occurredAt", "occurred_at", "deviceOccurredAt", "device_occurred_at");
    const photoCount = Number(offlineReviewFirst(record, "photoCount", "photo_count") || 0);
    const selected = eventId === offlineReviewSelectedId;
    return `
      <button class="offline-review-case ${selected ? "selected" : ""}" data-action="select-case" data-event-id="${offlineReviewEscape(eventId)}" type="button" aria-pressed="${selected ? "true" : "false"}">
        <span class="offline-review-case-head">
          <strong>${offlineReviewEscape(driver)} · ${offlineReviewEscape(offlineReviewEventLabel(eventType))}</strong>
          <span class="offline-review-pill ${offlineReviewStatusTone(record)}">${offlineReviewEscape(offlineReviewStatusLabel(record))}</span>
        </span>
        <span class="offline-review-case-meta">
          <span>${offlineReviewEscape(offlineReviewFormatPlanDate(planDate))}</span>
          <span>${offlineReviewEscape(offlineReviewFormatDateTime(occurredAt))}</span>
        </span>
        <span class="offline-review-case-reason">${offlineReviewEscape(reason)}</span>
        <span class="offline-review-case-foot">
          <span class="offline-review-case-id" title="${offlineReviewEscape(eventId)}">${offlineReviewEscape(offlineReviewShortId(eventId))}</span>
          <span>${photoCount} photo${photoCount === 1 ? "" : "s"}</span>
        </span>
      </button>
    `;
  }).join("");
}

function offlineReviewSummaryItem(label, value) {
  return `
    <div class="offline-review-summary-item">
      <span>${offlineReviewEscape(label)}</span>
      <strong>${offlineReviewEscape(offlineReviewDisplayValue(value))}</strong>
    </div>
  `;
}

function offlineReviewMergedJob(job) {
  const source = offlineReviewObject(job);
  return {
    ...offlineReviewObject(source.snapshot),
    ...source
  };
}

function offlineReviewJobRows(job) {
  const source = offlineReviewMergedJob(job);
  const orderRefs = offlineReviewFirst(source, "orderRefs", "order_refs", "orders", "orderReferences");
  const rows = [
    ["Job ID", offlineReviewFirst(source, "jobId", "job_id", "id")],
    ["Load", offlineReviewFirst(source, "loadName", "load_name", "loadLabel", "load_label", "load")],
    ["Stop", offlineReviewFirst(source, "label", "stopLabel", "stop_label", "name", "stopType", "stop_type", "type")],
    ["Location", offlineReviewFirst(source, "location", "locationName", "location_name", "address")],
    ["Driver", offlineReviewFirst(source, "driverLogin", "driver_login", "driverName", "driver_name", "driver")],
    ["Truck", offlineReviewFirst(source, "truckPlate", "truck_plate", "truckId", "truck_id", "truck")],
    ["From", offlineReviewFirst(source, "from", "fromLocation", "from_location", "pickup", "pickupLocation")],
    ["To", offlineReviewFirst(source, "to", "toLocation", "to_location", "drop", "dropLocation", "destination")],
    ["Orders", orderRefs],
    ["Fingerprint", offlineReviewFirst(source, "fingerprint", "jobFingerprint", "job_fingerprint")],
    ["Predecessor", offlineReviewFirst(source, "predecessorFingerprint", "predecessor_fingerprint")]
  ];
  return rows.map(([label, value]) => `
    <div class="offline-review-job-row">
      <span>${offlineReviewEscape(label)}</span>
      <strong>${offlineReviewEscape(offlineReviewDisplayValue(value))}</strong>
    </div>
  `).join("");
}

function offlineReviewRenderJobCard(title, job, emptyMessage) {
  if (!job || typeof job !== "object") {
    return `
      <article class="offline-review-job-card">
        <header><strong>${offlineReviewEscape(title)}</strong></header>
        <div class="offline-review-empty">${offlineReviewEscape(emptyMessage)}</div>
      </article>
    `;
  }
  return `
    <article class="offline-review-job-card">
      <header>
        <strong>${offlineReviewEscape(title)}</strong>
        <span class="offline-review-pill">${offlineReviewEscape(offlineReviewShortId(offlineReviewFirst(offlineReviewMergedJob(job), "jobId", "job_id", "id")))}</span>
      </header>
      <div class="offline-review-job-rows">${offlineReviewJobRows(job)}</div>
    </article>
  `;
}

function offlineReviewRenderCandidates(record) {
  const candidates = offlineReviewCandidates(record);
  if (!candidates.length) return "";
  return `
    <section class="offline-review-section">
      <h3>Validated current candidates</h3>
      <div class="offline-review-candidates">
        ${candidates.map((candidate) => {
          const jobId = offlineReviewFirst(candidate, "jobId", "job_id", "id");
          const compatible = candidate.compatible !== false;
          return `
            <div class="offline-review-candidate ${compatible ? "" : "incompatible"}">
              <div>
                <strong>${offlineReviewEscape(offlineReviewFirst(candidate, "label", "name") || `Job ${offlineReviewShortId(jobId)}`)}</strong>
                <span>${offlineReviewEscape(jobId)} · predecessor ${offlineReviewEscape(offlineReviewShortId(offlineReviewFirst(candidate, "predecessorFingerprint", "predecessor_fingerprint")))}</span>
              </div>
              <span class="offline-review-pill ${compatible ? "resolved" : "blocked"}">${compatible ? "Compatible" : "Not compatible"}</span>
            </div>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function offlineReviewRenderPhotos(record) {
  const photos = offlineReviewPhotos(record);
  if (!photos.length) {
    return `
      <section class="offline-review-section">
        <h3>Evidence photos</h3>
        <div class="offline-review-empty">No photos are attached to this event.</div>
      </section>
    `;
  }
  return `
    <section class="offline-review-section">
      <h3>Evidence photos</h3>
      <div class="offline-review-photos">
        ${photos.map((photo, index) => {
          const photoId = String(offlineReviewFirst(photo, "photoId", "photo_id", "id") || "");
          const photoStatus = String(offlineReviewFirst(photo, "status", "photoStatus", "photo_status") || "registered")
            .trim()
            .toLowerCase()
            .replaceAll("-", "_")
            .replaceAll(" ", "_");
          const objectReference = String(offlineReviewFirst(photo, "objectReference", "object_reference") || "").trim();
          const durable = photoStatus === "durably_received" || offlineReviewBoolean(
            offlineReviewFirst(photo, "durableReceipt", "durable_receipt", "durablyReceived", "durably_received")
          );
          const canOpen = Boolean(photoId && durable && objectReference);
          const verification = offlineReviewObject(
            photo.verification
            || photo.verificationResult
            || photo.verification_result
            || photo.lastVerificationError
            || photo.last_verification_error
          );
          const rawError = photo.verificationError
            || photo.verification_error
            || photo.lastVerificationError
            || photo.last_verification_error
            || photo.error
            || verification.error
            || "";
          const errorRecord = offlineReviewObject(rawError);
          const errorCode = offlineReviewFirst(
            photo,
            "verificationErrorCode",
            "verification_error_code",
            "lastVerificationErrorCode",
            "last_verification_error_code"
          ) || offlineReviewFirst(verification, "code", "errorCode", "error_code")
            || offlineReviewFirst(errorRecord, "code", "errorCode", "error_code");
          const errorMessage = (typeof rawError === "string" ? rawError : "")
            || offlineReviewFirst(
              photo,
              "verificationErrorMessage",
              "verification_error_message",
              "lastVerificationErrorMessage",
              "last_verification_error_message"
            )
            || offlineReviewFirst(verification, "message", "errorMessage", "error_message")
            || offlineReviewFirst(errorRecord, "message", "errorMessage", "error_message");
          const lastAttempt = offlineReviewFirst(
            photo,
            "lastVerificationAttemptAt",
            "last_verification_attempt_at",
            "verificationAttemptedAt",
            "verification_attempted_at"
          ) || offlineReviewFirst(verification, "attemptedAt", "attempted_at", "lastAttemptAt", "last_attempt_at");
          const attemptCount = offlineReviewFirst(
            photo,
            "verificationAttemptCount",
            "verification_attempt_count",
            "verificationAttempts",
            "verification_attempts"
          ) || offlineReviewFirst(verification, "attemptCount", "attempt_count", "attempts");
          const unavailableReason = durable
            ? ""
            : objectReference
              ? "The upload exists but has not passed durable server verification."
              : "The upload has not reached server storage and must come from the original Driver device.";
          return `
            <article class="offline-review-photo ${durable ? "durable" : "pending"}">
              <button class="offline-review-photo-preview" data-action="open-photo" data-photo-id="${offlineReviewEscape(photoId)}" type="button" title="${offlineReviewEscape(unavailableReason)}" ${canOpen ? "" : "disabled"}>
                ${canOpen ? `Open evidence ${index + 1}` : `Evidence ${index + 1} unavailable`}
              </button>
              <div class="offline-review-photo-meta">
                <span class="offline-review-photo-status ${durable ? "durable" : "pending"}">${offlineReviewEscape(offlineReviewEventLabel(photoStatus))}</span>
                <span>${offlineReviewEscape(offlineReviewFirst(photo, "mimeType", "mime_type") || "image")} · ${offlineReviewEscape(offlineReviewFormatBytes(offlineReviewFirst(photo, "byteSize", "byte_size", "bytes")))}</span>
                <span>Durable: ${durable ? "Yes" : "No"} · Object reference: ${objectReference ? "Present" : "Missing"}</span>
                ${attemptCount !== "" ? `<span>Verification attempts: ${offlineReviewEscape(attemptCount)}</span>` : ""}
                ${lastAttempt ? `<span>Last verification: ${offlineReviewEscape(offlineReviewFormatDateTime(lastAttempt))}</span>` : ""}
                ${errorMessage || errorCode ? `<span class="offline-review-photo-error"><strong>Verification error${errorCode ? ` (${offlineReviewEscape(errorCode)})` : ""}:</strong> ${offlineReviewEscape(errorMessage || "No error message was retained.")}</span>` : ""}
                ${!durable ? `<span class="offline-review-photo-guidance">${offlineReviewEscape(unavailableReason)}</span>` : ""}
                ${offlineReviewFirst(photo, "sha256", "sha") ? `<span>SHA ${offlineReviewEscape(offlineReviewShortId(offlineReviewFirst(photo, "sha256", "sha")))}</span>` : ""}
              </div>
            </article>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function offlineReviewRenderTimeline(record) {
  const entries = offlineReviewTimeline(record);
  if (!entries.length) {
    return `
      <section class="offline-review-section">
        <h3>Timeline</h3>
        <div class="offline-review-empty">No timeline entries are available.</div>
      </section>
    `;
  }
  return `
    <section class="offline-review-section">
      <h3>Timeline</h3>
      <div class="offline-review-timeline">
        ${entries.map((entry) => {
          const type = offlineReviewFirst(entry, "type", "eventType", "event_type") || "event";
          const status = String(offlineReviewFirst(entry, "status") || type).toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
          const at = offlineReviewFirst(entry, "at", "createdAt", "created_at", "occurredAt", "occurred_at", "receivedAt", "received_at");
          const actor = offlineReviewFirst(entry, "actor", "actorName", "actor_name");
          const note = offlineReviewFirst(entry, "note", "auditNote", "audit_note");
          const details = offlineReviewCompactDetails(entry.details);
          const safeTone = ["resolved", "applied", "review_required", "blocked"].includes(status) ? status : "";
          return `
            <article class="offline-review-timeline-item ${safeTone}">
              <div class="offline-review-timeline-head">
                <strong>${offlineReviewEscape(offlineReviewEventLabel(type))}</strong>
                <span class="offline-review-timeline-meta">${offlineReviewEscape(offlineReviewFormatDateTime(at))}</span>
              </div>
              <div class="offline-review-timeline-meta">${offlineReviewEscape(actor || offlineReviewStatusLabel(entry))}</div>
              ${note ? `<p class="offline-review-timeline-note">${offlineReviewEscape(note)}</p>` : ""}
              ${details ? `<pre class="offline-review-timeline-details">${offlineReviewEscape(details)}</pre>` : ""}
            </article>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function offlineReviewDraft(eventId) {
  const key = String(eventId || "");
  if (!offlineReviewDrafts.has(key)) {
    offlineReviewDrafts.set(key, {
      action: "apply_original",
      targetJobId: "",
      auditNote: "",
      confirmEvidenceOnly: false
    });
  }
  return offlineReviewDrafts.get(key);
}

function offlineReviewCaptureDraft() {
  const eventId = offlineReviewSelectedId;
  if (!eventId) return;
  const draft = offlineReviewDraft(eventId);
  const form = offlineReviewApp.querySelector(
    "[data-form='offline-review-resolution'], [data-form='offline-review-recovery']"
  );
  if (!form) return;
  draft.action = form.elements.action?.value || draft.action;
  draft.targetJobId = form.elements.targetJobId?.value || "";
  draft.auditNote = form.elements.auditNote?.value || "";
  draft.confirmEvidenceOnly = Boolean(form.elements.confirmEvidenceOnly?.checked);
}

function offlineReviewCanRecover(value) {
  return ["registered", "waiting_photos", "pending", "blocked"].includes(offlineReviewStatus(value));
}

function offlineReviewRecoveryCopy(record) {
  switch (offlineReviewStatus(record)) {
    case "registered":
      return {
        title: "Registered event needs recovery",
        help: "Retry checks for uploaded evidence and resumes processing. Any photo without an object reference must still be uploaded from the original Driver device.",
        retryLabel: "Retry verification and processing"
      };
    case "waiting_photos":
      return {
        title: "Photo verification is blocking the sequence",
        help: "Retry verifies uploaded photo objects again and resumes the Driver sequence if every required receipt becomes durable. Missing uploads can only come from the original Driver device.",
        retryLabel: "Retry verification and processing"
      };
    case "pending":
      return {
        title: "Event is waiting for server processing",
        help: "Retry asks the server to process this Driver sequence again. An earlier incomplete record may still need recovery first.",
        retryLabel: "Retry processing"
      };
    case "blocked":
      return {
        title: "Event is blocked by an earlier record",
        help: "Retry rechecks the Driver sequence. If the earlier record remains incomplete, resolve that earlier record before this one can continue.",
        retryLabel: "Retry processing"
      };
    default:
      return {
        title: "Synchronization recovery",
        help: "Retry the server-side synchronization state.",
        retryLabel: "Retry processing"
      };
  }
}

function offlineReviewRenderRecovery(record) {
  const eventId = offlineReviewCaseId(record);
  const draft = offlineReviewDraft(eventId);
  const copy = offlineReviewRecoveryCopy(record);
  const photos = offlineReviewPhotos(record);
  const photoCounts = photos.reduce((counts, photo) => {
    const status = String(offlineReviewFirst(photo, "status", "photoStatus", "photo_status") || "registered").toLowerCase();
    const objectReference = String(offlineReviewFirst(photo, "objectReference", "object_reference") || "").trim();
    const durable = status === "durably_received" || offlineReviewBoolean(
      offlineReviewFirst(photo, "durableReceipt", "durable_receipt", "durablyReceived", "durably_received")
    );
    if (durable) counts.durable += 1;
    else if (objectReference) counts.awaitingVerification += 1;
    else counts.missingUpload += 1;
    return counts;
  }, { durable: 0, awaitingVerification: 0, missingUpload: 0 });
  const busy = offlineReviewRetrying || offlineReviewResolving;
  const evidenceEligibility = offlineReviewFirst(record, "canResolveEvidenceOnly", "can_resolve_evidence_only");
  const canCloseEvidenceOnly = evidenceEligibility === "" ? true : offlineReviewBoolean(evidenceEligibility);
  return `
    <form class="offline-review-resolution offline-review-recovery" data-form="offline-review-recovery">
      <div class="offline-review-recovery-head">
        <div>
          <h3>${offlineReviewEscape(copy.title)}</h3>
          <p class="offline-review-resolution-help">${offlineReviewEscape(copy.help)}</p>
        </div>
        <button class="offline-review-retry-button" data-action="retry-case" type="button" ${busy ? "disabled" : ""}>${offlineReviewRetrying ? "Retrying…" : offlineReviewEscape(copy.retryLabel)}</button>
      </div>
      ${photos.length ? `
        <div class="offline-review-photo-summary">
          <strong>${photos.length} registered photo${photos.length === 1 ? "" : "s"}</strong>
          <span>${photoCounts.durable} durable · ${photoCounts.awaitingVerification} uploaded, awaiting verification · ${photoCounts.missingUpload} missing upload</span>
        </div>
      ` : ""}
      ${photoCounts.missingUpload ? `
        <div class="offline-review-device-required" role="alert">
          <strong>Original Driver device required for ${photoCounts.missingUpload} missing upload${photoCounts.missingUpload === 1 ? "" : "s"}.</strong>
          <span>Keep its browser data intact and ask the driver to open the Driver PWA while online and use Sync now. Dispatch cannot reconstruct photo bytes that never reached storage.</span>
        </div>
      ` : ""}
      <div class="offline-review-evidence-only-warning" role="alert">
        <strong>Last resort: close this event as evidence only</strong>
        <span>This preserves the event, available photos, and audit trail, but permanently prevents this saved event from changing route operations. Later records may then continue. Use it only after confirming the Driver upload cannot be recovered.</span>
        ${canCloseEvidenceOnly ? "" : "<span>The active-sync safety window has not elapsed yet. Retry first, then refresh shortly before using this fallback.</span>"}
      </div>
      <label class="offline-review-field">
        <span>Mandatory audit note</span>
        <textarea name="auditNote" maxlength="4000" required placeholder="Explain the retry attempts and why this incomplete event must be closed as evidence only.">${offlineReviewEscape(draft.auditNote)}</textarea>
      </label>
      <label class="offline-review-evidence-confirm">
        <input name="confirmEvidenceOnly" type="checkbox" required ${draft.confirmEvidenceOnly ? "checked" : ""} />
        <span>I confirmed the original Driver evidence cannot be recovered and understand this event will not apply operational changes.</span>
      </label>
      <div class="offline-review-resolution-actions">
        <span class="offline-review-resolution-help">Case version ${offlineReviewEscape(offlineReviewDisplayValue(offlineReviewVersion(record)))}</span>
        <button class="offline-review-evidence-submit" type="submit" ${busy || !canCloseEvidenceOnly ? "disabled" : ""}>${offlineReviewResolving ? "Closing…" : canCloseEvidenceOnly ? "Close as evidence only" : "Safety window active"}</button>
      </div>
    </form>
  `;
}

function offlineReviewReadOnlyMessage(record) {
  const status = offlineReviewStatus(record);
  if (status === "applying") {
    return {
      title: "Server application in progress",
      help: "The server is applying this event. Refresh to check the result; retry and resolution controls remain disabled to prevent duplicate operational effects."
    };
  }
  if (status === "resolution_pending") {
    return {
      title: "Resolution in progress",
      help: "A Dispatch resolution is already being applied. Refresh to check the result before taking any further action."
    };
  }
  return {
    title: `Read-only sync state: ${offlineReviewStatusLabel(record)}`,
    help: "This event cannot be changed in its current state. Refresh to retrieve its latest server status."
  };
}

function offlineReviewRenderResolution(record) {
  const eventId = offlineReviewCaseId(record);
  if (offlineReviewIsResolved(record)) {
    const resolution = offlineReviewObject(record.resolution || offlineReviewDetailPayload?.resolution);
    const action = offlineReviewFirst(resolution, "action") || offlineReviewStatusLabel(record);
    const note = offlineReviewFirst(resolution, "auditNote", "audit_note", "note");
    const actor = offlineReviewFirst(resolution, "resolvedBy", "resolved_by", "actor");
    const at = offlineReviewFirst(resolution, "resolvedAt", "resolved_at", "at");
    return `
      <div class="offline-review-resolved-banner">
        Resolved as ${offlineReviewEscape(offlineReviewEventLabel(action))}
        ${actor ? ` by ${offlineReviewEscape(actor)}` : ""}
        ${at ? ` on ${offlineReviewEscape(offlineReviewFormatDateTime(at))}` : ""}.
        ${note ? `<br />Audit note: ${offlineReviewEscape(note)}` : ""}
      </div>
    `;
  }

  if (offlineReviewCanRecover(record)) return offlineReviewRenderRecovery(record);

  if (!offlineReviewCanResolve(record)) {
    const readOnly = offlineReviewReadOnlyMessage(record);
    return `
      <div class="offline-review-pending-banner">
        <strong>${offlineReviewEscape(readOnly.title)}</strong>
        <span>${offlineReviewEscape(readOnly.help)}</span>
      </div>
    `;
  }

  const draft = offlineReviewDraft(eventId);
  const candidates = offlineReviewCandidates(record);
  const compatibleCandidates = candidates.filter((candidate) => candidate.compatible !== false);
  return `
    <form class="offline-review-resolution" data-form="offline-review-resolution">
      <div>
        <h3>Resolve conflict</h3>
        <p class="offline-review-resolution-help">A nonblank audit note is required. The server revalidates the selected stop and case version before applying side effects.</p>
      </div>
      <div class="offline-review-resolution-options">
        <label class="offline-review-resolution-option">
          <input name="action" type="radio" value="apply_original" ${draft.action === "apply_original" ? "checked" : ""} />
          <span>
            <strong>Apply to original job</strong>
            <span>Apply the event to the original operational job after server validation.</span>
          </span>
        </label>
        <label class="offline-review-resolution-option">
          <input name="action" type="radio" value="reattach" ${draft.action === "reattach" ? "checked" : ""} />
          <span>
            <strong>Reattach to current stop</strong>
            <span>Attach the evidence and event to a compatible current stop.</span>
          </span>
        </label>
        <label class="offline-review-resolution-option">
          <input name="action" type="radio" value="evidence_only" ${draft.action === "evidence_only" ? "checked" : ""} />
          <span>
            <strong>Close as evidence only</strong>
            <span>Keep the evidence and audit trail without operational side effects.</span>
          </span>
        </label>
      </div>
      <div class="offline-review-resolution-fields">
        ${draft.action === "reattach" ? `
          <label class="offline-review-field">
            <span>Validated current stop</span>
            <select name="targetJobId" required>
              <option value="">Select a compatible stop</option>
              ${compatibleCandidates.map((candidate) => {
                const jobId = String(offlineReviewFirst(candidate, "jobId", "job_id", "id") || "");
                const label = offlineReviewFirst(candidate, "label", "name") || `Job ${offlineReviewShortId(jobId)}`;
                return `<option value="${offlineReviewEscape(jobId)}" ${draft.targetJobId === jobId ? "selected" : ""}>${offlineReviewEscape(label)} · ${offlineReviewEscape(offlineReviewShortId(jobId))}</option>`;
              }).join("")}
            </select>
          </label>
        ` : `<div class="offline-review-resolution-help">${draft.action === "evidence_only" ? "No route state will be changed." : "The original job will be locked and validated again."}</div>`}
        <label class="offline-review-field">
          <span>Audit note</span>
          <textarea name="auditNote" maxlength="2000" required placeholder="Explain why this resolution is correct.">${offlineReviewEscape(draft.auditNote)}</textarea>
        </label>
      </div>
      <div class="offline-review-resolution-actions">
        <span class="offline-review-resolution-help">Case version ${offlineReviewEscape(offlineReviewDisplayValue(offlineReviewVersion(record)))}</span>
        <button class="offline-review-submit" type="submit" ${offlineReviewResolving || offlineReviewRetrying ? "disabled" : ""}>${offlineReviewResolving ? "Resolving…" : "Resolve and continue sequence"}</button>
      </div>
    </form>
  `;
}

function offlineReviewRenderDetail() {
  if (offlineReviewDetailLoading && !offlineReviewDetailPayload) {
    return `
      <section class="offline-review-panel offline-review-detail-panel">
        <div class="offline-review-empty">Loading case evidence…</div>
      </section>
    `;
  }
  if (offlineReviewDetailError) {
    return `
      <section class="offline-review-panel offline-review-detail-panel">
        <div class="offline-review-empty error" role="alert">${offlineReviewEscape(offlineReviewDetailError)}</div>
      </section>
    `;
  }
  if (!offlineReviewDetailPayload) {
    return `
      <section class="offline-review-panel offline-review-detail-panel">
        <div class="offline-review-empty">Select a conflict to review its evidence and timeline.</div>
      </section>
    `;
  }

  const record = offlineReviewCaseRecord();
  const eventId = offlineReviewCaseId(record);
  const payload = offlineReviewObject(record.payload);
  const originalJob = record.originalJob || record.original_job || payload.originalJob || payload.original_job;
  const currentJob = record.currentJob || record.current_job || payload.currentJob || payload.current_job;
  const driver = offlineReviewFirst(record, "driverLogin", "driver_login", "driverName", "driver_name");
  const planDate = offlineReviewFirst(record, "planDate", "plan_date");
  const eventType = offlineReviewFirst(record, "eventType", "event_type", "type");
  const reason = offlineReviewFirst(record, "reason", "reviewReason", "review_reason", "conflictCode", "conflict_code");
  const occurredAt = offlineReviewFirst(record, "occurredAt", "occurred_at", "deviceOccurredAt", "device_occurred_at")
    || offlineReviewFirst(payload, "occurredAt", "occurred_at");
  const receivedAt = offlineReviewFirst(record, "receivedAt", "received_at");
  const appliedAt = offlineReviewFirst(record, "appliedAt", "applied_at");
  const locationStatus = offlineReviewFirst(record, "locationStatus", "location_status")
    || offlineReviewFirst(payload, "locationStatus", "location_status");
  const clientSequence = offlineReviewFirst(record, "clientSequence", "client_sequence");
  const deviceId = offlineReviewFirst(record, "deviceId", "device_id");

  return `
    <section class="offline-review-panel offline-review-detail-panel">
      <div class="offline-review-panel-heading">
        <div>
          <h2>${offlineReviewEscape(driver || "Driver")} · ${offlineReviewEscape(offlineReviewEventLabel(eventType))}</h2>
          <p title="${offlineReviewEscape(eventId)}">${offlineReviewEscape(offlineReviewShortId(eventId))} · ${offlineReviewEscape(offlineReviewFormatPlanDate(planDate))}</p>
        </div>
        <div class="offline-review-heading-actions">
          <span class="offline-review-pill ${offlineReviewStatusTone(record)}">${offlineReviewEscape(offlineReviewStatusLabel(record))}</span>
          <button data-action="refresh-detail" type="button">Refresh</button>
        </div>
      </div>
      <div class="offline-review-detail-scroll">
        ${reason ? `<div class="offline-review-empty error"><strong>Dispatch review reason:</strong> ${offlineReviewEscape(reason)}</div>` : ""}
        <div class="offline-review-summary-grid">
          ${offlineReviewSummaryItem("Occurred on device", offlineReviewFormatDateTime(occurredAt))}
          ${offlineReviewSummaryItem("Received by server", offlineReviewFormatDateTime(receivedAt))}
          ${offlineReviewSummaryItem("Applied by server", appliedAt ? offlineReviewFormatDateTime(appliedAt) : "Not applied")}
          ${offlineReviewSummaryItem("Location verification", locationStatus || "—")}
          ${offlineReviewSummaryItem("Manifest", offlineReviewFirst(record, "manifestId", "manifest_id"))}
          ${offlineReviewSummaryItem("Device", deviceId)}
          ${offlineReviewSummaryItem("Client sequence", clientSequence)}
          ${offlineReviewSummaryItem("Case version", offlineReviewVersion(record))}
        </div>
        <section class="offline-review-section">
          <h3>Original versus current stop</h3>
          <div class="offline-review-comparison-grid">
            ${offlineReviewRenderJobCard("Original manifest stop", originalJob, "The original job snapshot is unavailable.")}
            ${offlineReviewRenderJobCard("Current dispatch stop", currentJob, "No current stop is attached. Choose a validated candidate or close as evidence only.")}
          </div>
        </section>
        ${offlineReviewRenderCandidates(record)}
        ${offlineReviewRenderPhotos(record)}
        ${offlineReviewRenderTimeline(record)}
        ${offlineReviewRenderResolution(record)}
      </div>
    </section>
  `;
}

function driverPwaStopLabel(value) {
  const record = driverPwaStopRecord(value);
  const job = driverPwaStopJob(record, "recorded");
  const explicit = offlineReviewFirst(record, "label", "stopLabel", "stop_label", "jobLabel", "job_label", "name")
    || offlineReviewFirst(job, "label", "stopLabel", "stop_label", "name");
  if (explicit) return explicit;
  const stopType = offlineReviewFirst(record, "stopType", "stop_type", "type")
    || offlineReviewFirst(job, "stopType", "stop_type", "type") || "stop";
  const reference = driverPwaStopOrderRefs(record)
    || offlineReviewFirst(record, "jobId", "job_id")
    || offlineReviewFirst(job, "jobId", "job_id", "id")
    || driverPwaStopId(record);
  return `${offlineReviewEventLabel(stopType)} · ${offlineReviewDisplayValue(reference)}`;
}

function driverPwaStopOrderRefs(value) {
  const record = driverPwaStopRecord(value);
  const job = driverPwaStopJob(record, "recorded");
  return offlineReviewFirst(record, "orderRefs", "order_refs", "orders", "orderReferences", "order_references", "orderRef", "order_ref")
    || offlineReviewFirst(job, "orderRefs", "order_refs", "orders", "orderReferences", "order_references", "orderRef", "order_ref");
}

function driverPwaStopTimes(value) {
  const record = driverPwaStopRecord(value);
  return {
    arrival: offlineReviewFirst(record, "arrivalAt", "arrival_at", "arrivedAt", "arrived_at", "startedAt", "started_at", "startAt", "start_at"),
    leave: offlineReviewFirst(record, "leaveAt", "leave_at", "leftAt", "left_at", "completedAt", "completed_at", "completionAt", "completion_at")
  };
}

function driverPwaRenderStopList() {
  if (driverPwaStopsLoading && !driverPwaStops.length) {
    return `<div class="offline-review-empty">Loading driver stops…</div>`;
  }
  const error = driverPwaStopsError
    ? `<div class="offline-review-empty error" role="alert">${offlineReviewEscape(driverPwaStopsError)}</div>`
    : "";
  if (!driverPwaStops.length) {
    return `${error}<div class="offline-review-empty">No recorded driver stops were found for ${offlineReviewEscape(offlineReviewFormatPlanDate(driverPwaStopsDate))}.</div>`;
  }
  return `${error}${driverPwaStops.map((item) => {
    const record = driverPwaStopRecord(item);
    const recordId = driverPwaStopId(record);
    const driver = offlineReviewFirst(record, "driverLogin", "driver_login", "driverName", "driver_name", "driver") || "Driver";
    const load = offlineReviewFirst(record, "loadName", "load_name", "loadLabel", "load_label", "loadNumber", "load_number", "load", "routeLabel", "route_label");
    const planDate = offlineReviewFirst(record, "planDate", "plan_date", "date") || driverPwaStopsDate;
    const times = driverPwaStopTimes(record);
    const location = driverPwaStopLocation(record, "recorded");
    const photoCount = Number(offlineReviewFirst(record, "photoCount", "photo_count", "evidencePhotoCount", "evidence_photo_count") || 0);
    const selected = recordId === driverPwaSelectedStopId;
    return `
      <button class="offline-review-case ${selected ? "selected" : ""}" data-action="select-stop" data-record-id="${offlineReviewEscape(recordId)}" type="button" aria-pressed="${selected ? "true" : "false"}">
        <span class="offline-review-case-head">
          <strong>${offlineReviewEscape(driver)} · ${offlineReviewEscape(driverPwaStopLabel(record))}</strong>
          <span class="offline-review-pill ${driverPwaStopStatusTone(record)}">${offlineReviewEscape(driverPwaStopStatusLabel(record))}</span>
        </span>
        <span class="offline-review-case-meta">
          <span>${offlineReviewEscape(offlineReviewFormatPlanDate(planDate))}${load ? ` · ${offlineReviewEscape(load)}` : ""}</span>
          <span>${offlineReviewEscape(offlineReviewFormatDateTime(times.leave || times.arrival))}</span>
        </span>
        <span class="offline-review-case-reason">${offlineReviewEscape(offlineReviewDisplayValue(location))}</span>
        <span class="offline-review-case-foot">
          <span>${offlineReviewEscape(offlineReviewDisplayValue(driverPwaStopOrderRefs(record)))}</span>
          <span>${photoCount} photo${photoCount === 1 ? "" : "s"}</span>
        </span>
      </button>
    `;
  }).join("")}`;
}

function driverPwaRenderClientSyncIssues(issues = driverPwaClientSyncIssues, {
  showStopShortcut = false,
  allowDismiss = false
} = {}) {
  if (!issues.length) return "";
  return `
    <section class="driver-pwa-client-sync-issues" role="alert" aria-label="Driver device synchronization issues">
      <div class="driver-pwa-client-sync-heading">
        <div>
          <h2>Driver device sync issues</h2>
          <p>${issues.length} device${issues.length === 1 ? "" : "s"} reported a synchronization error.</p>
        </div>
        <span class="offline-review-pill blocked">Action needed</span>
      </div>
      <p class="driver-pwa-client-sync-safety"><strong>Do not clear browser or site data.</strong> Dispatch cannot repair browser storage or read evidence that has not left the device. Ask the driver to keep the Driver PWA open, stay online, and use <strong>Sync now</strong>. A device error can occur before a server review case exists.</p>
      <div class="driver-pwa-client-sync-list">
        ${issues.map((issue) => {
          const driver = offlineReviewFirst(issue, "driverLogin", "driver_login") || "Driver";
          const sessionId = offlineReviewDeviceIssueId(issue);
          const deviceId = offlineReviewFirst(issue, "deviceId", "device_id");
          const planDate = String(offlineReviewFirst(issue, "planDate", "plan_date") || "");
          const errorName = offlineReviewFirst(issue, "errorName", "error_name");
          const errorCode = offlineReviewFirst(issue, "errorCode", "error_code");
          const errorMessage = offlineReviewFirst(issue, "errorMessage", "error_message", "message") || "Driver synchronization failed.";
          const reportedAt = offlineReviewFirst(issue, "reportedAt", "reported_at", "serverReceivedAt", "server_received_at");
          const pendingEvents = Number(offlineReviewFirst(issue, "pendingEventCount", "pending_event_count") || 0);
          const reviewEvents = Number(offlineReviewFirst(issue, "reviewRequiredCount", "review_required_count") || 0);
          const unsyncedPhotos = Number(offlineReviewFirst(issue, "unsyncedPhotoCount", "unsynced_photo_count") || 0);
          const photoFailures = offlineReviewArray(issue.photoFailures || issue.photo_failures).slice(0, 10);
          const errorIdentity = [errorName, errorCode].filter(Boolean).join(" · ");
          const dismissDraft = sessionId ? offlineReviewDeviceDismissDraft(sessionId) : { auditNote: "", confirmed: false };
          const dismissOpen = allowDismiss && sessionId && offlineReviewDeviceDismissOpenId === sessionId;
          const dismissing = sessionId && offlineReviewDismissingDeviceSessionId === sessionId;
          return `
            <article class="driver-pwa-client-sync-card">
              <div class="driver-pwa-client-sync-card-head">
                <strong>${offlineReviewEscape(driver)}</strong>
                <span title="${offlineReviewEscape(deviceId)}">Device ${offlineReviewEscape(offlineReviewShortId(deviceId))}</span>
              </div>
              <p class="driver-pwa-client-sync-error">${offlineReviewEscape(errorMessage)}</p>
              ${photoFailures.length ? `
                <div class="driver-pwa-client-photo-failures">
                  <strong>${photoFailures.length} photo failure${photoFailures.length === 1 ? "" : "s"} reported by this device</strong>
                  <ol>
                    ${photoFailures.map((failure) => {
                      const photoId = offlineReviewFirst(failure, "photoId", "photo_id");
                      const eventId = offlineReviewFirst(failure, "eventId", "event_id");
                      const phase = offlineReviewFirst(failure, "phase");
                      const byteSize = Number(offlineReviewFirst(failure, "byteSize", "byteCount", "byte_size", "bytes") || 0);
                      const attemptCount = Number(offlineReviewFirst(failure, "attemptCount", "attempts", "attempt_count") || 0);
                      const retryable = offlineReviewBoolean(offlineReviewFirst(failure, "retryable"));
                      const failureCode = offlineReviewFirst(failure, "errorCode", "error_code", "code");
                      const httpStatus = Number(offlineReviewFirst(failure, "httpStatus", "http_status", "status") || 0);
                      const failureMessage = offlineReviewFirst(failure, "message", "errorMessage", "error_message", "error")
                        || "No detailed message was reported.";
                      const failureMeta = [
                        phase ? offlineReviewEventLabel(phase) : "",
                        byteSize > 0 ? offlineReviewFormatBytes(byteSize) : "",
                        attemptCount > 0 ? `Attempt ${attemptCount}` : "",
                        retryable ? "Retryable" : "Manual review may be needed",
                        failureCode ? `Code ${failureCode}` : "",
                        httpStatus > 0 ? `HTTP ${httpStatus}` : ""
                      ].filter(Boolean);
                      return `
                        <li>
                          <div>
                            <strong title="${offlineReviewEscape(photoId)}">Photo ${offlineReviewEscape(offlineReviewShortId(photoId) || "unknown")}</strong>
                            ${eventId ? `<span title="${offlineReviewEscape(eventId)}">Event ${offlineReviewEscape(offlineReviewShortId(eventId))}</span>` : ""}
                          </div>
                          <span>${failureMeta.map(offlineReviewEscape).join(" · ")}</span>
                          <p>${offlineReviewEscape(failureMessage)}</p>
                        </li>
                      `;
                    }).join("")}
                  </ol>
                </div>
              ` : ""}
              <div class="driver-pwa-client-sync-meta">
                ${errorIdentity ? `<span>${offlineReviewEscape(errorIdentity)}</span>` : ""}
                ${planDate ? `<span>Route ${offlineReviewEscape(offlineReviewFormatPlanDate(planDate))}</span>` : ""}
                <span>${pendingEvents} pending event${pendingEvents === 1 ? "" : "s"} · ${reviewEvents} awaiting review · ${unsyncedPhotos} unsynced photo${unsyncedPhotos === 1 ? "" : "s"}</span>
                <span>Reported ${offlineReviewEscape(offlineReviewFormatDateTime(reportedAt))}</span>
              </div>
              ${(showStopShortcut && /^\d{4}-\d{2}-\d{2}$/.test(planDate)) || (allowDismiss && sessionId) ? `
                <div class="driver-pwa-client-sync-actions">
                  ${showStopShortcut && /^\d{4}-\d{2}-\d{2}$/.test(planDate) ? `<button class="driver-pwa-client-sync-open" data-action="view-device-issue" data-plan-date="${offlineReviewEscape(planDate)}" type="button">View ${offlineReviewEscape(offlineReviewFormatPlanDate(planDate))} driver stops</button>` : ""}
                  ${allowDismiss && sessionId ? `<button class="driver-pwa-client-sync-dismiss-toggle" data-action="toggle-device-issue-dismiss" data-session-id="${offlineReviewEscape(sessionId)}" type="button" aria-expanded="${dismissOpen ? "true" : "false"}" ${dismissing ? "disabled" : ""}>${dismissOpen ? "Cancel dismissal" : "Dismiss warning"}</button>` : ""}
                </div>
              ` : ""}
              ${dismissOpen ? `
                <form class="driver-pwa-client-sync-dismiss" data-form="device-sync-dismiss" data-session-id="${offlineReviewEscape(sessionId)}" data-reported-at="${offlineReviewEscape(reportedAt)}">
                  <p><strong>This only dismisses the device warning.</strong> It cannot recover erased browser evidence and does not delete or resolve any server event.</p>
                  <label class="offline-review-field">
                    <span>Mandatory audit note</span>
                    <textarea name="auditNote" maxlength="2000" required placeholder="Explain why this device warning can be dismissed.">${offlineReviewEscape(dismissDraft.auditNote)}</textarea>
                  </label>
                  <label class="driver-pwa-confirm">
                    <input name="confirmDismiss" type="checkbox" required ${dismissDraft.confirmed ? "checked" : ""} />
                    <span>I confirmed the browser evidence was recovered, intentionally abandoned, or recreated, and understand this action does not synchronize it.</span>
                  </label>
                  <div class="offline-review-resolution-actions">
                    <span class="offline-review-resolution-help">A later error from this device will appear again automatically.</span>
                    <button class="driver-pwa-client-sync-dismiss-submit" type="submit" ${dismissing ? "disabled" : ""}>${dismissing ? "Dismissing…" : "Dismiss device warning"}</button>
                  </div>
                </form>
              ` : ""}
            </article>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function driverPwaRenderReopen(record) {
  const recordId = driverPwaStopId(record);
  const draft = driverPwaStopDraft(recordId);
  const stateHash = driverPwaExpectedStateHash(record);
  const blocks = driverPwaStopBlocks(record);
  const canReopen = driverPwaStopCanReopen(record);
  const restarting = driverPwaStopStatus(record) === "in_progress";
  const actionLabel = restarting ? "Restart" : "Reopen";
  const pendingOfflineRecordCount = Number(offlineReviewFirst(
    record,
    "pendingOfflineRecordCount",
    "pending_offline_record_count"
  ) || 0);
  const disabledReason = blocks[0]
    || (!stateHash ? "This stop has no current state hash. Refresh before attempting to reopen it." : "This stop cannot be reopened in its current state.");
  return `
    <form class="offline-review-resolution driver-pwa-reopen-form" data-form="driver-pwa-reopen">
      <div>
        <h3>${actionLabel} driver stop</h3>
        <p class="offline-review-resolution-help">${restarting
          ? "Restarting resets this in-progress stop to pending so the driver can perform it again. The server revalidates the exact stop state before making any change."
          : "Use this only when the driver must capture this stop again. The server revalidates the exact stop state before making any change."}</p>
      </div>
      ${blocks.length ? `
        <div class="driver-pwa-block-list" role="alert">
          <strong>${actionLabel} blocked</strong>
          <ul>${blocks.map((reason) => `<li>${offlineReviewEscape(reason)}</li>`).join("")}</ul>
        </div>
      ` : ""}
      <div class="driver-pwa-reopen-warning">
        <strong>Evidence is retained.</strong>
        <span>${restarting ? "Restarting resets the server stop to pending" : "Reopening returns driver capture to this stop"}; it does not erase original timestamps, photos, sync events, notifications, or the audit trail. ${pendingOfflineRecordCount > 0
          ? `${pendingOfflineRecordCount} pending offline record${pendingOfflineRecordCount === 1 ? "" : "s"} for this stop will be retained as evidence and closed by the correction, not deleted or replayed. `
          : ""}After it succeeds, ask the driver to clear their downloaded route and refresh while online before performing the stop again.</span>
      </div>
      <label class="offline-review-field">
        <span>Mandatory audit note</span>
        <textarea name="auditNote" maxlength="2000" required placeholder="Explain the incorrect stop and why the driver must perform it again." ${canReopen ? "" : "disabled"}>${offlineReviewEscape(draft.auditNote)}</textarea>
      </label>
      <label class="driver-pwa-confirm">
        <input name="confirmReopen" type="checkbox" required ${draft.confirmed ? "checked" : ""} ${canReopen ? "" : "disabled"} />
        <span>I confirmed the selected stop and understand the driver must refresh the downloaded route before repeating it.</span>
      </label>
      <div class="offline-review-resolution-actions">
        <span class="offline-review-resolution-help" title="${offlineReviewEscape(stateHash)}">State ${offlineReviewEscape(offlineReviewShortId(stateHash))}</span>
        <button class="offline-review-submit" type="submit" ${!canReopen || driverPwaReopening ? "disabled" : ""}>${driverPwaReopening ? `${actionLabel}ing…` : `${actionLabel} stop`}</button>
      </div>
      ${!canReopen ? `<p class="offline-review-resolution-help driver-pwa-disabled-reason">${offlineReviewEscape(disabledReason)}</p>` : ""}
    </form>
  `;
}

function driverPwaRenderStopDetail() {
  const selected = driverPwaSelectedStop();
  if (!selected) {
    return `
      <section class="offline-review-panel offline-review-detail-panel">
        <div class="offline-review-empty">Select a recorded stop to review its timestamps, evidence status, and reopen eligibility.</div>
      </section>
    `;
  }
  const record = driverPwaStopRecord(selected);
  const recordId = driverPwaStopId(record);
  const driver = offlineReviewFirst(record, "driverLogin", "driver_login", "driverName", "driver_name", "driver");
  const planDate = offlineReviewFirst(record, "planDate", "plan_date", "date") || driverPwaStopsDate;
  const load = offlineReviewFirst(record, "loadName", "load_name", "loadLabel", "load_label", "loadNumber", "load_number", "load", "routeLabel", "route_label");
  const times = driverPwaStopTimes(record);
  const recordedJob = driverPwaStopJob(record, "recorded");
  const currentJob = driverPwaStopJob(record, "current");
  const recordedLocation = driverPwaStopLocation(record, "recorded");
  const currentLocation = driverPwaStopLocation(record, "current");
  const locationChanged = Boolean(recordedLocation && currentLocation
    && String(recordedLocation).trim().toLowerCase() !== String(currentLocation).trim().toLowerCase());
  const eventSource = offlineReviewFirst(record, "source", "eventSource", "event_source", "completionSource", "completion_source");
  const photoCount = offlineReviewFirst(record, "photoCount", "photo_count", "evidencePhotoCount", "evidence_photo_count");
  const driverRemark = offlineReviewFirst(record, "driverRemark", "driver_remark");
  return `
    <section class="offline-review-panel offline-review-detail-panel">
      <div class="offline-review-panel-heading">
        <div>
          <h2>${offlineReviewEscape(driverPwaStopLabel(record))}</h2>
          <p>${offlineReviewEscape(driver || "Driver")} · ${offlineReviewEscape(offlineReviewFormatPlanDate(planDate))}${load ? ` · ${offlineReviewEscape(load)}` : ""}</p>
        </div>
        <span class="offline-review-pill ${driverPwaStopStatusTone(record)}">${offlineReviewEscape(driverPwaStopStatusLabel(record))}</span>
      </div>
      <div class="offline-review-detail-scroll">
        ${locationChanged ? `
          <div class="driver-pwa-location-warning" role="alert">
            <strong>Dispatch location differs from the recorded stop.</strong>
            <span>Recorded: ${offlineReviewEscape(offlineReviewDisplayValue(recordedLocation))} · Current: ${offlineReviewEscape(offlineReviewDisplayValue(currentLocation))}</span>
          </div>
        ` : ""}
        <div class="offline-review-summary-grid">
          ${offlineReviewSummaryItem("Arrival time", offlineReviewFormatDateTime(times.arrival))}
          ${offlineReviewSummaryItem("Leave time", offlineReviewFormatDateTime(times.leave))}
          ${offlineReviewSummaryItem("Recorded location", recordedLocation)}
          ${offlineReviewSummaryItem("Current location", currentLocation || recordedLocation)}
          ${offlineReviewSummaryItem("Orders", driverPwaStopOrderRefs(record))}
          ${offlineReviewSummaryItem("Photos retained", photoCount === "" ? "—" : photoCount)}
          ${offlineReviewSummaryItem("Driver remark", driverRemark)}
          ${offlineReviewSummaryItem("Record source", eventSource)}
          ${offlineReviewSummaryItem("Record ID", recordId)}
        </div>
        <section class="offline-review-section">
          <h3>Recorded versus current stop</h3>
          <div class="offline-review-comparison-grid">
            ${offlineReviewRenderJobCard("Recorded driver stop", recordedJob, "The recorded stop snapshot is unavailable.")}
            ${offlineReviewRenderJobCard("Current dispatch stop", Object.keys(currentJob).length ? currentJob : null, "The current stop snapshot is unavailable. Refresh before reopening.")}
          </div>
        </section>
        ${driverPwaRenderReopen(record)}
      </div>
    </section>
  `;
}

function driverPwaRenderStopsSurface() {
  return `
    <div class="offline-review-toolbar driver-pwa-stop-toolbar">
      <label class="driver-pwa-date-filter">
        <span>Plan date</span>
        <input data-action="stops-date" type="date" value="${offlineReviewEscape(driverPwaStopsDate)}" />
      </label>
      <div class="offline-review-notice ${offlineReviewEscape(offlineReviewNotice.tone)}" aria-live="polite">${offlineReviewEscape(offlineReviewNotice.message)}</div>
      <div class="offline-review-toolbar-actions">
        <button data-action="refresh-stops" type="button" ${driverPwaStopsLoading ? "disabled" : ""}>${driverPwaStopsLoading ? "Refreshing…" : "Refresh stops"}</button>
      </div>
    </div>
    <div class="offline-review-grid ${driverPwaClientSyncIssues.length ? "has-client-sync-issues" : ""}">
      ${driverPwaRenderClientSyncIssues()}
      <section class="offline-review-panel offline-review-list-panel">
        <div class="offline-review-panel-heading">
          <div>
            <h2>Driver stops</h2>
            <p>${driverPwaStops.length} record${driverPwaStops.length === 1 ? "" : "s"}</p>
          </div>
        </div>
        <div class="offline-review-list">${driverPwaRenderStopList()}</div>
      </section>
      ${driverPwaRenderStopDetail()}
    </div>
  `;
}

function offlineReviewRenderSyncSurface() {
  const deviceIssues = offlineReviewFilter === "open" ? offlineReviewClientSyncIssues : [];
  return `
    <div class="offline-review-toolbar">
      <div class="offline-review-filters" role="group" aria-label="Review status">
        <button class="offline-review-filter ${offlineReviewFilter === "open" ? "active" : ""}" data-action="set-filter" data-filter="open" type="button">Open sync records</button>
        <button class="offline-review-filter ${offlineReviewFilter === "resolved" ? "active" : ""}" data-action="set-filter" data-filter="resolved" type="button">Resolved</button>
      </div>
      <div class="offline-review-notice ${offlineReviewEscape(offlineReviewNotice.tone)}" aria-live="polite">${offlineReviewEscape(offlineReviewNotice.message)}</div>
      <div class="offline-review-toolbar-actions">
        <button data-action="refresh-list" type="button" ${offlineReviewListLoading ? "disabled" : ""}>${offlineReviewListLoading ? "Refreshing…" : "Refresh"}</button>
      </div>
    </div>
    <div class="offline-review-grid ${deviceIssues.length ? "has-client-sync-issues" : ""}">
      ${driverPwaRenderClientSyncIssues(deviceIssues, { showStopShortcut: true, allowDismiss: true })}
      <section class="offline-review-panel offline-review-list-panel">
        <div class="offline-review-panel-heading">
          <div>
            <h2>${offlineReviewFilter === "resolved" ? "Resolved cases" : "Open sync records"}</h2>
            <p>${offlineReviewCases.length} server case${offlineReviewCases.length === 1 ? "" : "s"}${offlineReviewFilter === "open" ? ` · ${deviceIssues.length} device issue${deviceIssues.length === 1 ? "" : "s"}` : ""}</p>
          </div>
        </div>
        <div class="offline-review-list">${offlineReviewRenderList()}</div>
      </section>
      ${offlineReviewRenderDetail()}
    </div>
  `;
}

function offlineReviewRender() {
  if (!offlineReviewOperator) return;
  const operatorName = offlineReviewOperator.display_name || offlineReviewOperator.username || "";
  offlineReviewApp.innerHTML = `
    <header class="dispatch-topbar">
      <div>
        <p>${offlineReviewT("app.transportation", "MBBS Transportation")}</p>
        <h1>Driver PWA</h1>
      </div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div>
      <div class="topbar-actions">
        <button data-action="back-menu" type="button">Menu</button>
        <span class="dispatch-user">${offlineReviewEscape(operatorName)}</span>
        <button data-action="logout" type="button">${offlineReviewT("common.logout", "Logout")}</button>
      </div>
    </header>
    <section class="offline-review-content">
      <div class="driver-pwa-tabs" role="tablist" aria-label="Driver PWA tools">
        <button class="driver-pwa-tab ${driverPwaSurface === "stops" ? "active" : ""}" data-action="set-surface" data-surface="stops" role="tab" aria-selected="${driverPwaSurface === "stops" ? "true" : "false"}" type="button">Driver stops</button>
        <button class="driver-pwa-tab ${driverPwaSurface === "sync-review" ? "active" : ""}" data-action="set-surface" data-surface="sync-review" role="tab" aria-selected="${driverPwaSurface === "sync-review" ? "true" : "false"}" type="button">Sync review</button>
      </div>
      ${driverPwaSurface === "stops" ? driverPwaRenderStopsSurface() : offlineReviewRenderSyncSurface()}
    </section>
  `;
}

function offlineReviewNewResolutionId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `resolution-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function offlineReviewResolutionId(eventId, body) {
  const signature = JSON.stringify({
    action: body.action,
    targetJobId: body.targetJobId || "",
    auditNote: body.auditNote,
    caseVersion: body.caseVersion
  });
  const existing = offlineReviewResolutionAttempts.get(eventId);
  if (existing?.signature === signature) return existing.id;
  const id = offlineReviewNewResolutionId();
  offlineReviewResolutionAttempts.set(eventId, { signature, id });
  return id;
}

function offlineReviewRetryId(eventId, body) {
  const signature = JSON.stringify({
    caseVersion: body.caseVersion
  });
  const existing = offlineReviewRetryAttempts.get(eventId);
  if (existing?.signature === signature) return existing.id;
  const id = offlineReviewNewResolutionId();
  offlineReviewRetryAttempts.set(eventId, { signature, id });
  return id;
}

function driverPwaReopenId(recordId, body) {
  const signature = JSON.stringify({
    expectedStateHash: body.expectedStateHash,
    auditNote: body.auditNote
  });
  const existing = driverPwaReopenAttempts.get(recordId);
  if (existing?.signature === signature) return existing.id;
  const id = offlineReviewNewResolutionId();
  driverPwaReopenAttempts.set(recordId, { signature, id });
  return id;
}

async function driverPwaReopenStop() {
  driverPwaCaptureStopDraft();
  const record = driverPwaStopRecord(driverPwaSelectedStop());
  const recordId = driverPwaStopId(record);
  const draft = driverPwaStopDraft(recordId);
  const auditNote = String(draft.auditNote || "").trim();
  const expectedStateHash = driverPwaExpectedStateHash(record);
  const restarting = driverPwaStopStatus(record) === "in_progress";
  if (!recordId) {
    offlineReviewNotice = { message: "Select a valid driver stop before reopening it.", tone: "error" };
    offlineReviewRender();
    return;
  }
  if (!driverPwaStopCanReopen(record)) {
    offlineReviewNotice = { message: driverPwaStopBlocks(record)[0] || "This driver stop cannot be reopened in its current state.", tone: "error" };
    offlineReviewRender();
    return;
  }
  if (!auditNote) {
    offlineReviewNotice = { message: "Enter an audit note before reopening this stop.", tone: "error" };
    offlineReviewRender();
    offlineReviewApp.querySelector("[data-form='driver-pwa-reopen'] textarea[name='auditNote']")?.focus();
    return;
  }
  if (!draft.confirmed) {
    offlineReviewNotice = { message: "Confirm that you selected the correct stop and will ask the driver to refresh their route.", tone: "error" };
    offlineReviewRender();
    offlineReviewApp.querySelector("[data-form='driver-pwa-reopen'] input[name='confirmReopen']")?.focus();
    return;
  }
  if (!expectedStateHash) {
    offlineReviewNotice = { message: "This stop has no current state hash. Refresh the list before reopening it.", tone: "error" };
    offlineReviewRender();
    return;
  }

  const body = { auditNote, expectedStateHash };
  body.idempotencyId = driverPwaReopenId(recordId, body);
  driverPwaReopening = true;
  offlineReviewNotice = {
    message: restarting
      ? "Revalidating and restarting the driver stop…"
      : "Revalidating and reopening the driver stop…",
    tone: ""
  };
  offlineReviewRender();
  try {
    const result = await offlineReviewApi(`${DRIVER_PWA_STOPS_ENDPOINT}/${encodeURIComponent(recordId)}/reopen`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    driverPwaReopenAttempts.delete(recordId);
    driverPwaReopenDrafts.delete(recordId);
    offlineReviewNotice = {
      message: offlineReviewFirst(result, "message")
        || `Stop ${restarting ? "restarted" : "reopened"}. Ask the driver to clear the downloaded route, refresh while online, and perform the stop again.`,
      tone: "success"
    };
    await driverPwaLoadStops({ keepSelection: true, quiet: true });
  } catch (error) {
    offlineReviewNotice = {
      message: error.status === 409
        ? `The stop changed before it could be reopened. The list has been refreshed: ${error.message}`
        : `Reopen failed: ${error.message}`,
      tone: "error"
    };
    if (error.status === 409) await driverPwaLoadStops({ keepSelection: true, quiet: true });
  } finally {
    driverPwaReopening = false;
    offlineReviewRender();
  }
}

async function offlineReviewDismissDeviceIssue(form) {
  offlineReviewCaptureDeviceDismissDrafts();
  const sessionId = String(form?.dataset.sessionId || "");
  const reportedAt = String(form?.dataset.reportedAt || "");
  const draft = offlineReviewDeviceDismissDraft(sessionId);
  const auditNote = String(draft.auditNote || "").trim();
  if (!sessionId || !reportedAt) {
    offlineReviewNotice = { message: "This device warning has no stable identity. Refresh before dismissing it.", tone: "error" };
    offlineReviewRender();
    return;
  }
  if (!auditNote) {
    offlineReviewNotice = { message: "Enter an audit note before dismissing this device warning.", tone: "error" };
    offlineReviewRender();
    offlineReviewDeviceDismissForm(sessionId)?.elements.auditNote?.focus();
    return;
  }
  if (!draft.confirmed) {
    offlineReviewNotice = { message: "Confirm what happened to the browser evidence before dismissing this warning.", tone: "error" };
    offlineReviewRender();
    offlineReviewDeviceDismissForm(sessionId)?.elements.confirmDismiss?.focus();
    return;
  }
  offlineReviewDismissingDeviceSessionId = sessionId;
  offlineReviewNotice = { message: "Recording the device warning dismissal…", tone: "" };
  offlineReviewRender();
  try {
    const result = await offlineReviewApi(
      `${OFFLINE_REVIEW_LIST_ENDPOINT}/device-issues/${encodeURIComponent(sessionId)}/dismiss`,
      {
        method: "POST",
        body: JSON.stringify({ expectedReportedAt: reportedAt, auditNote })
      }
    );
    offlineReviewDeviceDismissDrafts.delete(sessionId);
    offlineReviewDeviceDismissOpenId = "";
    offlineReviewNotice = {
      message: offlineReviewFirst(result, "message") || "Device warning dismissed. A later error from the device will appear again automatically.",
      tone: "success"
    };
    await offlineReviewLoadList({ keepSelection: true, quiet: true });
  } catch (error) {
    offlineReviewNotice = {
      message: error.status === 409
        ? `The device warning changed before dismissal. Refreshing it now: ${error.message}`
        : `Device warning dismissal failed: ${error.message}`,
      tone: "error"
    };
    if (error.status === 409 || error.status === 404) {
      await offlineReviewLoadList({ keepSelection: true, quiet: true });
    }
  } finally {
    offlineReviewDismissingDeviceSessionId = "";
    offlineReviewRender();
  }
}

async function offlineReviewRetry() {
  offlineReviewCaptureDraft();
  const record = offlineReviewCaseRecord();
  const eventId = offlineReviewCaseId(record);
  const caseVersion = offlineReviewVersion(record);
  if (!eventId || !offlineReviewCanRecover(record)) {
    offlineReviewNotice = { message: "Select a recoverable synchronization record before retrying it.", tone: "error" };
    offlineReviewRender();
    return;
  }
  if (caseVersion === "") {
    offlineReviewNotice = { message: "This record has no version and cannot be retried safely. Refresh it or contact an administrator.", tone: "error" };
    offlineReviewRender();
    return;
  }

  const body = { caseVersion, expectedVersion: caseVersion };
  const idempotencyId = offlineReviewRetryId(eventId, body);
  body.idempotencyId = idempotencyId;
  body.retryId = idempotencyId;
  offlineReviewRetrying = true;
  offlineReviewNotice = { message: "Retrying photo verification and server processing…", tone: "" };
  offlineReviewRender();
  try {
    const result = await offlineReviewApi(`${OFFLINE_REVIEW_LIST_ENDPOINT}/${encodeURIComponent(eventId)}/retry`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    const photoResult = offlineReviewObject(result.photos);
    const verifiedCount = offlineReviewResultCount(photoResult.verified);
    const failedCount = offlineReviewResultCount(photoResult.failed);
    const missingUploadCount = offlineReviewResultCount(photoResult.missingUploads || photoResult.missing_uploads);
    const drainedCount = offlineReviewResultCount(result.drained);
    const drainError = offlineReviewErrorText(result.drainError || result.drain_error);
    const failedDetails = offlineReviewArray(photoResult.results)
      .filter((failure) => String(offlineReviewFirst(failure, "status") || "") === "failed")
      .map((failure) => {
        const code = offlineReviewFirst(failure, "code", "errorCode", "error_code");
        const message = offlineReviewErrorText(failure);
        return [code, message].filter(Boolean).join(": ");
      })
      .filter(Boolean)
      .slice(0, 3);
    const summary = [
      verifiedCount ? `${verifiedCount} photo${verifiedCount === 1 ? "" : "s"} verified` : "",
      failedCount ? `${failedCount} verification failure${failedCount === 1 ? "" : "s"}` : "",
      missingUploadCount ? `${missingUploadCount} missing upload${missingUploadCount === 1 ? "" : "s"}` : "",
      drainedCount ? `${drainedCount} queue record${drainedCount === 1 ? "" : "s"} checked` : ""
    ].filter(Boolean);
    const requiresAttention = failedCount > 0 || missingUploadCount > 0 || Boolean(drainError);
    offlineReviewRetryAttempts.delete(eventId);
    offlineReviewNotice = {
      message: [
        offlineReviewFirst(result, "message") || "Retry completed.",
        summary.length ? `${summary.join(" · ")}.` : "",
        failedDetails.length ? `Failures: ${failedDetails.join("; ")}.` : "",
        drainError ? `Later-event processing failed: ${drainError}` : "",
        missingUploadCount ? "Missing uploads still require the original Driver device or an audited evidence-only close." : ""
      ].filter(Boolean).join(" "),
      tone: requiresAttention ? "error" : "success"
    };
    window.dispatchEvent(new CustomEvent("mbbs-offline-review-count-changed"));
    await offlineReviewLoadList({ keepSelection: true, quiet: true });
  } catch (error) {
    offlineReviewNotice = {
      message: error.status === 409
        ? `This record changed before retry. It has been refreshed: ${error.message}`
        : `Retry failed: ${error.message}`,
      tone: "error"
    };
    if (error.status === 409) await offlineReviewLoadList({ keepSelection: true, quiet: true });
  } finally {
    offlineReviewRetrying = false;
    offlineReviewRender();
  }
}

async function offlineReviewResolve({
  actionOverride = "",
  requireEvidenceConfirmation = false
} = {}) {
  offlineReviewCaptureDraft();
  const record = offlineReviewCaseRecord();
  const eventId = offlineReviewCaseId(record);
  const draft = offlineReviewDraft(eventId);
  const auditNote = String(draft.auditNote || "").trim();
  const action = actionOverride || draft.action;
  if (!auditNote) {
    offlineReviewNotice = { message: "Enter an audit note before resolving this conflict.", tone: "error" };
    offlineReviewRender();
    offlineReviewApp.querySelector("textarea[name='auditNote']")?.focus();
    return;
  }
  if (requireEvidenceConfirmation && !draft.confirmEvidenceOnly) {
    offlineReviewNotice = {
      message: "Confirm that the Driver evidence cannot be recovered before closing this event as evidence only.",
      tone: "error"
    };
    offlineReviewRender();
    offlineReviewApp.querySelector("input[name='confirmEvidenceOnly']")?.focus();
    return;
  }
  if (action === "reattach" && !draft.targetJobId) {
    offlineReviewNotice = { message: "Select a validated current stop before reattaching.", tone: "error" };
    offlineReviewRender();
    offlineReviewApp.querySelector("select[name='targetJobId']")?.focus();
    return;
  }

  const caseVersion = offlineReviewVersion(record);
  if (caseVersion === "") {
    offlineReviewNotice = { message: "This case has no version and cannot be resolved safely. Refresh the case or contact an administrator.", tone: "error" };
    offlineReviewRender();
    return;
  }
  const baseBody = {
    action,
    ...(action === "reattach" ? { targetJobId: draft.targetJobId } : {}),
    auditNote,
    caseVersion,
    ...(requireEvidenceConfirmation ? { confirmed: true } : {})
  };
  const idempotencyId = offlineReviewResolutionId(eventId, baseBody);
  const body = {
    ...baseBody,
    idempotencyId,
    expectedVersion: caseVersion,
    resolutionId: idempotencyId
  };

  offlineReviewResolving = true;
  offlineReviewNotice = { message: "Resolving conflict and checking later events…", tone: "" };
  offlineReviewRender();
  try {
    const result = await offlineReviewApi(`${OFFLINE_REVIEW_LIST_ENDPOINT}/${encodeURIComponent(eventId)}/resolve`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    const replayed = offlineReviewArray(result.replayed);
    const drainedCount = offlineReviewResultCount(result.drained);
    const drainError = offlineReviewErrorText(result.drainError || result.drain_error);
    offlineReviewResolutionAttempts.delete(eventId);
    offlineReviewDrafts.delete(eventId);
    const resolutionMessage = requireEvidenceConfirmation
      ? "Event closed as evidence only."
      : "Conflict resolved.";
    const followUp = [
      replayed.length
        ? `${replayed.length} blocked event${replayed.length === 1 ? "" : "s"} reprocessed.`
        : "",
      drainedCount
        ? `${drainedCount} later queue record${drainedCount === 1 ? "" : "s"} checked.`
        : "",
      drainError ? `Later-event processing failed: ${drainError}` : ""
    ].filter(Boolean).join(" ");
    offlineReviewNotice = {
      message: [offlineReviewFirst(result, "message") || resolutionMessage, followUp].filter(Boolean).join(" "),
      tone: drainError ? "error" : "success"
    };
    window.dispatchEvent(new CustomEvent("mbbs-offline-review-count-changed"));
    await offlineReviewLoadList({ keepSelection: true, quiet: true });
  } catch (error) {
    offlineReviewNotice = {
      message: error.status === 409
        ? `This case changed before resolution. It has been refreshed: ${error.message}`
        : `Resolution failed: ${error.message}`,
      tone: "error"
    };
    if (error.status === 409) {
      await offlineReviewLoadList({ keepSelection: true, quiet: true });
    }
  } finally {
    offlineReviewResolving = false;
    offlineReviewRender();
  }
}

function offlineReviewFindPhoto(photoId) {
  const wanted = String(photoId || "");
  return offlineReviewPhotos().find((photo) => String(offlineReviewFirst(photo, "photoId", "photo_id", "id")) === wanted) || null;
}

function offlineReviewClosePhoto() {
  const lightbox = document.querySelector(".offline-review-photo-lightbox");
  if (!lightbox) return;
  const objectUrl = lightbox.dataset.objectUrl || "";
  lightbox.remove();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
}

async function offlineReviewOpenPhoto(button) {
  const eventId = offlineReviewCaseId();
  const photoId = String(button?.dataset.photoId || "");
  const photo = offlineReviewFindPhoto(photoId);
  if (!eventId || !photoId || !photo) return;
  const photoStatus = String(offlineReviewFirst(photo, "status", "photoStatus", "photo_status") || "").toLowerCase();
  const durable = photoStatus === "durably_received" || offlineReviewBoolean(
    offlineReviewFirst(photo, "durableReceipt", "durable_receipt", "durablyReceived", "durably_received")
  );
  const objectReference = String(offlineReviewFirst(photo, "objectReference", "object_reference") || "").trim();
  if (!durable || !objectReference) {
    offlineReviewNotice = {
      message: objectReference
        ? "This photo cannot be opened until server verification succeeds. Use Retry verification and processing."
        : "This photo has not reached server storage. It must be uploaded from the original Driver device.",
      tone: "error"
    };
    offlineReviewRender();
    return;
  }
  button.setAttribute("aria-busy", "true");
  button.disabled = true;
  try {
    const response = await fetch(`${OFFLINE_REVIEW_LIST_ENDPOINT}/${encodeURIComponent(eventId)}/photos/${encodeURIComponent(photoId)}`, {
      headers: { Accept: "image/*" }
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Photo request failed (${response.status})`);
    }
    const blob = await response.blob();
    if (!String(blob.type || "").toLowerCase().startsWith("image/")) {
      throw new Error("The evidence endpoint did not return an image.");
    }
    const objectUrl = URL.createObjectURL(blob);
    offlineReviewClosePhoto();
    const modal = document.createElement("div");
    modal.className = "offline-review-photo-lightbox";
    modal.dataset.objectUrl = objectUrl;
    modal.innerHTML = `
      <div class="offline-review-photo-lightbox-panel" role="dialog" aria-modal="true" aria-label="Offline evidence photo">
        <button class="offline-review-photo-lightbox-close" data-action="close-photo" type="button" aria-label="Close photo">×</button>
        <img src="${offlineReviewEscape(objectUrl)}" alt="Offline evidence photo" />
        <p>${offlineReviewEscape(offlineReviewShortId(photoId))} · ${offlineReviewEscape(offlineReviewFormatBytes(offlineReviewFirst(photo, "byteSize", "byte_size", "bytes")))}</p>
      </div>
    `;
    modal.addEventListener("click", (event) => {
      if (event.target === modal || event.target.closest("[data-action='close-photo']")) offlineReviewClosePhoto();
    });
    document.body.appendChild(modal);
    modal.querySelector("[data-action='close-photo']")?.focus();
  } catch (error) {
    offlineReviewNotice = { message: `Photo preview failed: ${error.message}`, tone: "error" };
    offlineReviewRender();
  } finally {
    if (button.isConnected) {
      button.removeAttribute("aria-busy");
      button.disabled = false;
    }
  }
}

function offlineReviewConnectEvents() {
  if (!("EventSource" in window) || offlineReviewEventSource) return;
  offlineReviewEventSource = new EventSource("/api/events?client=dispatch-offline-review");
  offlineReviewEventSource.addEventListener("app-event", (message) => {
    let event;
    try {
      event = JSON.parse(message.data || "{}");
    } catch {
      return;
    }
    if (event.type === "connected" || offlineReviewResolving || offlineReviewRetrying || offlineReviewDismissingDeviceSessionId || driverPwaReopening) return;
    window.clearTimeout(offlineReviewEventTimer);
    offlineReviewEventTimer = window.setTimeout(() => {
      const refresh = driverPwaSurface === "stops"
        ? driverPwaLoadStops({ keepSelection: true, quiet: true })
        : offlineReviewLoadList({ keepSelection: true, quiet: true });
      refresh.catch(() => {});
    }, 400);
  });
}

offlineReviewApp.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "back-menu") {
    location.href = "/dispatch";
    return;
  }
  if (action === "logout") {
    dispatchLogout();
    return;
  }
  if (action === "set-surface") {
    const surface = String(button.dataset.surface || "");
    if (!['stops', 'sync-review'].includes(surface) || surface === driverPwaSurface) return;
    driverPwaCaptureStopDraft();
    offlineReviewCaptureDraft();
    driverPwaSurface = surface;
    offlineReviewNotice = { message: "", tone: "" };
    offlineReviewRender();
    if (surface === "stops") {
      driverPwaLoadStops({ keepSelection: true });
    } else {
      offlineReviewLoadList({ keepSelection: true });
    }
    return;
  }
  if (action === "refresh-stops") {
    driverPwaCaptureStopDraft();
    driverPwaLoadStops({ keepSelection: true });
    return;
  }
  if (action === "view-device-issue") {
    const planDate = String(button.dataset.planDate || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) return;
    offlineReviewCaptureDraft();
    driverPwaStopsDate = planDate;
    driverPwaSelectedStopId = "";
    driverPwaStops = [];
    driverPwaSurface = "stops";
    offlineReviewNotice = { message: "Showing the route date reported by the selected device sync issue.", tone: "" };
    offlineReviewRender();
    driverPwaLoadStops();
    return;
  }
  if (action === "toggle-device-issue-dismiss") {
    const sessionId = String(button.dataset.sessionId || "");
    if (!sessionId || offlineReviewDismissingDeviceSessionId) return;
    offlineReviewCaptureDeviceDismissDrafts();
    offlineReviewDeviceDismissOpenId = offlineReviewDeviceDismissOpenId === sessionId ? "" : sessionId;
    offlineReviewNotice = { message: "", tone: "" };
    offlineReviewRender();
    if (offlineReviewDeviceDismissOpenId) {
      offlineReviewDeviceDismissForm(sessionId)?.elements.auditNote?.focus();
    }
    return;
  }
  if (action === "select-stop") {
    const recordId = String(button.dataset.recordId || "");
    if (!recordId || recordId === driverPwaSelectedStopId) return;
    driverPwaCaptureStopDraft();
    driverPwaSelectedStopId = recordId;
    offlineReviewNotice = { message: "", tone: "" };
    offlineReviewRender();
    return;
  }
  if (action === "set-filter") {
    const filter = button.dataset.filter;
    if (!["open", "resolved"].includes(filter) || filter === offlineReviewFilter) return;
    offlineReviewCaptureDraft();
    offlineReviewFilter = filter;
    offlineReviewSelectedId = "";
    offlineReviewDetailPayload = null;
    offlineReviewNotice = { message: "", tone: "" };
    offlineReviewLoadList();
    return;
  }
  if (action === "refresh-list") {
    offlineReviewCaptureDraft();
    offlineReviewLoadList({ keepSelection: true });
    return;
  }
  if (action === "refresh-detail") {
    offlineReviewCaptureDraft();
    offlineReviewLoadDetail(offlineReviewSelectedId);
    return;
  }
  if (action === "retry-case") {
    if (!offlineReviewRetrying && !offlineReviewResolving) offlineReviewRetry();
    return;
  }
  if (action === "select-case") {
    const eventId = String(button.dataset.eventId || "");
    if (!eventId || eventId === offlineReviewSelectedId) return;
    offlineReviewCaptureDraft();
    offlineReviewSelectedId = eventId;
    offlineReviewDetailPayload = null;
    offlineReviewDetailError = "";
    offlineReviewRender();
    offlineReviewLoadDetail(eventId);
    return;
  }
  if (action === "open-photo") {
    offlineReviewOpenPhoto(button);
  }
});

offlineReviewApp.addEventListener("change", (event) => {
  if (event.target.matches("input[data-action='stops-date']")) {
    const date = String(event.target.value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date === driverPwaStopsDate) return;
    driverPwaCaptureStopDraft();
    driverPwaStopsDate = date;
    driverPwaSelectedStopId = "";
    driverPwaStops = [];
    offlineReviewNotice = { message: "", tone: "" };
    driverPwaLoadStops();
    return;
  }
  if (event.target.closest("[data-form='driver-pwa-reopen']")) {
    driverPwaCaptureStopDraft();
    return;
  }
  if (event.target.closest("[data-form='device-sync-dismiss']")) {
    offlineReviewCaptureDeviceDismissDrafts();
    return;
  }
  if (event.target.closest("[data-form='offline-review-recovery']")) {
    offlineReviewCaptureDraft();
    return;
  }
  const form = event.target.closest("[data-form='offline-review-resolution']");
  if (!form) return;
  offlineReviewCaptureDraft();
  if (event.target.name === "action") offlineReviewRender();
});

offlineReviewApp.addEventListener("input", (event) => {
  if (event.target.closest("[data-form='driver-pwa-reopen']")) {
    driverPwaCaptureStopDraft();
    return;
  }
  if (event.target.closest("[data-form='device-sync-dismiss']")) {
    offlineReviewCaptureDeviceDismissDrafts();
    return;
  }
  if (!event.target.closest("[data-form='offline-review-resolution'], [data-form='offline-review-recovery']")) return;
  offlineReviewCaptureDraft();
});

offlineReviewApp.addEventListener("submit", (event) => {
  if (event.target.matches("[data-form='device-sync-dismiss']")) {
    event.preventDefault();
    if (!offlineReviewDismissingDeviceSessionId) offlineReviewDismissDeviceIssue(event.target);
    return;
  }
  if (event.target.matches("[data-form='driver-pwa-reopen']")) {
    event.preventDefault();
    if (!driverPwaReopening) driverPwaReopenStop();
    return;
  }
  if (event.target.matches("[data-form='offline-review-recovery']")) {
    event.preventDefault();
    if (!offlineReviewResolving && !offlineReviewRetrying) {
      offlineReviewResolve({ actionOverride: "evidence_only", requireEvidenceConfirmation: true });
    }
    return;
  }
  if (!event.target.matches("[data-form='offline-review-resolution']")) return;
  event.preventDefault();
  if (!offlineReviewResolving && !offlineReviewRetrying) offlineReviewResolve();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") offlineReviewClosePhoto();
});

window.addEventListener("mbbs-language-changed", () => {
  driverPwaCaptureStopDraft();
  offlineReviewCaptureDraft();
  offlineReviewRender();
});

window.addEventListener("beforeunload", () => {
  offlineReviewEventSource?.close();
  offlineReviewClosePhoto();
  window.clearTimeout(offlineReviewEventTimer);
});

requireDispatchLogin({
  mount: offlineReviewApp,
  roles: ["dispatcher", "admin"],
  allowPublicSales: false,
  async onReady(operator) {
    offlineReviewOperator = operator;
    offlineReviewRender();
    offlineReviewConnectEvents();
    await Promise.all([
      driverPwaLoadStops(),
      offlineReviewBroadcastCount()
    ]);
  }
});
