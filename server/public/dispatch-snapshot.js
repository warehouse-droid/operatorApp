const snapshotApp = document.getElementById("dispatchSnapshotApp");
const st = (key, fallback) => window.MBBS_I18N?.t ? window.MBBS_I18N.t(key, fallback) : fallback;

let snapshotOperator = null;
let snapshotDate = new Date().toISOString().slice(0, 10);
let snapshots = [];
let selectedSnapshotId = "";
let selectedSnapshot = null;
let snapshotNotice = "";
let snapshotLoading = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatSnapshotDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function snapshotApi(path, options = {}) {
  const token = localStorage.getItem("mbbs.dispatch.token") || localStorage.getItem("mbbs.operator.token") || "";
  return fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  }).then(async (response) => {
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
}

function snapshotCounts(snapshot) {
  return `${snapshot.orderCount || 0} orders | ${snapshot.truckCount || 0} trucks | ${snapshot.loadCount || 0} loads | ${snapshot.stopCount || 0} stops`;
}

function renderSnapshotList() {
  if (snapshotLoading) return `<div class="snapshot-empty">${st("common.loading", "Loading...")}</div>`;
  if (!snapshots.length) return `<div class="snapshot-empty">${st("dispatch.noSnapshots", "No snapshot versions found for this date.")}</div>`;
  return snapshots.map((snapshot) => `
    <button class="snapshot-version ${selectedSnapshotId === snapshot.id ? "selected" : ""}" data-action="select-snapshot" data-id="${escapeHtml(snapshot.id)}" type="button">
      <span class="snapshot-version-title">${escapeHtml(snapshot.current ? st("dispatch.currentActiveVersion", "Current Active Version") : formatSnapshotDateTime(snapshot.archivedAt))}</span>
      <span>${escapeHtml(snapshotCounts(snapshot))}</span>
      <span>${escapeHtml(snapshot.current ? st("dispatch.activeNow", "Active now") : `${snapshot.archiveReason || "archive"} | rev ${snapshot.revision || 0}`)}</span>
    </button>
  `).join("");
}

function renderSnapshotDetail() {
  const snapshot = selectedSnapshot;
  if (!snapshot) {
    return `<section class="snapshot-detail"><div class="snapshot-empty">${st("dispatch.selectSnapshot", "Select a snapshot version to preview.")}</div></section>`;
  }
  return `
    <section class="snapshot-detail">
      <div class="section-heading">
        <div>
          <h2>${escapeHtml(snapshot.current ? st("dispatch.currentActiveVersion", "Current Active Version") : st("dispatch.archivedSnapshot", "Archived Snapshot"))}</h2>
          <p class="muted">${escapeHtml(snapshotCounts(snapshot))}</p>
        </div>
        <div class="actions">
          <button data-action="back-menu" type="button">${st("dispatch.backMenu", "Back to Menu")}</button>
          <button class="primary" data-action="restore-snapshot" ${snapshot.current ? "disabled" : ""} type="button">${st("dispatch.restoreSnapshot", "Restore Snapshot")}</button>
        </div>
      </div>
      <div class="snapshot-meta-grid">
        <div><span>${st("dispatch.planDate", "Plan Date")}</span><strong>${escapeHtml(snapshot.planDate || "")}</strong></div>
        <div><span>${st("dispatch.revision", "Revision")}</span><strong>${escapeHtml(snapshot.revision || 0)}</strong></div>
        <div><span>${st("dispatch.archivedAt", "Archived At")}</span><strong>${escapeHtml(formatSnapshotDateTime(snapshot.archivedAt) || "Current")}</strong></div>
        <div><span>${st("dispatch.originalSavedAt", "Original Saved")}</span><strong>${escapeHtml(formatSnapshotDateTime(snapshot.originalSavedAt || snapshot.savedAt))}</strong></div>
        <div><span>${st("dispatch.reason", "Reason")}</span><strong>${escapeHtml(snapshot.archiveReason || "current")}</strong></div>
        <div><span>${st("dispatch.session", "Session")}</span><strong>${escapeHtml(snapshot.sessionId || "")}</strong></div>
      </div>
      <div class="snapshot-truck-list">
        ${(snapshot.trucks || []).map((truck) => `
          <article class="snapshot-truck">
            <header>
              <strong>${escapeHtml(truck.plate || truck.id || "Truck")}</strong>
              <span>${truck.loadCount || 0} loads | ${truck.orderCount || 0} orders | ${truck.stopCount || 0} stops</span>
            </header>
            <div class="snapshot-loads">
              ${(truck.loads || []).map((load) => `
                <div class="snapshot-load">
                  <strong>${escapeHtml(load.name || load.id || "Load")}</strong>
                  <span class="snapshot-load-orders">${escapeHtml((load.orderRefs || []).join(", ") || "-")}</span>
                  <span>${load.orderCount || 0} orders</span>
                  <span>${load.stopCount || 0} stops</span>
                </div>
              `).join("") || `<span class="muted">${st("dispatch.noLoads", "No loads")}</span>`}
            </div>
          </article>
        `).join("") || `<div class="snapshot-empty">${st("dispatch.noTrucksSnapshot", "No truck data in this snapshot.")}</div>`}
      </div>
    </section>
  `;
}

function renderSnapshotApp() {
  const operator = snapshotOperator || {};
  snapshotApp.innerHTML = `
    <section class="dispatch-shell snapshot-shell">
      <header class="dispatch-topbar">
        <div>
          <p>${st("app.transportation", "MBBS Transportation")}</p>
          <h1>${st("dispatch.snapshotRecovery", "Snapshot Recovery")}</h1>
        </div>
        <div class="topbar-language">${window.MBBS_I18N?.toggleHtml ? window.MBBS_I18N.toggleHtml() : ""}</div>
        <div class="topbar-actions">
          <span class="dispatch-user">${escapeHtml(operator.display_name || operator.username || "")}</span>
          <button onclick="dispatchLogout()" type="button">${st("common.logout", "Logout")}</button>
        </div>
      </header>
      <div class="snapshot-notice-slot">${snapshotNotice ? `<div class="route-notice snapshot-notice">${escapeHtml(snapshotNotice)}</div>` : ""}</div>
      <section class="snapshot-toolbar">
        <input id="snapshotDate" type="date" value="${escapeHtml(snapshotDate)}" />
        <button class="primary" data-action="load-snapshots" type="button">${st("common.apply", "Apply")}</button>
        <button data-action="back-menu" type="button">${st("dispatch.backMenu", "Back to Menu")}</button>
      </section>
      <section class="snapshot-grid">
        <aside class="snapshot-list-panel">
          <h2>${st("dispatch.versions", "Versions")}</h2>
          <div class="snapshot-version-list">${renderSnapshotList()}</div>
        </aside>
        ${renderSnapshotDetail()}
      </section>
    </section>
  `;
}

async function loadSnapshots({ keepSelection = false } = {}) {
  snapshotLoading = true;
  renderSnapshotApp();
  try {
    const payload = await snapshotApi(`/api/dispatch/plan-snapshots?date=${encodeURIComponent(snapshotDate)}`);
    snapshots = payload.snapshots || [];
    if (!keepSelection || !snapshots.some((snapshot) => snapshot.id === selectedSnapshotId)) {
      selectedSnapshotId = snapshots[0]?.id || "";
    }
    await loadSelectedSnapshot();
    snapshotNotice = "";
  } catch (error) {
    snapshotNotice = `Snapshot load failed: ${error.message}`;
  } finally {
    snapshotLoading = false;
    renderSnapshotApp();
  }
}

async function loadSelectedSnapshot() {
  selectedSnapshot = null;
  if (!selectedSnapshotId) return;
  selectedSnapshot = await snapshotApi(`/api/dispatch/plan-snapshots/${encodeURIComponent(selectedSnapshotId)}`);
}

async function restoreSelectedSnapshot() {
  if (!selectedSnapshot || selectedSnapshot.current) return;
  const label = selectedSnapshot.archivedAt ? formatSnapshotDateTime(selectedSnapshot.archivedAt) : selectedSnapshot.id;
  if (!confirm(`Restore this snapshot to the active ${selectedSnapshot.planDate} plan? Current plan will be archived first.\n\nSnapshot: ${label}`)) return;
  snapshotLoading = true;
  renderSnapshotApp();
  try {
    const restored = await snapshotApi(`/api/dispatch/plan-snapshots/${encodeURIComponent(selectedSnapshot.id)}/restore`, {
      method: "POST",
      body: JSON.stringify({ audit: { sessionId: `snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}` } })
    });
    selectedSnapshotId = `current-${restored.plan?.id || selectedSnapshot.planId}`;
    snapshotNotice = "Snapshot restored. Planning screens will refresh.";
    await loadSnapshots({ keepSelection: true });
  } catch (error) {
    snapshotNotice = `Restore failed: ${error.message}`;
  } finally {
    snapshotLoading = false;
    renderSnapshotApp();
  }
}

snapshotApp.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "back-menu") {
    location.href = "/dispatch";
    return;
  }
  if (action === "load-snapshots") {
    snapshotDate = document.getElementById("snapshotDate")?.value || snapshotDate;
    loadSnapshots();
    return;
  }
  if (action === "select-snapshot") {
    selectedSnapshotId = button.dataset.id || "";
    loadSelectedSnapshot().then(renderSnapshotApp).catch((error) => {
      snapshotNotice = `Snapshot preview failed: ${error.message}`;
      renderSnapshotApp();
    });
    return;
  }
  if (action === "restore-snapshot") {
    restoreSelectedSnapshot();
  }
});

window.addEventListener("mbbs-language-changed", renderSnapshotApp);

requireDispatchLogin({
  mount: snapshotApp,
  onReady(operator) {
    snapshotOperator = operator;
    loadSnapshots();
  }
});
