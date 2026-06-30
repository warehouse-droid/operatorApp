const app = document.getElementById("driverApp");
const toast = document.getElementById("driverToast");
const TOKEN_KEY = "mbbs.driver.token";

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
const ITEMS_PER_PAGE = 5;
const COMPLETE_DELAY_MS = 10000;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function planDateText(value) {
  const text = String(value || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "Plan date not set";
  const [year, month, day] = text.split("-");
  return `${month}/${day}/${year}`;
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

function locationCheckBlocksComplete() {
  return locationCheck?.status === "checking"
    || (["warning", "unavailable"].includes(locationCheck?.status) && !locationOverrideAccepted);
}

function canConfirmCurrentJob(job) {
  return job?.status === "in_progress" && completeWaitSeconds(job) <= 0 && !locationCheckBlocksComplete();
}

function clearCountdownTimer() {
  clearTimeout(countdownTimer);
  countdownTimer = null;
}

function scheduleCountdownRender(job) {
  clearCountdownTimer();
  if (!job || job.status !== "in_progress" || completeWaitSeconds(job) <= 0) return;
  countdownTimer = setTimeout(() => {
    if (currentJob?.jobId === job.jobId) renderJob();
  }, 1000);
}

async function checkCurrentJobLocation({ render = true } = {}) {
  if (!currentJob?.jobId) return null;
  locationCheck = { status: "checking", message: "Checking Samsara truck GPS against expected stop..." };
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
      message: error.message || "Samsara truck GPS could not be checked."
    };
  }
  if (render) renderJob();
  return locationCheck;
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

function renderLogin(message = "") {
  app.innerHTML = `
    <section class="driver-shell">
      <div class="driver-content">
        <form class="login-panel" data-form="login">
          <div>
            <p>MBBS Driver</p>
            <h1>Driver Login</h1>
          </div>
          ${message ? `<div class="message">${escapeHtml(message)}</div>` : ""}
          <label>
            <span>Login</span>
            <input id="driverLogin" autocomplete="username" required />
          </label>
          <label>
            <span>Password</span>
            <input id="driverPassword" type="password" autocomplete="current-password" />
          </label>
          <button class="primary" type="submit">Login</button>
        </form>
      </div>
    </section>
  `;
}

function shell(content) {
  app.innerHTML = `
    <section class="driver-shell">
      <div class="driver-content">${content}</div>
    </section>
  `;
}

function renderNoJob() {
  clearCountdownTimer();
  shell(`
    <section class="empty-panel">
      <h2>No assigned job</h2>
      <p>No pending stop was found for your login in the confirmed dispatch plans.</p>
      <button class="primary" data-action="refresh" type="button">Refresh</button>
    </section>
  `);
}

function renderDvir(type = "pre", message = "") {
  clearCountdownTimer();
  const labels = ["Driver side", "Front", "Passenger side", "Back"];
  dvirMode = type;
  dvirPhotos = dvirPhotos.slice(0, 4);
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
            <span class="job-type ${isPost ? "dropoff" : ""}">${isPost ? "Post-Trip" : "Pre-Trip"}</span>
            <h2>${escapeHtml(dayState?.truckPlate || "Truck Inspection")}</h2>
          </div>
        </div>
      </div>
      ${message ? `<div class="message">${escapeHtml(message)}</div>` : ""}
      <div class="photo-grid dvir-photo-grid">
        ${labels.map((label, index) => `
          <label class="photo-slot dvir-photo-slot">
            <input data-dvir-photo-index="${index}" type="file" accept="image/*" capture="environment" />
            <div class="photo-preview">${dvirPhotos[index] ? `<img src="${dvirPhotos[index]}" alt="${escapeHtml(label)}" />` : escapeHtml(label)}</div>
            <button data-action="take-dvir-photo" data-dvir-photo-index="${index}" type="button">Camera</button>
          </label>
        `).join("")}
      </div>
      <div class="job-actions">
        <button class="primary" data-action="submit-dvir" ${dvirPhotos.filter(Boolean).length >= 4 ? "" : "disabled"} type="button">${isPost ? "Submit Post-Trip" : "Submit Pre-Trip"}</button>
        <button class="secondary compact" data-action="skip-dvir" type="button">Skip DVIR Test</button>
        <button class="secondary compact" data-action="refresh" type="button">Refresh</button>
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
              <strong>${escapeHtml(item.itemName || item.sku || "Item")}</strong>
              <div class="unit-row">${unitPills(item.units)}</div>
            </div>
            ${item.description ? `<span class="item-description">${escapeHtml(item.description)}</span>` : ""}
          </div>
        `).join("") || `<div class="item-row"><strong>No item detail found in local DB</strong></div>`}
      </div>
      ${items.length > ITEMS_PER_PAGE ? `
        <div class="order-pager">
          <button data-action="order-page" data-order-key="${escapeHtml(key)}" data-page="${page - 1}" ${page <= 0 ? "disabled" : ""} type="button">Prev</button>
          <span>${page + 1} / ${pageCount}</span>
          <button data-action="order-page" data-order-key="${escapeHtml(key)}" data-page="${page + 1}" ${page >= pageCount - 1 ? "disabled" : ""} type="button">Next</button>
        </div>
      ` : ""}
    </section>
  `;
  }).join("");
}

