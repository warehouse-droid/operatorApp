const app = document.getElementById("driverApp");
const toast = document.getElementById("driverToast");
const TOKEN_KEY = "mbbs.driver.token";

let authToken = localStorage.getItem(TOKEN_KEY) || "";
let driver = null;
let currentJob = null;
let photos = [];
let orderPages = {};
let photoPromptOpen = false;
let eventSource = null;
const ITEMS_PER_PAGE = 5;

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
  if (!response.ok) throw new Error(data.error || text || "Request failed");
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
  shell(`
    <section class="empty-panel">
      <h2>No assigned job</h2>
      <p>No pending stop was found for your login in the confirmed dispatch plans.</p>
      <button class="primary" data-action="refresh" type="button">Refresh</button>
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
        <button class="primary" data-action="complete-job" ${photos.filter(Boolean).length >= job.requiredPhotos ? "" : "disabled"} type="button">Complete Stop</button>
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
      ${isTravel ? "" : renderOrders(job)}
      <div class="job-actions">
        ${isStarted
          ? `<button class="primary" data-action="${job.requiredPhotos ? "show-photo" : "complete-job"}" type="button">Confirm</button>`
          : `<button class="primary" data-action="start-job" type="button">Start</button>`}
        <button class="secondary compact" data-action="refresh" type="button">Refresh</button>
      </div>
      ${photoPromptOpen ? renderPhotoSlots(job) : ""}
    </section>
  `);
}

async function loadNextJob() {
  const result = await request("/api/driver/next-job");
  currentJob = result.job;
  photos = [];
  orderPages = {};
  photoPromptOpen = false;
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
    await request("/api/driver/logout", { method: "POST" }).catch(() => ({}));
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
  if (action === "close-photo") {
    photoPromptOpen = false;
    return renderJob();
  }
  if (action === "take-photo") {
    const input = app.querySelector(`input[data-photo-index="${button.dataset.photoIndex}"]`);
    input?.click();
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
      renderJob();
      showToast("Job started");
    } catch (error) {
      showToast(error.message);
      renderJob();
    }
  }
  if (action === "complete-job" && currentJob) {
    button.disabled = true;
    button.textContent = "Saving...";
    try {
      const result = await request(`/api/driver/jobs/${encodeURIComponent(currentJob.jobId)}/photos`, {
        method: "POST",
        body: JSON.stringify({ photoDataUrls: photos.filter(Boolean) })
      });
      currentJob = result.nextJob;
      photos = [];
      orderPages = {};
      photoPromptOpen = false;
      renderJob();
      showToast("Stop completed");
    } catch (error) {
      showToast(error.message);
      renderJob();
    }
  }
});

app.addEventListener("change", async (event) => {
  const input = event.target.closest("input[type='file'][data-photo-index]");
  if (!input || !input.files?.[0]) return;
  try {
    photos[Number(input.dataset.photoIndex)] = await fileToDataUrl(input.files[0]);
    renderJob();
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
