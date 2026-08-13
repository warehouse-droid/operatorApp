const dvirApp = document.getElementById("dispatchDvirApp");
const t = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const languageToggle = () => window.MBBS_I18N?.toggleHtml() || "";
const DISPATCH_TOKEN_KEY = "mbbs.dispatch.token";
const CONTROL_TOKEN_KEY = "mbbs.control.token";
const OPERATOR_TOKEN_KEY = "mbbs.operator.token";

let dvirOperator = null;
let dvirDate = localDate();
let dvirRecords = [];
let selectedDvirId = null;
let dvirLoading = false;
let dvirError = "";

function localDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function authToken() {
  return localStorage.getItem(DISPATCH_TOKEN_KEY) || localStorage.getItem(CONTROL_TOKEN_KEY) || localStorage.getItem(OPERATOR_TOKEN_KEY) || "";
}

function photoSrc(value) {
  const text = String(value || "");
  if (!text.startsWith("r2://")) return text;
  return `/api/photo-upload/preview?ref=${encodeURIComponent(text)}&token=${encodeURIComponent(authToken())}`;
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

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString([], { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit" });
}

function formatDate(value) {
  return window.MBBS_I18N?.displayDate(value) || "";
}

function statusPill(done, error = "") {
  if (error) return `<span class="dvir-pill danger">Issue</span>`;
  return done ? `<span class="dvir-pill ok">Done</span>` : `<span class="dvir-pill muted">Missing</span>`;
}

function selectedRecord() {
  return dvirRecords.find((record) => String(record.id) === String(selectedDvirId)) || dvirRecords[0] || null;
}

async function api(path) {
  const response = await fetch(path);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error || text || "Request failed");
  return payload;
}

async function loadDvirRecords({ keepSelection = false } = {}) {
  dvirLoading = true;
  dvirError = "";
  renderDvirApp();
  try {
    const payload = await api(`/api/dispatch/dvir-records?date=${encodeURIComponent(dvirDate)}`);
    dvirRecords = payload.records || [];
    if (!keepSelection || !dvirRecords.some((record) => String(record.id) === String(selectedDvirId))) {
      selectedDvirId = dvirRecords[0]?.id || null;
    }
  } catch (error) {
    dvirError = error.message;
  } finally {
    dvirLoading = false;
    renderDvirApp();
  }
}

function renderRecordList() {
  if (dvirLoading) return `<div class="dvir-empty">Loading DVIR records...</div>`;
  if (dvirError) return `<div class="dvir-empty warning">${escapeHtml(dvirError)}</div>`;
  if (!dvirRecords.length) return `<div class="dvir-empty">No DVIR photos for this date.</div>`;
  return dvirRecords.map((record) => {
    const selected = String(record.id) === String(selectedDvirId);
    const preDone = Boolean(record.preCompletedAt);
    const postDone = Boolean(record.postCompletedAt);
    return `
      <button class="dvir-record ${selected ? "selected" : ""}" data-dvir-id="${record.id}" type="button">
        <div class="dvir-record-head">
          <strong>${escapeHtml(record.driverLogin || "Driver")}</strong>
          <span>${escapeHtml(record.truckPlate || "-")}</span>
        </div>
        <div class="dvir-record-meta">
          <span>Pre ${record.prePhotoCount}/4 ${formatTime(record.preCompletedAt)}</span>
          <span>Post ${record.postPhotoCount}/4 ${formatTime(record.postCompletedAt)}</span>
        </div>
        <div class="dvir-record-status">
          ${statusPill(preDone, record.preError)}
          ${statusPill(postDone, record.postError)}
        </div>
      </button>
    `;
  }).join("");
}

function renderPhotoGrid(photos, label) {
  if (!photos.length) return `<div class="dvir-photo-empty">No ${escapeHtml(label)} photos saved.</div>`;
  return `
    <div class="dvir-photo-grid">
      ${photos.map((photo, index) => `
        <figure class="dvir-photo">
          <button class="dvir-photo-button" data-action="open-dvir-photo" data-photo-ref="${escapeHtml(photo)}" data-photo-label="${escapeHtml(label)} photo ${index + 1}" type="button">
            <img src="${photoImgSrc(photo)}" alt="${escapeHtml(label)} photo ${index + 1}" />
          </button>
          <figcaption>${escapeHtml(label)} ${index + 1}</figcaption>
        </figure>
      `).join("")}
    </div>
  `;
}

function renderPhotoPanel() {
  const record = selectedRecord();
  if (!record) {
    return `
      <section class="panel dvir-detail-panel">
        <div class="dvir-empty">Select a DVIR record to view photos.</div>
      </section>
    `;
  }
  return `
    <section class="panel dvir-detail-panel">
      <div class="panel-header dvir-detail-header">
        <div>
          <h2>${escapeHtml(record.driverLogin || "Driver")} ${escapeHtml(record.truckPlate || "")}</h2>
          <p>${escapeHtml(formatDate(record.planDate || dvirDate))} · Samsara ${escapeHtml(record.samsaraUsername || "-")}</p>
        </div>
        <div class="dvir-detail-status">
          ${statusPill(Boolean(record.preCompletedAt), record.preError)}
          ${statusPill(Boolean(record.postCompletedAt), record.postError)}
        </div>
      </div>
      <div class="dvir-photo-sections">
        <section class="dvir-photo-section">
          <div class="dvir-section-title">
            <h3>Pre-Trip Photos</h3>
            <span>${record.prePhotoCount}/4 · ${formatTime(record.preCompletedAt)} · DVIR ${escapeHtml(record.samsaraPreDvirId || "-")}</span>
          </div>
          ${record.preError ? `<div class="dvir-inline-warning">${escapeHtml(record.preError)}</div>` : ""}
          ${renderPhotoGrid(record.prePhotos, "Pre-trip")}
        </section>
        <section class="dvir-photo-section">
          <div class="dvir-section-title">
            <h3>Post-Trip Photos</h3>
            <span>${record.postPhotoCount}/4 · ${formatTime(record.postCompletedAt)} · DVIR ${escapeHtml(record.samsaraPostDvirId || "-")}</span>
          </div>
          ${record.postError ? `<div class="dvir-inline-warning">${escapeHtml(record.postError)}</div>` : ""}
          ${renderPhotoGrid(record.postPhotos, "Post-trip")}
        </section>
      </div>
    </section>
  `;
}

function renderDvirApp() {
  dvirApp.innerHTML = `
    <header class="dispatch-topbar">
      <div>
        <p>${t("app.transportation", "MBBS Transportation")}</p>
        <h1>${t("dispatch.dvirPhotos", "DVIR Photos")}</h1>
      </div>
      <div class="topbar-controls">
        <input id="dvirDate" type="date" value="${escapeHtml(dvirDate)}" />
        <button class="primary" data-action="refresh-dvir" type="button">Refresh</button>
      </div>
      <div class="topbar-actions">
        ${languageToggle()}
        <button onclick="location.href='/dispatch'" type="button">Menu</button>
        <span class="dispatch-user">${escapeHtml(dvirOperator?.display_name || dvirOperator?.username || "")}</span>
        <button onclick="dispatchLogout()" type="button">Logout</button>
      </div>
    </header>
    <section class="dvir-review-grid">
      <section class="panel dvir-list-panel">
        <div class="panel-header">
          <h2>DVIR List</h2>
          <p>${dvirRecords.length} record${dvirRecords.length === 1 ? "" : "s"} for ${escapeHtml(dvirDate)}</p>
        </div>
        <div class="dvir-list">
          ${renderRecordList()}
        </div>
      </section>
      ${renderPhotoPanel()}
    </section>
  `;
}

dvirApp.addEventListener("click", (event) => {
  const recordButton = event.target.closest("[data-dvir-id]");
  if (recordButton) {
    selectedDvirId = recordButton.dataset.dvirId;
    renderDvirApp();
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "refresh-dvir") {
    const value = document.getElementById("dvirDate")?.value;
    if (value) dvirDate = value;
    loadDvirRecords({ keepSelection: true });
  }
  if (action === "open-dvir-photo") {
    const button = event.target.closest("[data-action='open-dvir-photo']");
    openPhotoLightbox(button?.dataset.photoRef, button?.dataset.photoLabel || "DVIR photo");
  }
});

dvirApp.addEventListener("change", (event) => {
  if (event.target?.id !== "dvirDate") return;
  dvirDate = event.target.value || localDate();
  loadDvirRecords();
});

window.addEventListener("mbbs-language-changed", () => {
  renderDvirApp();
});

requireDispatchLogin({
  mount: dvirApp,
  async onReady(operator) {
    dvirOperator = operator;
    renderDvirApp();
    await loadDvirRecords();
  }
});
