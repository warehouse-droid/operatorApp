const app = document.getElementById("driverApp");
const toast = document.getElementById("driverToast");
const TOKEN_KEY = "mbbs.driver.token";
const STAFF_TOKEN_KEY = "mbbs.staff.token";
const STAFF_ROLE_KEY = "mbbs.staff.role";
const STAFF_ROLES_KEY = "mbbs.staff.roles";
const CAMERA_FACING_KEY = "mbbs.camera.facingMode";
const t = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const tf = (key, fallback, variables = {}) => window.MBBS_I18N?.format(key, fallback, variables) || fallback;
const localizeMessage = (message) => window.MBBS_I18N?.message(message) || String(message || "");
const languageToggle = () => window.MBBS_I18N?.toggleHtml() || "";

let authToken = localStorage.getItem(TOKEN_KEY) || "";
let driver = null;
let currentJob = null;
let dayState = null;
let photos = [];
let dvirPhotos = [];
let dvirMode = "";
let orderPages = {};
let photoPromptOpen = false;
let eventSource = null;
let locationCheck = null;
let locationOverrideAccepted = false;
let countdownTimer = null;
let activeRest = null;
let restSummary = null;
let restTimer = null;
let activeView = "job";
let driverHistory = [];
let selectedHistoryId = "";
let historyDate = localDate();
let cameraFacingMode = localStorage.getItem(CAMERA_FACING_KEY) === "user" ? "user" : "environment";
const ITEMS_PER_PAGE = 5;
const COMPLETE_DELAY_MS = 10000;

function staffHomeRoute(role) {
  const clean = String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (clean === "admin") return "/admin";
  if (clean === "dispatcher") return "/dispatch";
  if (clean === "scm" || clean === "scm_staff") return "/scm";
  if (clean === "yard_manager") return "/control";
  if (clean === "operator") return "/operator";
  return "/";
}

async function redirectExistingStaffSession() {
  const staffToken = localStorage.getItem(STAFF_TOKEN_KEY) || "";
  if (!staffToken) return false;
  const response = await fetch("/api/auth/me", {
    headers: { Authorization: `Bearer ${staffToken}` }
  }).catch(() => null);
  if (!response?.ok) {
    localStorage.removeItem(STAFF_TOKEN_KEY);
    localStorage.removeItem(STAFF_ROLE_KEY);
    localStorage.removeItem(STAFF_ROLES_KEY);
    return false;
  }
  const payload = await response.json();
  if (payload.operator?.role) localStorage.setItem(STAFF_ROLE_KEY, payload.operator.role);
  localStorage.setItem(STAFF_ROLES_KEY, JSON.stringify([...new Set([...(Array.isArray(payload.operator?.roles) ? payload.operator.roles : []), payload.operator?.role].filter(Boolean))]));
  window.location.replace(staffHomeRoute(payload.operator?.role));
  return true;
}

function cameraFacingLabel() {
  return cameraFacingMode === "user"
    ? t("common.frontCamera", "Front")
    : t("common.backCamera", "Back");
}

function cameraCaptureMode() {
  return cameraFacingMode === "user" ? "user" : "environment";
}

function switchCameraFacing() {
  cameraFacingMode = cameraFacingMode === "environment" ? "user" : "environment";
  localStorage.setItem(CAMERA_FACING_KEY, cameraFacingMode);
}

function renderCameraSwitchButton() {
  return `<button class="secondary compact camera-mode-button" data-action="switch-camera" type="button">${t("common.switchCamera", "Switch camera")} (${cameraFacingLabel()})</button>`;
}

