const customOrdersApp = document.getElementById("customOrdersApp");
const customOrdersT = (key, fallback) => window.MBBS_I18N?.t?.(key, fallback) || fallback;
const customOrdersScmMode = window.location.pathname.startsWith("/scm/");
const customOrdersApiBase = customOrdersScmMode
  ? "/api/scm/custom-orders"
  : "/api/dispatch/custom-orders";

const customOrdersState = {
  operator: null,
  orders: [],
  search: "",
  status: "all",
  editingId: "",
  loading: true,
  saving: false,
  busyId: "",
  notice: null,
  pendingEditId: /^\d+$/.test(new URLSearchParams(window.location.search).get("edit") || "")
    ? new URLSearchParams(window.location.search).get("edit")
    : "",
  draft: emptyCustomOrderDraft()
};

function emptyCustomOrderDraft() {
  return {
    refNumber: "",
    pickupLocation: "",
    dropoffLocation: "",
    orderDetails: "",
    weightLbs: "",
    stopMinutes: "35"
  };
}

function customOrdersEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function customOrderValue(source, ...keys) {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null) return source[key];
  }
  return "";
}

function customOrderTruthy(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["true", "yes", "1", "planned", "assigned"].includes(String(value || "").trim().toLowerCase());
}

function customOrderBoolean(source, keys, fallback = false) {
  const value = customOrderValue(source, ...keys);
  return value === "" ? fallback : customOrderTruthy(value);
}

function normalizeCustomOrder(raw) {
  const assignment = customOrderValue(
    raw,
    "planAssignment",
    "plannedAssignment",
    "planningAssignment",
    "currentAssignment",
    "assignment"
  ) || {};
  const rawStatus = String(customOrderValue(raw, "status", "orderStatus") || "open").trim().toLowerCase();
  const assignmentStatus = String(customOrderValue(assignment, "status", "planStatus") || "").trim().toLowerCase();
  const driverActivity = customOrderBoolean(raw, ["driverActivity", "driver_activity", "hasDriverActivity"], false);
  const hasAssignmentDetails = Boolean(
    customOrderValue(assignment, "planDate", "plan_date", "date")
    || customOrderValue(assignment, "loadName", "load_name", "loadId", "load_id")
    || customOrderValue(assignment, "driverName", "driver_name", "driver")
    || customOrderValue(assignment, "truckPlate", "truck_plate", "truck")
  );
  const planned = !["cancelled", "canceled", "completed", "complete"].includes(rawStatus) && (
    customOrderTruthy(customOrderValue(raw, "planned", "isPlanned", "hasAssignment", "dispatchPlanned"))
    || ["planned", "assigned", "confirmed", "in_progress", "in-progress"].includes(rawStatus)
    || ["planned", "assigned", "confirmed", "in_progress", "in-progress"].includes(assignmentStatus)
    || driverActivity
    || hasAssignmentDetails
  );

  let displayStatus = rawStatus || "open";
  if (["cancelled", "canceled", "inactive"].includes(displayStatus)) displayStatus = "cancelled";
  else if (["completed", "complete", "delivered"].includes(displayStatus)) displayStatus = "completed";
  else if (driverActivity || ["in_progress", "in-progress", "started"].includes(displayStatus)) displayStatus = "in_progress";
  else if (planned) displayStatus = "planned";
  else displayStatus = "open";
  const defaultMutable = displayStatus === "open" && !planned && !driverActivity;
  const editable = customOrderBoolean(raw, ["editable", "canEdit", "can_edit"], defaultMutable);
  const canCancel = customOrderBoolean(raw, ["canCancel", "can_cancel"], defaultMutable);
  const rawStopMinutes = customOrderValue(raw, "stopMinutes", "stop_minutes", "destinationStopMinutes");

  return {
    raw,
    id: String(customOrderValue(raw, "id", "customOrderId", "custom_order_id")),
    refNumber: String(customOrderValue(raw, "refNumber", "referenceNumber", "ref_number", "reference_number", "orderRef", "ref") || "").trim(),
    pickupLocation: String(customOrderValue(raw, "pickupLocation", "pickupAddress", "pickup_location", "pickup_address") || "").trim(),
    dropoffLocation: String(customOrderValue(raw, "dropoffLocation", "dropOffLocation", "dropoffAddress", "drop_off_location", "dropoff_location", "dropoff_address") || "").trim(),
    orderDetails: String(customOrderValue(raw, "orderDetails", "details", "order_details", "description") || "").trim(),
    weightLbs: Number(customOrderValue(raw, "weightLbs", "weight", "weight_lbs", "totalWeight", "total_weight") || 0),
    stopMinutes: rawStopMinutes === "" ? null : Number(rawStopMinutes),
    status: displayStatus,
    rawStatus,
    planned,
    driverActivity,
    lastActivityAt: customOrderValue(raw, "lastActivityAt", "last_activity_at"),
    editable,
    canCancel,
    lockedReason: String(customOrderValue(raw, "lockedReason", "locked_reason") || "").trim(),
    createdAt: customOrderValue(raw, "createdAt", "created_at"),
    updatedAt: customOrderValue(raw, "updatedAt", "updated_at"),
    createdBy: String(customOrderValue(raw, "createdByName", "createdBy", "created_by_name", "created_by") || "").trim(),
    assignment: {
      planDate: customOrderValue(assignment, "planDate", "plan_date", "date", "dispatchPlanDate")
        || customOrderValue(raw, "planDate", "plan_date", "dispatchPlanDate"),
      loadName: String(
        customOrderValue(assignment, "loadName", "load_name", "loadId", "load_id", "dispatchLoadName")
        || customOrderValue(raw, "loadName", "load_name", "loadId", "load_id", "dispatchLoadName")
        || ""
      ).trim(),
      driverName: String(
        customOrderValue(assignment, "driverName", "driver_name", "driver", "dispatchDriverName")
        || customOrderValue(raw, "driverName", "driver_name", "dispatchDriverName")
        || ""
      ).trim(),
      truckPlate: String(
        customOrderValue(assignment, "truckPlate", "truck_plate", "truck", "dispatchTruckPlate")
        || customOrderValue(raw, "truckPlate", "truck_plate", "dispatchTruckPlate")
        || ""
      ).trim()
    }
  };
}