function renderLocationCheck(job) {
  if (!job || job.status !== "in_progress") return "";
  const status = locationCheck?.status || "unavailable";
  const text = locationCheck?.message || "Samsara truck GPS check has not run yet.";
  const detail = locationCheck?.expectedAddress
    ? `<small>Expected: ${escapeHtml(locationCheck.expectedAddress)}</small>`
    : "";
  const truckDetail = locationCheck?.truckFormattedLocation
    ? `<small>Truck: ${escapeHtml(locationCheck.truckFormattedLocation)}</small>`
    : "";
  return `
    <section class="location-check ${escapeHtml(status)}">
      <div>
        <strong>${status === "ok" ? "Location verified" : status === "warning" ? "Location warning" : status === "checking" ? "Checking location" : "Location not verified"}</strong>
        <span>${escapeHtml(text)}</span>
        ${detail}
        ${truckDetail}
      </div>
      <div class="location-actions">
        <button class="secondary compact" data-action="recheck-location" ${status === "checking" ? "disabled" : ""} type="button">Recheck</button>
        ${["warning", "unavailable"].includes(status) && !locationOverrideAccepted ? `<button class="secondary compact danger-button" data-action="override-location" type="button">Override</button>` : ""}
      </div>
    </section>
  `;
}

function renderPhotoSlots(job) {
  photos = photos.slice(0, job.requiredPhotos || 1);
  while (photos.length < (job.requiredPhotos || 1)) photos.push("");
  if (!job.requiredPhotos) {
    return `
      <section class="photo-panel">
        <h3>No photos required</h3>
        <button class="primary" data-action="complete-job" type="button">Complete Travel</button>
      </section>
    `;
  }
  return `
    <div class="photo-modal" role="dialog" aria-modal="true" aria-label="Photos required">
      <section class="photo-panel">
        <div class="photo-head">
          <h3>${job.requiredPhotos} photo${job.requiredPhotos > 1 ? "s" : ""} required</h3>
          <button class="icon-button" data-action="close-photo" type="button">X</button>
        </div>
        <div class="photo-grid">
          ${photos.map((photo, index) => `
            <label class="photo-slot">
              <input data-photo-index="${index}" type="file" accept="image/*" capture="environment" />
              <div class="photo-preview">${photo ? `<img src="${photo}" alt="Photo ${index + 1}" />` : `Photo ${index + 1}`}</div>
              <button data-action="take-photo" data-photo-index="${index}" type="button">Camera</button>
            </label>
          `).join("")}
        </div>
        <button class="primary" data-action="complete-job" ${photos.filter(Boolean).length >= job.requiredPhotos && canConfirmCurrentJob(job) ? "" : "disabled"} type="button">${completeWaitSeconds(job) > 0 ? `Wait ${completeWaitSeconds(job)}s` : "Complete Stop"}</button>
      </section>
    </div>
  `;
}