function localDate() {
  const date = new Date();
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  toast.textContent = localizeMessage(message);
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function planDateText(value) {
  const text = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return t("driver.planDateNotSet", "Plan date not set");
  return window.MBBS_I18N?.displayDate(text) || t("driver.planDateNotSet", "Plan date not set");
}

function dateTimeText(value) {
  return window.MBBS_I18N?.displayDateTime(value) || "";
}

function mapsUrl(job) {
  const destination = job?.address || job?.toAddress || job?.location || "";
  if (!destination) return "";
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=driving&dir_action=navigate`;
}

function completeWaitSeconds(job) {
  if (!job?.startedAt) return 0;
  const startedAt = new Date(job.startedAt).getTime();
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, Math.ceil((COMPLETE_DELAY_MS - (Date.now() - startedAt)) / 1000));
}

function locationCheckApproved() {
  return locationCheck?.status === "ok" || locationOverrideAccepted;
}

function locationCheckBlocksConfirmation() {
  return locationCheck?.status === "checking"
    || (["warning", "unavailable"].includes(locationCheck?.status) && !locationOverrideAccepted);
}

function canBeginJobConfirmation(job) {
  return job?.status === "in_progress" && completeWaitSeconds(job) <= 0 && !locationCheckBlocksConfirmation();
}

function canCompleteCurrentJob(job) {
  return canBeginJobConfirmation(job) && locationCheckApproved();
}

function clearCountdownTimer() {
  clearTimeout(countdownTimer);
  countdownTimer = null;
}

function clearRestTimer() {
  clearTimeout(restTimer);
  restTimer = null;
}

function elapsedSeconds(startedAt) {
  const start = new Date(startedAt || "").getTime();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}

function durationClock(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function dailyRestSeconds() {
  return Math.max(0, Number(restSummary?.completedSeconds || 0)) + elapsedSeconds(activeRest?.startedAt);
}

function updateRestTimerText() {
  const dailyTimer = app.querySelector("[data-rest-daily-timer]");
  const sessionTimer = app.querySelector("[data-rest-session-timer]");
  if (dailyTimer) dailyTimer.textContent = durationClock(dailyRestSeconds());
  if (sessionTimer) sessionTimer.textContent = durationClock(elapsedSeconds(activeRest?.startedAt));
}

function updateCountdownButtons(job) {
  if (!job || currentJob?.jobId !== job.jobId) return;
  const waitSeconds = completeWaitSeconds(job);
  app.querySelectorAll("[data-job-confirm]").forEach((button) => {
    const photosReady = button.dataset.photoRequired !== "true" || photos.filter(Boolean).length >= Number(job.requiredPhotos || 0);
    const gpsReady = button.dataset.gpsGate === "complete"
      ? canCompleteCurrentJob(job)
      : canBeginJobConfirmation(job);
    button.disabled = waitSeconds > 0 || !gpsReady || !photosReady;
    button.textContent = waitSeconds > 0
      ? tf("driver.waitSeconds", "Wait {seconds}s", { seconds: waitSeconds })
      : button.dataset.readyLabel || t("driver.confirm", "Confirm");
  });
}

function scheduleCountdownRender(job) {
  clearCountdownTimer();
  if (!job || job.status !== "in_progress" || completeWaitSeconds(job) <= 0) return;
  countdownTimer = setTimeout(() => {
    updateCountdownButtons(job);
    if (currentJob?.jobId === job.jobId && completeWaitSeconds(job) > 0) scheduleCountdownRender(job);
  }, 1000);
}

function scheduleRestRender() {
  clearRestTimer();
  if (!activeRest?.startedAt) return;
  updateRestTimerText();
  restTimer = setTimeout(scheduleRestRender, 1000);
}

async function checkCurrentJobLocation({ render = true } = {}) {
  if (!currentJob?.jobId) return null;
  locationCheck = { status: "checking", message: t("driver.checkingGps", "Checking Samsara truck GPS against expected stop...") };
  locationOverrideAccepted = false;
  if (render) renderJob();
  try {
    locationCheck = await request(`/api/driver/jobs/${encodeURIComponent(currentJob.jobId)}/location-check`, {
      method: "POST",
      body: JSON.stringify({})
    });
  } catch (error) {
    locationCheck = {
      status: "unavailable",
      message: localizeMessage(error.message || t("driver.gpsUnavailable", "Samsara truck GPS could not be checked."))
    };
  }
  if (render) renderJob();
  return locationCheck;
}

async function ensureLocationApprovalBeforeConfirmation() {
  if (!currentJob || completeWaitSeconds(currentJob) > 0) return false;
  if (!locationCheck) await checkCurrentJobLocation();
  if (locationCheckApproved()) return true;
  showToast("Verify the Samsara GPS location or confirm override before adding photos.");
  renderJob();
  return false;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error || text || "Request failed");
    error.data = data;
    throw error;
  }
  return data;
}

function dataUrlToFile(dataUrl, filename = "photo.jpg") {
  const [header, body] = String(dataUrl || "").split(",");
  const mime = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
  const binary = atob(body || "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], filename, { type: mime });
}

async function uploadDriverPhoto(photo, context = {}) {
  if (!photo || String(photo).startsWith("r2://")) return photo;
  if (!String(photo).startsWith("data:image/")) return photo;
  const ticket = await request("/api/driver/photo-upload-token", {
    method: "POST",
    body: JSON.stringify(context)
  });
  if (ticket.provider === "local_data_url") return photo;
  const file = dataUrlToFile(photo, context.filename || `${context.recordType || "driver-photo"}.jpg`);
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(ticket.uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${ticket.token}` },
    body: formData
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) throw new Error(payload?.error || text || "Photo upload failed.");
  if (!payload?.key) throw new Error("Photo upload did not return an R2 key.");
  return `r2://${payload.key}`;
}

async function uploadDriverPhotos(photoValues, context = {}) {
  const uploaded = [];
  for (let index = 0; index < photoValues.length; index += 1) {
    uploaded.push(await uploadDriverPhoto(photoValues[index], {
      ...context,
      filename: `${context.recordType || "driver-photo"}-${index + 1}.jpg`
    }));
  }
  return uploaded;
}

function photoSrc(value) {
  const text = String(value || "");
  if (!text.startsWith("r2://")) return text;
  return `/api/photo-upload/preview?ref=${encodeURIComponent(text)}&token=${encodeURIComponent(authToken || "")}`;
}

function photoImgSrc(value) {
  return escapeHtml(photoSrc(value));
}

