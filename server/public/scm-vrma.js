const scmVrmaApp = document.getElementById("scmVrmaApp");
let scmVrmaOperator = null;
let scmVrmaRows = [];
let scmVrmaNotice = "";
let scmVrmaLineCount = 1;
const SCM_VRMA_MANUAL_STATUSES = ["Queued", "Urgent", "Cancelled", "Hold", "Priority", "Surplus Only", "Book Appt"];

function vrmaEscape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

async function vrmaApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function loadVrmaSchedule() {
  try {
    scmVrmaRows = await vrmaApi("/api/scm/schedule?kind=VRMA");
  } catch (error) {
    scmVrmaNotice = `VRMA list failed: ${error.message}`;
  }
  renderVrma();
}

function renderVrmaLines() {
  return Array.from({ length: scmVrmaLineCount }).map((_, index) => `
    <div class="vrma-line" data-line-index="${index}">
      <input data-line-field="sku" placeholder="SKU" />
      <input data-line-field="itemName" placeholder="Item name" />
      <input data-line-field="quantity" type="number" min="0" step="0.01" placeholder="Qty" />
      <input data-line-field="unit" placeholder="UOM" />
      <input data-line-field="weightLbs" type="number" min="0" step="0.01" placeholder="Weight lb" />
    </div>
  `).join("");
}

function renderVrmaList() {
  return scmVrmaRows.map((row) => `
    <article class="scm-schedule-row">
      <strong>${vrmaEscape(row.displayRef || row.orderRef)}</strong>
      <span>${vrmaEscape(row.method)} | ${vrmaEscape(row.status)}</span>
      <small>${vrmaEscape(row.pickupPoint || "--")} -> ${vrmaEscape(row.dropoffPoint || "--")}</small>
      <small>${vrmaEscape(row.content || "")}</small>
    </article>
  `).join("") || `<div class="empty-state">No VRMA orders yet.</div>`;
}

function renderVrma() {
  const operator = scmVrmaOperator || {};
  scmVrmaApp.innerHTML = `
    <header class="dispatch-topbar">
      <div><p>SCM</p><h1>VRMA</h1></div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml() || ""}</div>
      <div class="topbar-actions">
        <span class="dispatch-user">${vrmaEscape(operator.display_name || operator.username || "")}</span>
        <button onclick="location.href='/scm'" type="button">SCM Menu</button>
        <button onclick="dispatchLogout()" type="button">Logout</button>
      </div>
    </header>
    ${scmVrmaNotice ? `<div class="route-notice scm-notice">${vrmaEscape(scmVrmaNotice)}</div>` : ""}
    <section class="scm-vrma-grid">
      <section class="scm-vrma-form">
        <div class="scm-detail-header">
          <div><p>Local Vendor Return</p><h2>Create / Update VRMA</h2></div>
          <button data-action="save-vrma" type="button">Save VRMA</button>
        </div>
        <div class="scm-schedule-form">
          <label><span>VRMA Ref</span><input data-field="vrmaRef" placeholder="VRMA-0001" /></label>
          <label><span>Vendor</span><input data-field="vendor" /></label>
          <label><span>Local Vendor</span><input data-field="localVendor" /></label>
          <label><span>Method</span><select data-field="method">${["MBT", "Vendor"].map((item) => `<option>${item}</option>`).join("")}</select></label>
          <label><span>Status</span><select data-field="status">${SCM_VRMA_MANUAL_STATUSES.map((item) => `<option>${item}</option>`).join("")}</select></label>
          <label><span>Pickup</span><input data-field="pickupLocation" /></label>
          <label><span>Drop Off</span><input data-field="dropoffLocation" /></label>
          <label class="wide"><span>Notes</span><textarea data-field="notes"></textarea></label>
        </div>
        <div class="vrma-lines-head">
          <strong>Items</strong>
          <button data-action="add-line" type="button">+ Line</button>
        </div>
        <div class="vrma-lines">${renderVrmaLines()}</div>
      </section>
      <aside class="scm-vrma-list">
        <h2>Current VRMA</h2>
        ${renderVrmaList()}
      </aside>
    </section>
  `;
}

function collectVrmaPayload() {
  const payload = {};
  scmVrmaApp.querySelectorAll("[data-field]").forEach((field) => {
    payload[field.dataset.field] = field.value;
  });
  payload.lines = [];
  scmVrmaApp.querySelectorAll(".vrma-line").forEach((line) => {
    const row = {};
    line.querySelectorAll("[data-line-field]").forEach((field) => {
      row[field.dataset.lineField] = field.value;
    });
    if (row.itemName || row.sku) payload.lines.push(row);
  });
  payload.audit = { sessionId: sessionStorage.getItem("mbbs.dispatch.sessionId") || "" };
  return payload;
}

scmVrmaApp.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  if (target.dataset.action === "add-line") {
    scmVrmaLineCount += 1;
    renderVrma();
  }
  if (target.dataset.action === "save-vrma") {
    try {
      const payload = collectVrmaPayload();
      await vrmaApi("/api/scm/vrma-orders", { method: "POST", body: JSON.stringify(payload) });
      scmVrmaNotice = `Saved ${payload.vrmaRef}.`;
      scmVrmaLineCount = 1;
      await loadVrmaSchedule();
    } catch (error) {
      scmVrmaNotice = `Save failed: ${error.message}`;
      renderVrma();
    }
  }
});

window.addEventListener("mbbs-language-changed", renderVrma);

requireDispatchLogin({
  mount: scmVrmaApp,
  roles: ["admin", "scm", "scm_staff"],
  async onReady(operator) {
    scmVrmaOperator = operator;
    await loadVrmaSchedule();
  }
});