function renderJob() {
  const job = currentJob;
  if (!job) return renderNoJob();
  const isPickup = job.stopType === "pickup";
  const isTravel = job.stopType === "travel";
  const isStarted = job.status === "in_progress";
  const typeText = isTravel ? "Travel" : isPickup ? "Pickup" : "Drop Off";
  const titleText = isTravel ? job.location : (job.location || job.address || "Stop");
  const navigationUrl = mapsUrl(job);
  const waitSeconds = completeWaitSeconds(job);
  const confirmDisabled = !canConfirmCurrentJob(job);
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
            <span class="job-type ${isTravel ? "travel" : isPickup ? "" : "dropoff"}">${typeText}</span>
            <h2>${escapeHtml(titleText)}</h2>
          </div>
        </div>
        <div class="address-block">
          <div>
            <span>${isTravel ? "Travel destination" : isPickup ? "Pickup address / yard" : "Delivery address"}</span>
            <strong>${escapeHtml(job.address || job.location || "")}</strong>
            ${isTravel && job.fromAddress ? `<em>Start: ${escapeHtml(job.fromAddress)}</em>` : ""}
          </div>
          ${navigationUrl ? `<a class="map-button" href="${navigationUrl}" target="_blank" rel="noopener">Maps</a>` : ""}
        </div>
      </div>
      ${renderLocationCheck(job)}
      ${isTravel ? "" : renderOrders(job)}
      <div class="job-actions">
        ${isStarted
          ? `<button class="primary" data-action="${job.requiredPhotos ? "show-photo" : "complete-job"}" ${confirmDisabled ? "disabled" : ""} type="button">${waitSeconds > 0 ? `Wait ${waitSeconds}s` : "Confirm"}</button>`
          : `<button class="primary" data-action="start-job" type="button">Start</button>`}
        <button class="secondary compact" data-action="refresh" type="button">Refresh</button>
      </div>
      ${photoPromptOpen ? renderPhotoSlots(job) : ""}
    </section>
  `);
}

async function loadNextJob() {
  const stateResult = await request("/api/driver/day-state");
  dayState = stateResult.state;
  if (dayState?.truckPlate && (dayState.preDvirStatus !== "complete" || !dayState.samsaraOnDutyConfirmed || !dayState.samsaraPreDvirConfirmed)) {
    currentJob = null;
    dvirPhotos = [];
    const message = dayState.preDvirStatus === "complete" && (!dayState.samsaraOnDutyConfirmed || !dayState.samsaraPreDvirConfirmed)
      ? `Samsara did not receive/verify the inspection. Please redo it in MBBS PWA. ${dayState.samsaraOnDutyError || "Check Samsara DVIR author ID and Write DVIRs permission."}`
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
  photos = [];
  dvirMode = "";
  dvirPhotos = [];
  orderPages = {};
  photoPromptOpen = false;
  locationCheck = null;
  locationOverrideAccepted = false;
  if (!currentJob && dayState?.allJobsComplete && dayState.postDvirStatus !== "complete") {
    return renderDvir("post", "All assigned jobs are complete. MBBS post-trip inspection is required before logout.");
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
      "delivery.order.loaded"
    ].includes(event.type);
    if (!relevant || !driver) return;
    if (photoPromptOpen || photos.some(Boolean)) {
      showToast("Job updated. Finish or close photos to refresh.");
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
  if (action === "order-page") {
    orderPages[button.dataset.orderKey] = Number(button.dataset.page || 0);
    return renderJob();
  }
  if (action === "show-photo") {
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
  if (action === "close-photo") {
    photoPromptOpen = false;
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
  if (action === "submit-dvir") {
    button.disabled = true;
    button.textContent = "Saving...";
    try {
      const result = await request("/api/driver/dvir", {
        method: "POST",
        body: JSON.stringify({ type: dvirMode || "pre", photoDataUrls: dvirPhotos.filter(Boolean) })
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
    button.textContent = "Skipping...";
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
    button.disabled = true;
    button.textContent = "Starting...";
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
      showToast(error.message);
      renderJob();
    }
  }
  if (action === "complete-job" && currentJob) {
    if (!canConfirmCurrentJob(currentJob)) {
      if (completeWaitSeconds(currentJob) > 0) showToast(`Please wait ${completeWaitSeconds(currentJob)} seconds.`);
      else if (locationCheckBlocksComplete()) showToast("Recheck location or confirm override first.");
      return renderJob();
    }
    button.disabled = true;
    button.textContent = "Saving...";
    try {
      if (!locationCheck && !locationOverrideAccepted) await checkCurrentJobLocation({ render: false });
      if (locationCheckBlocksComplete()) {
        showToast("Recheck location or confirm override first.");
        return renderJob();
      }
      const result = await request(`/api/driver/jobs/${encodeURIComponent(currentJob.jobId)}/photos`, {
        method: "POST",
        body: JSON.stringify({
          photoDataUrls: photos.filter(Boolean),
          locationOverride: locationOverrideAccepted
        })
      });
      currentJob = result.nextJob;
      photos = [];
      orderPages = {};
      photoPromptOpen = false;
      locationCheck = null;
      locationOverrideAccepted = false;
      renderJob();
      showToast("Stop completed");
    } catch (error) {
      if (error.data?.locationCheck) locationCheck = error.data.locationCheck;
      showToast(error.message);
      renderJob();
    }
  }
});

app.addEventListener("change", async (event) => {
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
    renderLogin(error.message);
  }
});

async function init() {
  if (!authToken) return renderLogin();
  try {
    const result = await request("/api/driver/me");
    driver = result.driver;
    connectEvents();
    await loadNextJob();
  } catch {
    authToken = "";
    localStorage.removeItem(TOKEN_KEY);
    disconnectEvents();
    renderLogin("Please login to continue.");
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}

init();