function customOrderStatusLabel(status) {
  if (status === "in_progress") return "In Progress";
  if (status === "planned") return "Planned";
  if (status === "completed") return "Completed";
  if (status === "cancelled") return "Cancelled";
  return "Open";
}

function customOrderLoadLabel(value) {
  const loadName = String(value || "").trim();
  if (!loadName) return "";
  return /^load(?:\s|$)/i.test(loadName) ? loadName : `Load ${loadName}`;
}

function customOrderFormatWeight(value) {
  const weight = Number(value || 0);
  if (!Number.isFinite(weight)) return "--";
  return `${weight.toLocaleString(undefined, { maximumFractionDigits: 2 })} lb`;
}

function customOrderFormatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  if (window.MBBS_I18N?.displayDateTime) {
    const localized = window.MBBS_I18N.displayDateTime(value);
    if (localized) return localized;
  }
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Toronto"
  });
}

function customOrderFormatPlanDate(value) {
  if (!value) return "";
  const dateText = String(value).slice(0, 10);
  const date = new Date(`${dateText}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "2-digit" });
}

async function customOrdersApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const message = typeof payload === "object"
      ? payload?.error || payload?.message
      : payload;
    throw new Error(message || `Request failed (${response.status}).`);
  }
  return payload;
}

function customOrdersPayloadRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.orders)) return payload.orders;
  if (Array.isArray(payload?.customOrders)) return payload.customOrders;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function loadCustomOrders() {
  customOrdersState.loading = true;
  renderCustomOrderResults();
  try {
    const payload = await customOrdersApi(`${customOrdersApiBase}?includeCancelled=true`);
    customOrdersState.orders = customOrdersPayloadRows(payload)
      .map(normalizeCustomOrder)
      .sort((left, right) => {
        const timeDifference = new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime();
        if (Number.isFinite(timeDifference) && timeDifference) return timeDifference;
        return String(right.id).localeCompare(String(left.id), undefined, { numeric: true });
      });
  } finally {
    customOrdersState.loading = false;
    renderCustomOrderResults();
  }
  if (customOrdersState.pendingEditId) {
    const requestedId = customOrdersState.pendingEditId;
    customOrdersState.pendingEditId = "";
    beginCustomOrderEdit(requestedId, { updateUrl: false });
  }
}

function customOrdersFilteredRows() {
  const search = customOrdersState.search.trim().toLowerCase();
  return customOrdersState.orders.filter((order) => {
    if (customOrdersState.status !== "all" && order.status !== customOrdersState.status) return false;
    if (!search) return true;
    return [
      order.refNumber,
      order.pickupLocation,
      order.dropoffLocation,
      order.orderDetails,
      order.createdBy,
      order.assignment.planDate,
      order.assignment.loadName,
      order.assignment.driverName,
      order.assignment.truckPlate
    ].some((value) => String(value || "").toLowerCase().includes(search));
  });
}

function customOrderAssignmentHtml(order) {
  if (!order.planned && !order.driverActivity) return "";
  const pieces = [
    customOrderFormatPlanDate(order.assignment.planDate),
    customOrderLoadLabel(order.assignment.loadName),
    order.assignment.driverName,
    order.assignment.truckPlate,
    order.driverActivity && order.lastActivityAt
      ? `Last activity ${customOrderFormatDateTime(order.lastActivityAt)}`
      : ""
  ].filter(Boolean);
  return `
    <div class="custom-order-assignment">
      <strong>${order.driverActivity ? "Driver activity in progress" : "Dispatch assignment"}</strong>
      <span>${customOrdersEscape(pieces.join(" · ") || "Included in a dispatch plan")}</span>
    </div>
  `;
}

function customOrderCardHtml(order) {
  const editLocked = !order.editable;
  const cancelLocked = !order.canCancel;
  const busy = customOrdersState.busyId === order.id;
  const lockReason = order.lockedReason || (order.driverActivity
    ? "Driver activity has started. This Custom Order can no longer be changed."
    : order.planned
      ? "This order is already assigned to a dispatch plan."
    : order.status === "completed"
      ? "Completed orders cannot be changed."
      : order.status === "cancelled"
        ? "Cancelled orders remain available as records."
        : "");
  const createdMeta = [
    `Created ${customOrderFormatDateTime(order.createdAt)}`,
    order.createdBy ? `by ${order.createdBy}` : ""
  ].filter(Boolean).join(" ");
  const updatedMeta = order.updatedAt && order.updatedAt !== order.createdAt
    ? `Updated ${customOrderFormatDateTime(order.updatedAt)}`
    : "";

  return `
    <article class="custom-order-card status-${customOrdersEscape(order.status)}">
      <div class="custom-order-card-main">
        <div class="custom-order-card-title">
          <strong>${customOrdersEscape(order.refNumber || `Custom #${order.id}`)}</strong>
          <span class="custom-order-status">${customOrdersEscape(customOrderStatusLabel(order.status))}</span>
        </div>
        <span class="custom-order-weight">${customOrdersEscape(customOrderFormatWeight(order.weightLbs))}</span>
        <p class="custom-order-details">${customOrdersEscape(order.orderDetails || "--")}</p>
      </div>
      <div class="custom-order-route" aria-label="Pickup and drop-off route">
        <div class="custom-order-route-step">
          <span class="custom-order-route-icon">P</span>
          <span><strong>Pickup:</strong> ${customOrdersEscape(order.pickupLocation || "--")}</span>
        </div>
        <div class="custom-order-route-step">
          <span class="custom-order-route-icon">D</span>
          <span><strong>Drop-off:</strong> ${customOrdersEscape(order.dropoffLocation || "--")}</span>
        </div>
      </div>
      <div class="custom-order-meta">
        <span>Type: Custom</span>
        <span>Destination stop: ${order.stopMinutes === null ? "Driver timing rule" : `${customOrdersEscape(order.stopMinutes)} min`}</span>
        <span>${customOrdersEscape(createdMeta)}</span>
        ${updatedMeta ? `<span>${customOrdersEscape(updatedMeta)}</span>` : ""}
        ${customOrderAssignmentHtml(order)}
        ${lockReason ? `<span class="custom-order-lock-reason">${customOrdersEscape(lockReason)}</span>` : ""}
      </div>
      <div class="custom-order-card-actions">
        <button
          class="secondary-button"
          data-action="edit-order"
          data-id="${customOrdersEscape(order.id)}"
          ${editLocked || busy ? "disabled" : ""}
          title="${customOrdersEscape(lockReason || "Edit custom order")}"
          type="button"
        >Edit</button>
        <button
          class="custom-order-cancel-button"
          data-action="cancel-order"
          data-id="${customOrdersEscape(order.id)}"
          ${cancelLocked || busy ? "disabled" : ""}
          title="${customOrdersEscape(lockReason || "Cancel custom order")}"
          type="button"
        >${busy ? "Cancelling…" : "Cancel"}</button>
      </div>
    </article>
  `;
}

function renderCustomOrderResults() {
  const list = document.getElementById("customOrdersList");
  const count = document.getElementById("customOrdersCount");
  if (!list || !count) return;
  if (customOrdersState.loading) {
    count.textContent = "Loading custom orders…";
    list.innerHTML = `<div class="custom-orders-loading">Loading custom orders…</div>`;
    return;
  }
  const rows = customOrdersFilteredRows();
  count.textContent = `${rows.length} of ${customOrdersState.orders.length} custom order${customOrdersState.orders.length === 1 ? "" : "s"}`;
  list.innerHTML = rows.map(customOrderCardHtml).join("") || `
    <div class="empty-state">
      <strong>No matching custom orders</strong>
      <span>Change the search or status filter, or create a new custom order.</span>
    </div>
  `;
}

function customOrderNoticeHtml() {
  if (!customOrdersState.notice) return "";
  return `
    <div class="custom-orders-notice ${customOrdersState.notice.kind === "error" ? "error" : ""}" role="${customOrdersState.notice.kind === "error" ? "alert" : "status"}">
      <span>${customOrdersEscape(customOrdersState.notice.message)}</span>
      <button data-action="close-notice" type="button" aria-label="Close message">×</button>
    </div>
  `;
}

function customOrderFormHtml() {
  const editing = Boolean(customOrdersState.editingId);
  const draft = customOrdersState.draft;
  return `
    <section class="custom-order-panel custom-order-editor">
      <div class="custom-order-panel-head">
        <div>
          <h2>${editing ? "Edit custom order" : "Create custom order"}</h2>
          <p>${editing ? "The reference number is locked. Update the unplanned order details below." : "Add a dispatch order that does not exist in NetSuite."}</p>
        </div>
        <span class="custom-order-type">Custom</span>
      </div>
      <form class="custom-order-form" id="customOrderForm">
        <label>
          <span class="custom-order-field-label">Reference number *</span>
          <input
            name="refNumber"
            value="${customOrdersEscape(draft.refNumber)}"
            maxlength="100"
            pattern="[A-Za-z0-9][A-Za-z0-9._:/#+-]*"
            autocomplete="off"
            placeholder="e.g. CUSTOM-2026-001"
            ${editing ? "readonly" : ""}
            required
          />
          <span class="custom-order-field-hint">${editing ? "Reference numbers cannot be changed after creation." : "Must be unique. Start with a letter or number; then use letters, numbers, dot, underscore, colon, slash, hash, plus or hyphen."}</span>
        </label>
        <label>
          <span class="custom-order-field-label">Pickup full location / address *</span>
          <textarea name="pickupLocation" maxlength="500" placeholder="Business or yard name, street address, city and postal code" required>${customOrdersEscape(draft.pickupLocation)}</textarea>
          <span class="custom-order-field-hint">Enter a complete street address, or a configured MBBS yard code such as 3445.</span>
        </label>
        <label>
          <span class="custom-order-field-label">Drop-off full location / address *</span>
          <textarea name="dropoffLocation" maxlength="500" placeholder="Business or yard name, street address, city and postal code" required>${customOrdersEscape(draft.dropoffLocation)}</textarea>
          <span class="custom-order-field-hint">This is the destination used by routing and the driver app.</span>
        </label>
        <label>
          <span class="custom-order-field-label">Order details *</span>
          <textarea name="orderDetails" maxlength="5000" placeholder="Describe what the driver will pick up or deliver, including any handling instructions" required>${customOrdersEscape(draft.orderDetails)}</textarea>
          <span class="custom-order-field-hint">Free text is shown to dispatch and the driver for this non-NetSuite order.</span>
        </label>
        <label>
          <span class="custom-order-field-label">Total weight (lb) *</span>
          <input
            name="weightLbs"
            value="${customOrdersEscape(draft.weightLbs)}"
            type="number"
            min="0.01"
            max="1000000"
            step="0.01"
            inputmode="decimal"
            placeholder="e.g. 1250"
            required
          />
        </label>
        <label>
          <span class="custom-order-field-label">Destination stop time (minutes) *</span>
          <input
            name="stopMinutes"
            value="${customOrdersEscape(draft.stopMinutes)}"
            type="number"
            min="0"
            max="1440"
            step="1"
            inputmode="numeric"
            placeholder="e.g. 35"
            required
          />
          <span class="custom-order-field-hint">Time planned at the drop-off. Pickup time still follows the driver's own-yard or vendor-yard rule.</span>
        </label>
        <div class="custom-order-form-actions">
          ${editing ? `<button class="secondary-button" data-action="discard-edit" type="button" ${customOrdersState.saving ? "disabled" : ""}>Discard changes</button>` : `<button class="secondary-button" data-action="clear-form" type="button" ${customOrdersState.saving ? "disabled" : ""}>Clear</button>`}
          <button class="primary-action" type="submit" ${customOrdersState.saving ? "disabled" : ""}>${customOrdersState.saving ? "Saving…" : editing ? "Save changes" : "Create order"}</button>
        </div>
      </form>
    </section>
  `;
}

function renderCustomOrders() {
  const operator = customOrdersState.operator || {};
  customOrdersApp.innerHTML = `
    <header class="dispatch-topbar">
      <div class="topbar-main">
        <div>
          <p>${customOrdersT("app.transportation", "MBBS Transportation")}</p>
          <h1>Custom Orders</h1>
        </div>
      </div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div>
      <div class="topbar-actions">
        ${customOrdersScmMode ? "" : `<button data-action="go-planning" type="button">Dispatch Planning</button>`}
        <button data-action="go-menu" type="button">${customOrdersT("common.menu", "Menu")}</button>
        <span class="dispatch-user">${customOrdersEscape(operator.display_name || operator.username || "")}</span>
        <button data-action="logout" type="button">${customOrdersT("common.logout", "Logout")}</button>
      </div>
    </header>
    ${customOrderNoticeHtml()}
    <section class="custom-orders-workspace">
      ${customOrderFormHtml()}
      <section class="custom-order-panel custom-orders-list-panel">
        <div class="custom-orders-toolbar">
          <label>
            <span>Search</span>
            <input id="customOrdersSearch" value="${customOrdersEscape(customOrdersState.search)}" placeholder="Reference, address, details, driver…" autocomplete="off" />
          </label>
          <label>
            <span>Status</span>
            <select id="customOrdersStatus">
              <option value="all" ${customOrdersState.status === "all" ? "selected" : ""}>All statuses</option>
              <option value="open" ${customOrdersState.status === "open" ? "selected" : ""}>Open</option>
              <option value="planned" ${customOrdersState.status === "planned" ? "selected" : ""}>Planned</option>
              <option value="in_progress" ${customOrdersState.status === "in_progress" ? "selected" : ""}>In Progress</option>
              <option value="completed" ${customOrdersState.status === "completed" ? "selected" : ""}>Completed</option>
              <option value="cancelled" ${customOrdersState.status === "cancelled" ? "selected" : ""}>Cancelled</option>
            </select>
          </label>
          <button class="secondary-button" data-action="refresh" type="button" ${customOrdersState.loading ? "disabled" : ""}>Refresh</button>
        </div>
        <div class="custom-orders-list-wrap">
          <div class="custom-orders-list-summary">
            <span id="customOrdersCount">Loading custom orders…</span>
            <span>Newest created first</span>
          </div>
          <div class="custom-orders-list" id="customOrdersList"></div>
        </div>
      </section>
    </section>
  `;
  renderCustomOrderResults();
}

function readCustomOrderDraft() {
  const form = document.getElementById("customOrderForm");
  if (!form) return customOrdersState.draft;
  const data = new FormData(form);
  return {
    refNumber: String(data.get("refNumber") || "").trim(),
    pickupLocation: String(data.get("pickupLocation") || "").trim(),
    dropoffLocation: String(data.get("dropoffLocation") || "").trim(),
    orderDetails: String(data.get("orderDetails") || "").trim(),
    weightLbs: String(data.get("weightLbs") || "").trim(),
    stopMinutes: String(data.get("stopMinutes") || "").trim()
  };
}

function validateCustomOrderDraft(draft) {
  if (!draft.refNumber) throw new Error("Reference number is required.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:\/#+-]*$/.test(draft.refNumber)) {
    throw new Error("Reference number must start with a letter or number and use only letters, numbers, dot, underscore, colon, slash, hash, plus or hyphen.");
  }
  if (!draft.pickupLocation) throw new Error("Pickup location / address is required.");
  if (!draft.dropoffLocation) throw new Error("Drop-off location / address is required.");
  if (!draft.orderDetails) throw new Error("Order details are required.");
  const weight = Number(draft.weightLbs);
  if (!Number.isFinite(weight) || weight <= 0) throw new Error("Weight must be greater than zero.");
  const stopMinutes = Number(draft.stopMinutes);
  if (
    String(draft.stopMinutes ?? "").trim() === ""
    || !Number.isInteger(stopMinutes)
    || stopMinutes < 0
    || stopMinutes > 1440
  ) {
    throw new Error("Destination stop time must be a whole number from 0 to 1440 minutes.");
  }
  if (!customOrdersState.editingId) {
    const duplicate = customOrdersState.orders.find((order) => order.refNumber.toLowerCase() === draft.refNumber.toLowerCase());
    if (duplicate) throw new Error(`Reference number ${draft.refNumber} already exists.`);
  }
  return {
    refNumber: draft.refNumber,
    pickupLocation: draft.pickupLocation,
    dropoffLocation: draft.dropoffLocation,
    orderDetails: draft.orderDetails,
    weightLbs: weight,
    stopMinutes
  };
}

function showCustomOrderNotice(message, kind = "success") {
  customOrdersState.notice = { message, kind };
}

async function submitCustomOrder() {
  customOrdersState.draft = readCustomOrderDraft();
  let payload;
  try {
    payload = validateCustomOrderDraft(customOrdersState.draft);
  } catch (error) {
    showCustomOrderNotice(error.message, "error");
    renderCustomOrders();
    return;
  }

  const editingId = customOrdersState.editingId;
  customOrdersState.saving = true;
  customOrdersState.notice = null;
  renderCustomOrders();
  try {
    await customOrdersApi(
      editingId
        ? `${customOrdersApiBase}/${encodeURIComponent(editingId)}`
        : customOrdersApiBase,
      {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify(payload)
      }
    );
    const refNumber = payload.refNumber;
    if (editingId) updateCustomOrderEditUrl();
    customOrdersState.editingId = "";
    customOrdersState.draft = emptyCustomOrderDraft();
    showCustomOrderNotice(editingId ? `${refNumber} was updated.` : `${refNumber} was created and is ready for Dispatch Planning.`);
    await loadCustomOrders();
  } catch (error) {
    showCustomOrderNotice(`${editingId ? "Update" : "Create"} failed: ${error.message}`, "error");
  } finally {
    customOrdersState.saving = false;
    renderCustomOrders();
  }
}

function updateCustomOrderEditUrl(id = "") {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("edit", id);
  else url.searchParams.delete("edit");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function beginCustomOrderEdit(id, { updateUrl = true } = {}) {
  const order = customOrdersState.orders.find((row) => row.id === String(id));
  if (!order) {
    updateCustomOrderEditUrl();
    showCustomOrderNotice("That custom order is no longer available. Refresh the list and try again.", "error");
    renderCustomOrders();
    return;
  }
  if (!order.editable) {
    updateCustomOrderEditUrl();
    showCustomOrderNotice(order.lockedReason || "Only open, unplanned custom orders can be edited.", "error");
    renderCustomOrders();
    return;
  }
  if (updateUrl) updateCustomOrderEditUrl(order.id);
  customOrdersState.editingId = order.id;
  customOrdersState.draft = {
    refNumber: order.refNumber,
    pickupLocation: order.pickupLocation,
    dropoffLocation: order.dropoffLocation,
    orderDetails: order.orderDetails,
    weightLbs: String(order.weightLbs || ""),
    stopMinutes: String(order.stopMinutes ?? 35)
  };
  customOrdersState.notice = null;
  renderCustomOrders();
  document.querySelector(".custom-order-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelector("[name='pickupLocation']")?.focus();
}

function clearCustomOrderForm() {
  updateCustomOrderEditUrl();
  customOrdersState.editingId = "";
  customOrdersState.draft = emptyCustomOrderDraft();
  customOrdersState.notice = null;
  renderCustomOrders();
  document.querySelector("[name='refNumber']")?.focus();
}

async function cancelCustomOrder(id) {
  const order = customOrdersState.orders.find((row) => row.id === String(id));
  if (!order) {
    showCustomOrderNotice("That custom order is no longer available. Refresh the list and try again.", "error");
    renderCustomOrders();
    return;
  }
  if (!order.canCancel) {
    showCustomOrderNotice(order.lockedReason || "Only open, unplanned custom orders can be cancelled.", "error");
    renderCustomOrders();
    return;
  }
  const confirmed = window.confirm(`Cancel custom order ${order.refNumber}? It will remain in Custom Orders with a Cancelled status.`);
  if (!confirmed) return;

  customOrdersState.busyId = order.id;
  customOrdersState.notice = null;
  renderCustomOrderResults();
  try {
    await customOrdersApi(`${customOrdersApiBase}/${encodeURIComponent(order.id)}`, { method: "DELETE" });
    if (customOrdersState.editingId === order.id) {
      updateCustomOrderEditUrl();
      customOrdersState.editingId = "";
      customOrdersState.draft = emptyCustomOrderDraft();
    }
    showCustomOrderNotice(`${order.refNumber} was cancelled and remains available in the record.`);
    await loadCustomOrders();
  } catch (error) {
    showCustomOrderNotice(`Cancel failed: ${error.message}`, "error");
  } finally {
    customOrdersState.busyId = "";
    renderCustomOrders();
  }
}

customOrdersApp.addEventListener("input", (event) => {
  if (event.target?.id === "customOrdersSearch") {
    customOrdersState.search = event.target.value;
    renderCustomOrderResults();
    return;
  }
  if (event.target?.form?.id === "customOrderForm") customOrdersState.draft = readCustomOrderDraft();
});

customOrdersApp.addEventListener("change", (event) => {
  if (event.target?.id === "customOrdersStatus") {
    customOrdersState.status = event.target.value;
    renderCustomOrderResults();
  }
});

customOrdersApp.addEventListener("submit", (event) => {
  if (event.target?.id !== "customOrderForm") return;
  event.preventDefault();
  submitCustomOrder();
});

customOrdersApp.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "close-notice") {
    customOrdersState.notice = null;
    renderCustomOrders();
  } else if (action === "go-planning") {
    location.href = "/dispatch/planning";
  } else if (action === "go-menu") {
    location.href = customOrdersScmMode ? "/scm" : "/dispatch";
  } else if (action === "logout") {
    dispatchLogout();
  } else if (action === "clear-form" || action === "discard-edit") {
    clearCustomOrderForm();
  } else if (action === "edit-order") {
    beginCustomOrderEdit(button.dataset.id);
  } else if (action === "cancel-order") {
    cancelCustomOrder(button.dataset.id);
  } else if (action === "refresh") {
    customOrdersState.notice = null;
    loadCustomOrders().catch((error) => {
      showCustomOrderNotice(`Refresh failed: ${error.message}`, "error");
      renderCustomOrders();
    });
  }
});

window.addEventListener("mbbs-language-changed", renderCustomOrders);

requireDispatchLogin({
  mount: customOrdersApp,
  allowPublicSales: false,
  roles: customOrdersScmMode ? ["admin", "scm", "scm_staff"] : ["dispatcher", "admin"],
  onReady(operator) {
    customOrdersState.operator = operator;
    renderCustomOrders();
    loadCustomOrders().catch((error) => {
      customOrdersState.loading = false;
      showCustomOrderNotice(`Custom orders failed to load: ${error.message}`, "error");
      renderCustomOrders();
    });
  }
});