function openPhotoLightbox(photoRef, label = "Photo preview") {
  const ref = String(photoRef || "");
  if (!ref) return;
  document.querySelector(".photo-lightbox")?.remove();
  const modal = document.createElement("div");
  modal.className = "photo-lightbox";
  modal.innerHTML = `
    <div class="photo-lightbox-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(label)}">
      <button class="photo-lightbox-close" type="button">×</button>
      <img src="${photoImgSrc(ref)}" alt="${escapeHtml(label)}" />
    </div>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.closest(".photo-lightbox-close")) modal.remove();
  });
  document.body.appendChild(modal);
}

function renderLogin(message = "") {
  app.innerHTML = `
    <section class="driver-shell">
      <div class="driver-language">${languageToggle()}</div>
      <div class="driver-content">
        <form class="login-panel" data-form="login">
          <div>
            <p>${t("app.driver", "MBBS Driver")}</p>
            <h1>${t("driver.loginTitle", "Driver Login")}</h1>
          </div>
          ${message ? `<div class="message">${escapeHtml(localizeMessage(message))}</div>` : ""}
          <label>
            <span>${t("common.login", "Login")}</span>
            <input id="driverLogin" autocomplete="username" required />
          </label>
          <label>
            <span>${t("common.password", "Password")}</span>
            <input id="driverPassword" type="password" autocomplete="current-password" />
          </label>
          <button class="primary" type="submit">${t("common.login", "Login")}</button>
        </form>
      </div>
    </section>
  `;
}

function shell(content) {
  const switchWarning = dayState?.truckSwitchAttention?.[0];
  app.innerHTML = `
    <section class="driver-shell">
      <div class="driver-language">${languageToggle()}</div>
      <div class="driver-content">
        ${switchWarning ? `<div class="truck-switch-attention"><strong>${t("driver.switchAttention", "Samsara truck assignment needs attention")}</strong><span>${escapeHtml(switchWarning.fromTruckPlate || t("driver.previousTruck", "Previous truck"))} to ${escapeHtml(switchWarning.toTruckPlate || t("driver.newTruck", "new truck"))}: ${escapeHtml(switchWarning.error || t("driver.switchRetryHelp", "Reassignment failed. Retry the switch or contact dispatch."))}</span></div>` : ""}
        ${content}
      </div>
    </section>
  `;
}

function truckSwitchAttentionForJob(job) {
  if (!job?.jobId || job.stopType !== "truck_switch") return null;
  return (dayState?.truckSwitchAttention || []).find((item) => item.jobId === job.jobId) || null;
}

function renderNoJob() {
  clearCountdownTimer();
  if (activeRest) scheduleRestRender();
  else clearRestTimer();
  shell(`
    <section class="empty-panel">
      <h2>${t("driver.noJob", "No assigned job")}</h2>
      <p>${t("driver.noJobHelp", "No pending stop was found for your login in the confirmed dispatch plans.")}</p>
      <div class="empty-actions">
        <button class="primary" data-action="refresh" type="button">${t("common.refresh", "Refresh")}</button>
        <button class="secondary" data-action="open-history" type="button">${t("common.history", "History")}</button>
      </div>
    </section>
    ${activeRest ? renderRestModal() : ""}
  `);
}

function renderDvir(type = "pre", message = "") {
  clearCountdownTimer();
  const labels = [
    t("driver.driverSide", "Driver side"),
    t("driver.front", "Front"),
    t("driver.passengerSide", "Passenger side"),
    t("driver.back", "Back")
  ];
  dvirMode = type;
  while (dvirPhotos.length < 4) dvirPhotos.push("");
  const isPost = type === "post";
  const needsSamsaraRetry = false;
  shell(`
    <section class="job-panel dvir-panel">
      <div class="job-sticky">
        <div class="plan-meta-row">
          <span>${escapeHtml(planDateText(dayState?.planDate))}</span>
          <span>${escapeHtml(driver?.name || "-")}</span>
          <span>${escapeHtml(dayState?.truckPlate || "-")}</span>
        </div>
        <div class="job-head">
          <div class="job-title-row">
            <span class="job-type ${isPost ? "dropoff" : ""}">${isPost ? t("driver.postTrip", "Post-Trip") : t("driver.preTrip", "Pre-Trip")}</span>
            <h2>${escapeHtml(dayState?.truckPlate || t("driver.truckInspection", "Truck Inspection"))}</h2>
          </div>
        </div>
      </div>
      ${message ? `<div class="message">${escapeHtml(localizeMessage(message))}</div>` : ""}
      <div class="photo-grid dvir-photo-grid">
        ${dvirPhotos.map((photo, index) => {
          const label = labels[index] || tf("driver.additionalPhoto", "Additional photo {number}", { number: index - labels.length + 1 });
          return `
          <div class="photo-slot dvir-photo-slot">
            <input data-dvir-photo-index="${index}" type="file" accept="image/*" capture="${cameraCaptureMode()}" />
            <div class="photo-preview">${photo ? `<img src="${photo}" alt="${escapeHtml(label)}" />` : escapeHtml(label)}</div>
            <button data-action="take-dvir-photo" data-dvir-photo-index="${index}" type="button">${t("common.camera", "Camera")}</button>
          </div>
        `;
        }).join("")}
      </div>
      <div class="photo-list-actions">
        <button class="secondary compact" data-action="add-dvir-photo" type="button">${t("common.addAnotherPhoto", "Add another photo")}</button>
        ${dvirPhotos.length > 4 ? `<button class="secondary compact danger-button" data-action="remove-dvir-photo" type="button">${t("common.removeLastPhoto", "Remove last photo")}</button>` : ""}
      </div>
      <div class="job-actions">
        <button class="primary" data-action="submit-dvir" ${dvirPhotos.filter(Boolean).length >= 4 ? "" : "disabled"} type="button">${isPost ? t("driver.submitPostTrip", "Submit Post-Trip") : t("driver.submitPreTrip", "Submit Pre-Trip")}</button>
        ${renderCameraSwitchButton()}
        <button class="secondary compact" data-action="skip-dvir" type="button">${t("driver.skipDvirTest", "Skip DVIR Test")}</button>
        <button class="secondary compact" data-action="refresh" type="button">${t("common.refresh", "Refresh")}</button>
        <button class="secondary compact" data-action="open-history" type="button">${t("common.history", "History")}</button>
      </div>
    </section>
  `);
}

function unitPills(units = []) {
  return units.map((unit) => `
    <span class="unit-pill ${unit.fallback ? "fallback" : ""}">${Number(unit.value || 0).toLocaleString()} ${escapeHtml(unit.unit)}</span>
  `).join("");
}

function orderKey(order, index) {
  return `${order.orderRef || "order"}-${index}`;
}

function renderOrders(job) {
  return (job.orders || []).map((order, orderIndex) => {
    const items = order.items || [];
    const key = orderKey(order, orderIndex);
    const pageCount = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE));
    const page = Math.min(Math.max(Number(orderPages[key] || 0), 0), pageCount - 1);
    orderPages[key] = page;
    const pageItems = items.slice(page * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE + ITEMS_PER_PAGE);
    return `
    <section class="order-card">
      <div>
        <h3>${escapeHtml(order.orderRef)}</h3>
      </div>
      <div class="item-list">
        ${pageItems.map((item) => `
          <div class="item-row">
            <div class="item-main-row">
              <strong>${escapeHtml(item.itemName || item.sku || t("driver.item", "Item"))}</strong>
              <div class="unit-row">${unitPills(item.units)}</div>
            </div>
            ${item.description ? `<span class="item-description">${escapeHtml(item.description)}</span>` : ""}
          </div>
        `).join("") || `<div class="item-row"><strong>${t("driver.noItemDetail", "No item detail found in local DB")}</strong></div>`}
      </div>
      ${items.length > ITEMS_PER_PAGE ? `
        <div class="order-pager">
          <button data-action="order-page" data-order-key="${escapeHtml(key)}" data-page="${page - 1}" ${page <= 0 ? "disabled" : ""} type="button">${t("common.previous", "Previous")}</button>
          <span>${page + 1} / ${pageCount}</span>
          <button data-action="order-page" data-order-key="${escapeHtml(key)}" data-page="${page + 1}" ${page >= pageCount - 1 ? "disabled" : ""} type="button">${t("common.next", "Next")}</button>
        </div>
      ` : ""}
    </section>
  `;
  }).join("");
}

function renderLocationCheck(job) {
  if (!job || job.status !== "in_progress") return "";
  const status = locationCheck?.status || "unavailable";
  const text = localizeMessage(locationCheck?.message || t("driver.gpsNotRun", "Samsara truck GPS check has not run yet."));
  const detail = locationCheck?.expectedAddress
    ? `<small>${t("driver.expected", "Expected")}: ${escapeHtml(locationCheck.expectedAddress)}</small>`
    : "";
  const truckDetail = locationCheck?.truckFormattedLocation
    ? `<small>${t("driver.truck", "Truck")}: ${escapeHtml(locationCheck.truckFormattedLocation)}</small>`
    : "";
  return `
    <section class="location-check ${escapeHtml(status)}">
      <div>
        <strong>${status === "ok" ? t("driver.locationVerified", "Location verified") : status === "warning" ? t("driver.locationWarning", "Location warning") : status === "checking" ? t("driver.checkingLocation", "Checking location") : t("driver.locationNotVerified", "Location not verified")}</strong>
        <span>${escapeHtml(text)}</span>
        ${detail}
        ${truckDetail}
      </div>
      <div class="location-actions">
        <button class="secondary compact" data-action="recheck-location" ${status === "checking" ? "disabled" : ""} type="button">${t("driver.recheck", "Recheck")}</button>
        ${["warning", "unavailable"].includes(status) && !locationOverrideAccepted ? `<button class="secondary compact danger-button" data-action="override-location" type="button">${t("driver.override", "Override")}</button>` : ""}
      </div>
    </section>
  `;
}

function renderPhotoSlots(job) {
  if (!job.requiredPhotos) {
    return `
      <section class="photo-panel">
        <h3>${t("driver.noPhotosRequired", "No photos required")}</h3>
        <button class="primary" data-action="complete-job" type="button">${t("driver.completeTravel", "Complete Travel")}</button>
      </section>
    `;
  }
  const minimumPhotos = Math.max(2, Number(job.requiredPhotos || 0));
  while (photos.length < minimumPhotos) photos.push("");
  return `
    <div class="photo-modal" role="dialog" aria-modal="true" aria-label="${tf("driver.photosRequired", "At least {count} photos required", { count: minimumPhotos })}">
      <section class="photo-panel">
        <div class="photo-head">
          <h3>${tf("driver.photosRequired", "At least {count} photos required", { count: minimumPhotos })}</h3>
          ${renderCameraSwitchButton()}
          <button class="icon-button" data-action="close-photo" aria-label="${t("driver.closePhoto", "Close photo")}" title="${t("driver.closePhoto", "Close photo")}" type="button">X</button>
        </div>
        <div class="photo-grid">
          ${photos.map((photo, index) => `
            <div class="photo-slot">
              <input data-photo-index="${index}" type="file" accept="image/*" capture="${cameraCaptureMode()}" />
              <div class="photo-preview">${photo ? `<img src="${photo}" alt="${t("common.photos", "Photo")} ${index + 1}" />` : `${t("common.photos", "Photo")} ${index + 1}`}</div>
              <button data-action="take-photo" data-photo-index="${index}" type="button">${t("common.camera", "Camera")}</button>
            </div>
          `).join("")}
        </div>
        <div class="photo-list-actions">
          <button class="secondary compact" data-action="add-job-photo" type="button">${t("common.addAnotherPhoto", "Add another photo")}</button>
          ${photos.length > minimumPhotos ? `<button class="secondary compact danger-button" data-action="remove-job-photo" type="button">${t("common.removeLastPhoto", "Remove last photo")}</button>` : ""}
        </div>
        <button class="primary" data-action="complete-job" data-job-confirm data-gps-gate="complete" data-photo-required="true" data-ready-label="${t("driver.completeStop", "Complete Stop")}" ${photos.filter(Boolean).length >= minimumPhotos && canCompleteCurrentJob(job) ? "" : "disabled"} type="button">${completeWaitSeconds(job) > 0 ? tf("driver.waitSeconds", "Wait {seconds}s", { seconds: completeWaitSeconds(job) }) : t("driver.completeStop", "Complete Stop")}</button>
      </section>
    </div>
  `;
}

function renderJob() {
  if (activeRest) scheduleRestRender();
  else clearRestTimer();
  const job = currentJob;
  if (!job) return renderNoJob();
  const isPickup = job.stopType === "pickup";
  const isTravel = job.stopType === "travel";
  const isTruckSwitch = job.stopType === "truck_switch";
  const switchAttention = truckSwitchAttentionForJob(job);
  const isStarted = job.status === "in_progress";
  const typeText = isTruckSwitch ? t("driver.truckSwitch", "Truck Switch") : isTravel ? t("driver.travel", "Travel") : isPickup ? t("driver.pickup", "Pickup") : t("driver.dropoff", "Drop Off");
  const titleText = isTruckSwitch
    ? `${job.fromTruckPlate || "-"} to ${job.nextTruckPlate || job.truckPlate || "-"}`
    : isTravel ? job.location : (job.location || job.address || t("driver.stop", "Stop"));
  const navigationUrl = mapsUrl(job);
  const waitSeconds = completeWaitSeconds(job);
  const confirmDisabled = !canBeginJobConfirmation(job);
  scheduleCountdownRender(job);
  shell(`
    <section class="job-panel">
      <div class="job-sticky">
        <div class="plan-meta-row">
          <span>${escapeHtml(planDateText(job.planDate))}</span>
          <span>${escapeHtml(job.driverName || driver?.name || "-")}</span>
          <span>${escapeHtml(job.truckPlate || "-")}</span>
        </div>
        <div class="job-head">
          <div class="job-title-row">
            <span class="job-type ${isTruckSwitch ? "truck-switch" : isTravel ? "travel" : isPickup ? "" : "dropoff"}">${typeText}</span>
            <h2>${escapeHtml(titleText)}</h2>
          </div>
          <button class="rest-toggle" data-action="start-rest" type="button">${t("driver.rest", "Rest")}</button>
        </div>
        <div class="address-block">
          <div>
            <span>${isTruckSwitch ? t("driver.switchYard", "Switch yard") : isTravel ? t("driver.travelDestination", "Travel destination") : isPickup ? t("driver.pickupAddress", "Pickup address / yard") : t("driver.deliveryAddress", "Delivery address")}</span>
            <strong>${escapeHtml(job.address || job.location || "")}</strong>
            ${isTravel && job.fromAddress ? `<em>${tf("driver.startAddress", "Start: {address}", { address: escapeHtml(job.fromAddress) })}</em>` : ""}
            ${isTruckSwitch ? `<em>${t("driver.nextLoad", "Next load")}: ${escapeHtml(job.loadName || job.loadId || "-")} | ${t("driver.parkingSpot", "Parking spot")}: ${escapeHtml(job.parkingSpot || "-")}</em>` : ""}
          </div>
          ${navigationUrl ? `<a class="map-button" href="${navigationUrl}" target="_blank" rel="noopener">${t("driver.maps", "Maps")}</a>` : ""}
        </div>
      </div>
      ${isTruckSwitch ? `<section class="truck-switch-summary">
        <div><span>${t("driver.currentTruck", "Current truck")}</span><strong>${escapeHtml(job.fromTruckPlate || "-")}</strong></div>
        <div><span>${t("driver.nextTruck", "Next truck")}</span><strong>${escapeHtml(job.nextTruckPlate || job.truckPlate || "-")}</strong></div>
        <p>${escapeHtml(job.instructions || t("driver.switchInstruction", "Park the current truck and confirm after entering the next truck."))}</p>
      </section>` : renderLocationCheck(job)}
      ${isTravel || isTruckSwitch ? "" : renderOrders(job)}
      <div class="job-actions ${isTruckSwitch ? "truck-switch-job-actions" : ""}">
        ${isTruckSwitch
          ? `<div class="truck-switch-action-set">
              <button class="primary" data-action="confirm-truck-switch" type="button">${switchAttention ? t("driver.retryTruckSwitch", "Retry Samsara & Confirm") : t("driver.confirmTruckSwitch", "Confirm Truck Switch")}</button>
              <button class="secondary danger-button skip-samsara-button" data-action="skip-samsara-switch" type="button">${t("driver.skipSamsara", "Skip Samsara & Confirm")}</button>
            </div>`
          : isStarted
          ? `<button class="primary" data-action="${job.requiredPhotos ? "show-photo" : "complete-job"}" data-job-confirm data-gps-gate="begin" data-ready-label="${t("driver.confirm", "Confirm")}" ${confirmDisabled ? "disabled" : ""} type="button">${waitSeconds > 0 ? tf("driver.waitSeconds", "Wait {seconds}s", { seconds: waitSeconds }) : t("driver.confirm", "Confirm")}</button>`
          : `<button class="primary" data-action="start-job" type="button">${t("common.start", "Start")}</button>`}
        <button class="secondary compact" data-action="refresh" type="button">${t("common.refresh", "Refresh")}</button>
        <button class="secondary compact" data-action="open-history" type="button">${t("common.history", "History")}</button>
      </div>
      ${photoPromptOpen ? renderPhotoSlots(job) : ""}
    </section>
    ${activeRest ? renderRestModal() : ""}
  `);
}

function renderRestModal() {
  const rest = activeRest;
  if (!rest) return "";
  const sessionCount = Math.max(1, Number(restSummary?.sessionCount || 0));
  return `
    <div class="rest-modal" role="dialog" aria-modal="true" aria-labelledby="restTimerTitle">
      <section class="rest-timer-panel">
        <div class="rest-timer-head">
          <span class="rest-status-dot" aria-hidden="true"></span>
          <div>
            <span>${t("driver.restInProgress", "Rest in progress")}</span>
            <h2 id="restTimerTitle">${t("driver.todayAccumulatedRest", "Today's accumulated rest")}</h2>
          </div>
        </div>
        <div class="rest-daily-total">
          <strong data-rest-daily-timer>${durationClock(dailyRestSeconds())}</strong>
          <span>${tf("driver.totalRestFor", "Total rest for {date}", { date: escapeHtml(planDateText(rest.planDate || restSummary?.planDate || currentJob?.planDate)) })}</span>
        </div>
        <div class="rest-session-grid">
          <div>
            <span>${t("driver.currentSession", "Current session")}</span>
            <strong data-rest-session-timer>${durationClock(elapsedSeconds(rest.startedAt))}</strong>
          </div>
          <div>
            <span>${t("driver.sessionsToday", "Sessions today")}</span>
            <strong>${sessionCount}</strong>
          </div>
        </div>
        <p>${t("driver.restStatisticsHelp", "Rest time that overlaps a started stop is automatically deducted from that stop's service-time statistics.")}</p>
        <button class="primary rest-end-button" data-action="end-rest" type="button">${t("driver.endRest", "End rest time")}</button>
      </section>
    </div>
  `;
}

function renderRest() {
  return renderJob();
}

async function loadDriverHistory({ keepSelection = false } = {}) {
  activeView = "history";
  clearCountdownTimer();
  const params = new URLSearchParams({ limit: "100" });
  if (historyDate) params.set("date", historyDate);
  const result = await request(`/api/driver/history?${params.toString()}`);
  driverHistory = [...(result.records || [])].sort((left, right) =>
    new Date(left.createdAt || 0) - new Date(right.createdAt || 0)
      || String(left.id || "").localeCompare(String(right.id || ""))
  );
  if (!keepSelection || !driverHistory.some((item) => String(item.id) === String(selectedHistoryId))) selectedHistoryId = "";
  renderDriverHistory();
}

function historyTypeText(record) {
  if (!record) return t("driver.record", "Record");
  if (record.type === "pre_dvir") return t("driver.preTrip", "Pre-Trip");
  if (record.type === "post_dvir") return t("driver.postTrip", "Post-Trip");
  return record.title || t("driver.stop", "Stop");
}

function renderHistoryPhotos(record) {
  const photos = (record?.photos || []).filter(Boolean);
  if (!photos.length) return `<div class="history-empty small">${t("driver.noPhotosSaved", "No photos saved for this record.")}</div>`;
  return `
    <div class="history-photo-grid">
      ${photos.map((photo, index) => `
        <button class="history-photo-button" data-action="open-history-photo" data-photo-ref="${escapeHtml(photo)}" data-photo-label="${tf("driver.historyPhotoNumber", "{type} photo {number}", { type: historyTypeText(record), number: index + 1 })}" type="button">
          <img src="${photoImgSrc(photo)}" alt="${tf("driver.historyPhotoNumber", "{type} photo {number}", { type: historyTypeText(record), number: index + 1 })}" />
        </button>
      `).join("")}
    </div>
  `;
}

function renderDriverHistory() {
  const historyWasVisible = Boolean(app.querySelector(".history-panel"));
  const previousScrollTop = historyWasVisible ? Number(app.querySelector(".driver-content")?.scrollTop || 0) : 0;
  shell(`
    <section class="history-panel">
      <div class="history-head">
        <div>
          <p>${escapeHtml(driver?.name || t("stats.driver", "Driver"))}</p>
          <h2>${t("driver.personalHistory", "Personal History")}</h2>
        </div>
        <button class="secondary compact" data-action="back-job" type="button">${t("common.back", "Back")}</button>
      </div>
      <div class="history-filter">
        <input id="driverHistoryDate" type="date" value="${escapeHtml(historyDate)}" />
        <button class="secondary compact" data-action="refresh-history" type="button">${t("common.refresh", "Refresh")}</button>
      </div>
      <div class="history-list">
        ${driverHistory.map((record) => {
          const expanded = String(record.id) === String(selectedHistoryId);
          return `
          <section class="history-entry ${expanded ? "expanded" : ""}">
            <button class="history-record ${expanded ? "active" : ""}" data-action="select-history" data-record="${escapeHtml(record.id)}" aria-expanded="${expanded}" type="button">
              <span class="history-record-copy">
                <strong>${escapeHtml(historyTypeText(record))}</strong>
                <span>${escapeHtml(record.reference || record.truckPlate || "-")}</span>
              </span>
              <span class="history-record-side">
                <em>${dateTimeText(record.createdAt)}</em>
                <span class="history-toggle-symbol" aria-hidden="true">${expanded ? "-" : "+"}</span>
              </span>
            </button>
            ${expanded ? `<div class="history-inline-detail">
              <div class="history-detail-title">
                <strong>${escapeHtml(historyTypeText(record))}</strong>
                <span>${escapeHtml(localizeMessage(record.status || ""))}</span>
              </div>
              <div class="history-meta">
                <span>${escapeHtml(planDateText(record.planDate))}</span>
                <span>${escapeHtml(record.truckPlate || "")}</span>
                <span>${escapeHtml(record.details?.loadName || record.details?.samsaraDvirId || "")}</span>
              </div>
              ${renderHistoryPhotos(record)}
            </div>` : ""}
          </section>`;
        }).join("") || `<div class="history-empty">${t("driver.noHistory", "No history for this date.")}</div>`}
      </div>
    </section>
  `);
  const historyScroller = app.querySelector(".driver-content");
  if (historyScroller) historyScroller.scrollTop = previousScrollTop;
}

async function loadNextJob() {
  activeView = "job";
  clearRestTimer();
  const stateResult = await request("/api/driver/day-state");
  dayState = stateResult.state;
  if (dayState?.truckPlate && (dayState.preDvirStatus !== "complete" || !dayState.samsaraOnDutyConfirmed || !dayState.samsaraPreDvirConfirmed)) {
    currentJob = null;
    dvirPhotos = [];
    const message = dayState.preDvirStatus === "complete" && (!dayState.samsaraOnDutyConfirmed || !dayState.samsaraPreDvirConfirmed)
      ? tf("driver.samsaraInspectionRetry", "Samsara did not receive/verify the inspection. Please redo it in MBBS PWA. {detail}", {
          detail: localizeMessage(dayState.samsaraOnDutyError || t("driver.samsaraDvirPermissionHelp", "Check Samsara DVIR author ID and Write DVIRs permission."))
        })
      : "";
    return renderDvir("pre", message);
  }
  let result;
  try {
    result = await request("/api/driver/next-job");
  } catch (error) {
    if (error.data?.state) {
      dayState = error.data.state;
      currentJob = null;
      dvirPhotos = [];
      return renderDvir(dayState.preDvirStatus !== "complete" ? "pre" : "post", error.message);
    }
    throw error;
  }
  currentJob = result.job;
  activeRest = result.rest || null;
  restSummary = result.restSummary || null;
  photos = [];
  dvirMode = "";
  dvirPhotos = [];
  orderPages = {};
  photoPromptOpen = false;
  locationCheck = null;
  locationOverrideAccepted = false;
  if (!currentJob && dayState?.allJobsComplete && dayState.postDvirStatus !== "complete") {
    return renderDvir("post", t("driver.postTripRequired", "All assigned jobs are complete. MBBS post-trip inspection is required before logout."));
  }
  renderJob();
}

function connectEvents() {
  if (!authToken || eventSource) return;
  eventSource = new EventSource(`/api/events?client=driver&token=${encodeURIComponent(authToken)}`);
  eventSource.addEventListener("app-event", async (message) => {
    let event;
    try {
      event = JSON.parse(message.data || "{}");
    } catch {
      return;
    }
    if (event.type === "connected") return;
    const relevant = [
      "dispatch.plan.saved",
      "dispatch.plan.confirmed",
      "dispatch.plan.reopened",
      "driver.job.started",
      "driver.job.completed",
      "driver.truck.switched",
      "driver.truck.switch.overridden",
      "driver.truck.switch.samsara_skipped",
      "driver.rest.started",
      "driver.rest.ended",
      "delivery.order.loaded"
    ].includes(event.type);
    if (!relevant || !driver) return;
    if (photoPromptOpen || photos.some(Boolean)) {
      showToast("Job updated. Finish or close photos to refresh.");
      return;
    }
    if (activeView === "history") {
      await loadDriverHistory({ keepSelection: true }).catch((error) => showToast(error.message));
      return;
    }
    const beforeJobId = currentJob?.jobId || "";
    try {
      await loadNextJob();
      if ((currentJob?.jobId || "") !== beforeJobId) showToast("Job updated");
    } catch (error) {
      showToast(error.message);
    }
  });
  eventSource.onerror = () => {
    eventSource?.close();
    eventSource = null;
    if (authToken) window.setTimeout(connectEvents, 3000);
  };
}

function disconnectEvents() {
  eventSource?.close();
  eventSource = null;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

app.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "logout") {
    try {
      await request("/api/driver/logout", { method: "POST" });
    } catch (error) {
      if (error.data?.state) {
        dayState = error.data.state;
        dvirPhotos = [];
        return renderDvir("post", error.message);
      }
      showToast(error.message);
      return;
    }
    localStorage.removeItem(TOKEN_KEY);
    authToken = "";
    driver = null;
    currentJob = null;
    activeRest = null;
    restSummary = null;
    disconnectEvents();
    return renderLogin();
  }
  if (action === "refresh") {
    try {
      await loadNextJob();
      showToast("Job refreshed");
    } catch (error) {
      showToast(error.message);
    }
  }
  if (action === "open-history") {
    try {
      await loadDriverHistory();
    } catch (error) {
      showToast(error.message);
    }
  }
  if (action === "back-job") {
    try {
      await loadNextJob();
    } catch (error) {
      showToast(error.message);
    }
  }
  if (action === "refresh-history") {
    historyDate = document.getElementById("driverHistoryDate")?.value || historyDate;
    try {
      await loadDriverHistory({ keepSelection: true });
    } catch (error) {
      showToast(error.message);
    }
  }
  if (action === "select-history") {
    const recordId = button.dataset.record || "";
    selectedHistoryId = String(selectedHistoryId) === String(recordId) ? "" : recordId;
    return renderDriverHistory();
  }
  if (action === "open-history-photo") {
    openPhotoLightbox(button.dataset.photoRef, button.dataset.photoLabel || "History photo");
    return;
  }
  if (action === "order-page") {
    orderPages[button.dataset.orderKey] = Number(button.dataset.page || 0);
    return renderJob();
  }
  if (action === "show-photo") {
    if (!(await ensureLocationApprovalBeforeConfirmation())) return;
    photoPromptOpen = true;
    return renderJob();
  }
  if (action === "recheck-location") {
    await checkCurrentJobLocation();
    return;
  }
  if (action === "override-location") {
    locationOverrideAccepted = true;
    showToast("Location override accepted for this stop");
    return renderJob();
  }
  if (action === "start-rest") {
    button.disabled = true;
    button.textContent = localizeMessage("Starting rest...");
    try {
      const result = await request("/api/driver/rest/start", {
        method: "POST",
        body: JSON.stringify({})
      });
      activeRest = result.rest;
      restSummary = result.restSummary || restSummary;
      currentJob = result.job || currentJob;
      showToast("Rest started");
      return renderRest();
    } catch (error) {
      showToast(error.message);
      return renderJob();
    }
  }
  if (action === "end-rest") {
    button.disabled = true;
    button.textContent = localizeMessage("Ending rest...");
    try {
      const result = await request("/api/driver/rest/end", {
        method: "POST",
        body: JSON.stringify({})
      });
      activeRest = null;
      restSummary = result.restSummary || restSummary;
      currentJob = result.job || currentJob;
      showToast("Rest ended");
      return renderJob();
    } catch (error) {
      showToast(error.message);
      return renderRest();
    }
  }
  if (action === "close-photo") {
    photoPromptOpen = false;
    return renderJob();
  }
  if (action === "switch-camera") {
    switchCameraFacing();
    if (dvirMode) return renderDvir(dvirMode);
    return renderJob();
  }
  if (action === "take-photo") {
    const input = app.querySelector(`input[data-photo-index="${button.dataset.photoIndex}"]`);
    input?.click();
  }
  if (action === "take-dvir-photo") {
    const input = app.querySelector(`input[data-dvir-photo-index="${button.dataset.dvirPhotoIndex}"]`);
    input?.click();
  }
  if (action === "add-job-photo") {
    photos.push("");
    return renderJob();
  }
  if (action === "remove-job-photo") {
    if (photos.length > Math.max(2, Number(currentJob?.requiredPhotos || 0))) photos.pop();
    return renderJob();
  }
  if (action === "add-dvir-photo") {
    dvirPhotos.push("");
    return renderDvir(dvirMode || "pre");
  }
  if (action === "remove-dvir-photo") {
    if (dvirPhotos.length > 4) dvirPhotos.pop();
    return renderDvir(dvirMode || "pre");
  }
  if (action === "submit-dvir") {
    button.disabled = true;
    button.textContent = t("common.uploading", "Uploading...");
    try {
      const type = dvirMode || "pre";
      const uploadedPhotos = await uploadDriverPhotos(dvirPhotos.filter(Boolean), {
        recordType: type === "post" ? "driver-dvir-post-photo" : "driver-dvir-pre-photo",
        dvirType: type
      });
      button.textContent = t("common.saving", "Saving...");
      const result = await request("/api/driver/dvir", {
        method: "POST",
        body: JSON.stringify({ type, photoDataUrls: uploadedPhotos })
      });
      dayState = result.state;
      const warning = result.samsaraError ? `Samsara did not receive it: ${result.samsaraError}` : "MBBS inspection saved. Samsara confirmed.";
      dvirPhotos = [];
      dvirMode = "";
      showToast(warning);
      await loadNextJob();
    } catch (error) {
      showToast(error.message);
      renderDvir(dvirMode || "pre", error.message);
    }
  }
  if (action === "skip-dvir") {
    button.disabled = true;
    button.textContent = `${t("driver.skipDvirTest", "Skipping DVIR Test")}...`;
    try {
      const result = await request("/api/driver/dvir/skip", {
        method: "POST",
        body: JSON.stringify({ type: dvirMode || "pre" })
      });
      dayState = result.state;
      dvirPhotos = [];
      dvirMode = "";
      showToast("DVIR skipped for testing");
      await loadNextJob();
    } catch (error) {
      showToast(error.message);
      renderDvir(dvirMode || "pre", error.message);
    }
  }
  if (action === "start-job" && currentJob) {
    if (activeRest) {
      showToast("End rest time before starting the next job.");
      return renderRest();
    }
    button.disabled = true;
    button.textContent = `${t("common.start", "Start")}...`;
    try {
      const result = await request(`/api/driver/jobs/${encodeURIComponent(currentJob.jobId)}/start`, {
        method: "POST",
        body: JSON.stringify({})
      });
      currentJob = result.job;
      locationCheck = null;
      locationOverrideAccepted = false;
      renderJob();
      showToast("Job started");
      checkCurrentJobLocation().catch((error) => showToast(error.message));
    } catch (error) {
      if (error.data?.rest) {
        activeRest = error.data.rest;
        showToast(error.message);
        return renderRest();
      }
      showToast(error.message);
      renderJob();
    }
  }
  if (action === "confirm-truck-switch" && currentJob?.stopType === "truck_switch") {
    if (activeRest) {
      showToast(t("driver.endRestBeforeSwitch", "End rest time before switching trucks."));
      return renderRest();
    }
    button.disabled = true;
    button.textContent = `${t("driver.confirmTruckSwitch", "Confirm Truck Switch")}...`;
    try {
      const result = await request(`/api/driver/jobs/${encodeURIComponent(currentJob.jobId)}/confirm-truck-switch`, {
        method: "POST",
        body: JSON.stringify({})
      });
      dayState = result.state || dayState;
      currentJob = result.job || null;
      locationCheck = null;
      locationOverrideAccepted = false;
      renderJob();
      showToast(t("driver.switchConfirmed", "Truck switch confirmed"));
    } catch (error) {
      showToast(`${t("driver.switchFailed", "Truck switch failed")}: ${error.message}`);
      await loadNextJob().catch(() => renderJob());
    }
  }
  if (action === "skip-samsara-switch" && currentJob?.stopType === "truck_switch") {
    if (activeRest) {
      showToast(t("driver.endRestBeforeSwitch", "End rest time before switching trucks."));
      return renderRest();
    }
    const confirmed = window.confirm(tf(
      "driver.skipSamsaraConfirm",
      "Skip Samsara assignment and confirm the switch from {from} to {to} in MBBS? Samsara will remain unresolved.",
      {
        from: currentJob.fromTruckPlate || "-",
        to: currentJob.nextTruckPlate || currentJob.truckPlate || "-"
      }
    ));
    if (!confirmed) return;
    button.disabled = true;
    button.textContent = `${t("driver.skipSamsara", "Skip Samsara & Confirm")}...`;
    try {
      const result = await request(`/api/driver/jobs/${encodeURIComponent(currentJob.jobId)}/skip-samsara`, {
        method: "POST",
        body: JSON.stringify({})
      });
      dayState = result.state || dayState;
      currentJob = result.job || null;
      locationCheck = null;
      locationOverrideAccepted = false;
      renderJob();
      showToast(t("driver.samsaraSkipped", "Truck switch confirmed in MBBS. Samsara was skipped."));
    } catch (error) {
      showToast(`${t("driver.skipSamsaraFailed", "Could not skip Samsara")}: ${error.message}`);
      await loadNextJob().catch(() => renderJob());
    }
  }
  if (action === "complete-job" && currentJob) {
    if (!canBeginJobConfirmation(currentJob)) {
      if (completeWaitSeconds(currentJob) > 0) showToast(`Please wait ${completeWaitSeconds(currentJob)} seconds.`);
      else if (locationCheckBlocksConfirmation()) showToast("Recheck location or confirm override first.");
      return renderJob();
    }
    if (!(await ensureLocationApprovalBeforeConfirmation())) return;
    button.disabled = true;
    button.textContent = t("common.uploading", "Uploading...");
    try {
      if (locationCheckBlocksConfirmation() || !locationCheckApproved()) {
        showToast("Recheck location or confirm override first.");
        return renderJob();
      }
      const uploadedPhotos = await uploadDriverPhotos(photos.filter(Boolean), {
        recordType: currentJob.stopType === "pickup" ? "driver-pickup-photo"
          : currentJob.stopType === "dropoff" ? "driver-dropoff-photo"
            : "driver-stop-photo",
        jobId: currentJob.jobId,
        stopId: currentJob.stopId,
        planId: currentJob.planId,
        loadId: currentJob.loadId,
        orderRef: (currentJob.orderRefs || []).join(",")
      });
      button.textContent = t("common.saving", "Saving...");
      const result = await request(`/api/driver/jobs/${encodeURIComponent(currentJob.jobId)}/photos`, {
        method: "POST",
        body: JSON.stringify({
          photoDataUrls: uploadedPhotos,
          locationOverride: locationOverrideAccepted,
          autoStartNext: true
        })
      });
      currentJob = result.nextJob;
      activeRest = result.rest || null;
      restSummary = result.restSummary || restSummary;
      photos = [];
      orderPages = {};
      photoPromptOpen = false;
      const shouldCheckNext = currentJob?.status === "in_progress";
      locationCheck = null;
      locationOverrideAccepted = false;
      if (activeRest) {
        showToast("Rest started");
        return renderRest();
      }
      renderJob();
      if (shouldCheckNext) checkCurrentJobLocation().catch((error) => showToast(error.message));
      showToast("Stop completed");
    } catch (error) {
      if (error.data?.locationCheck) locationCheck = error.data.locationCheck;
      showToast(error.message);
      renderJob();
    }
  }
});

app.addEventListener("change", async (event) => {
  if (event.target?.id === "driverHistoryDate") {
    historyDate = event.target.value || localDate();
    return loadDriverHistory();
  }
  const input = event.target.closest("input[type='file'][data-photo-index]");
  const dvirInput = event.target.closest("input[type='file'][data-dvir-photo-index]");
  if (!input && !dvirInput) return;
  try {
    if (dvirInput?.files?.[0]) {
      dvirPhotos[Number(dvirInput.dataset.dvirPhotoIndex)] = await fileToDataUrl(dvirInput.files[0]);
      renderDvir(dvirMode || "pre");
      return;
    }
    if (input?.files?.[0]) {
      photos[Number(input.dataset.photoIndex)] = await fileToDataUrl(input.files[0]);
      renderJob();
    }
  } catch (error) {
    showToast(error.message);
  }
});

app.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-form='login']");
  if (!form) return;
  event.preventDefault();
  try {
    const result = await request("/api/driver/login", {
      method: "POST",
      body: JSON.stringify({
        username: document.getElementById("driverLogin").value,
        password: document.getElementById("driverPassword").value
      })
    });
    authToken = result.token;
    driver = result.driver;
    localStorage.setItem(TOKEN_KEY, authToken);
    connectEvents();
    await loadNextJob();
    showToast(`Welcome ${driver.name}`);
  } catch (error) {
    renderLogin(localizeMessage(error.message));
  }
});

async function init() {
  if (!authToken) {
    if (await redirectExistingStaffSession()) return;
    return renderLogin();
  }
  try {
    const result = await request("/api/driver/me");
    driver = result.driver;
    connectEvents();
    await loadNextJob();
  } catch {
    authToken = "";
    localStorage.removeItem(TOKEN_KEY);
    disconnectEvents();
    renderLogin(localizeMessage("Please login to continue."));
  }
}

window.addEventListener("mbbs-language-changed", () => {
  if (!authToken) return renderLogin();
  if (activeView === "history") return renderDriverHistory();
  if (dvirMode) return renderDvir(dvirMode);
  if (activeRest) return renderRest();
  return renderJob();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}

init();
