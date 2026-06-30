const app = document.getElementById("controlApp");
const TOKEN_KEY = "mbbs.control.token";

let token = localStorage.getItem(TOKEN_KEY) || "";
let operator = null;
let operators = [];
let audit = [];
let classifications = [];
let cycleRecords = [];
let fulfillmentRecords = [];
let recordWarnings = [];
let syncSettings = { mode: "manual", running: false, lastStatus: "idle" };
let envSettings = { activeEnvFile: ".env", selectedEnvFile: ".env", restartRequired: false, files: [] };
let classificationSearch = "";
let bootstrapNeeded = false;
let activeSection = localStorage.getItem("mbbs.control.section") || "dashboard";
let syncPollTimer = null;

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...options
  });
  if (response.status === 401) {
    token = "";
    operator = null;
    localStorage.removeItem(TOKEN_KEY);
    renderLogin("Please login again.");
    throw new Error("Login required");
  }
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function envFileLabel(file) {
  if (file === ".env") return "Production (.env)";
  if (file === ".env.old") return "Sandbox (.env.old)";
  return file;
}

function clearSyncPoll() {
  clearTimeout(syncPollTimer);
  syncPollTimer = null;
}

function scheduleSyncPoll() {
  clearSyncPoll();
  if (!operator || !syncSettings.running) return;
  syncPollTimer = setTimeout(pollSyncStatus, 3000);
}

async function pollSyncStatus() {
  if (!operator) return;
  const wasRunning = Boolean(syncSettings.running);
  try {
    syncSettings = await request("/api/control/sync-settings");
    if (wasRunning && !syncSettings.running) {
      await loadControlData();
      alert(`NetSuite sync ${syncSettings.lastStatus || "finished"}.`);
      return;
    }
    if (["dashboard", "sync"].includes(activeSection)) render();
  } catch (error) {
    console.warn(error);
  } finally {
    scheduleSyncPoll();
  }
}

function renderLogin(message = "") {
  clearSyncPoll();
  app.innerHTML = `
    <section class="panel login">
      <h1>MBBS Operator Control</h1>
      ${bootstrapNeeded ? `<div class="notice">No account exists yet. Create the first admin account.</div>` : ""}
      ${message ? `<div class="notice">${message}</div>` : ""}
      <form class="form-grid" data-form="${bootstrapNeeded ? "bootstrap" : "login"}">
        <label>
          <span>Username</span>
          <input id="username" autocomplete="username" required />
        </label>
        ${bootstrapNeeded ? `
          <label>
            <span>Display name</span>
            <input id="displayName" required />
          </label>
        ` : ""}
        <label>
          <span>Password</span>
          <input id="password" type="password" autocomplete="${bootstrapNeeded ? "new-password" : "current-password"}" required />
        </label>
        <button class="primary" type="submit">${bootstrapNeeded ? "Create admin" : "Login"}</button>
      </form>
    </section>
  `;
}

function render() {
  if (!operator) return renderLogin();
  app.innerHTML = `
    <section class="shell">
      <header class="topbar">
        <div>
          <p class="muted">MBBS Yard Server</p>
          <h1>Operator Control</h1>
        </div>
        <div class="actions">
          <button onclick="location.href='/operator'">Open Operator PWA</button>
          <button data-action="refresh">Refresh</button>
          <button data-action="logout">Logout ${operator.display_name}</button>
        </div>
      </header>
      <div class="control-layout">
        <nav class="control-menu">
          ${renderMenuButton("dashboard", "Dashboard", "Quick status and shortcuts")}
          ${renderMenuButton("operators", "Account Management", "Register and manage accounts")}
          ${renderMenuButton("classification", "Item Classification", "Maintain type, brand, series")}
          ${renderMenuButton("sync", "Sync Settings", "Auto or manual NetSuite sync")}
          ${renderMenuButton("warnings", "Operator Warnings", "Handle reported record problems")}
          ${renderMenuButton("cycle-count", "Cycle Count Review", "Review submitted blind counts")}
          ${renderMenuButton("fulfillment", "Operator Load Records", "Review load/photo records")}
          ${renderMenuButton("audit", "Audit Log", "Trace operator and sync actions")}
        </nav>
        <section class="control-content">
          ${renderActiveSection()}
        </section>
      </div>
    </section>
  `;
  scheduleSyncPoll();
}

function renderMenuButton(section, title, subtitle) {
  return `
    <button class="menu-button ${activeSection === section ? "active" : ""}" data-action="control-section" data-section="${section}" type="button">
      <strong>${title}</strong>
      <span>${subtitle}</span>
    </button>
  `;
}

function renderActiveSection() {
  if (activeSection === "operators") return renderOperatorsSection();
  if (activeSection === "classification") return renderClassificationSection();
  if (activeSection === "sync") return renderSyncSection();
  if (activeSection === "warnings") return renderWarningsSection();
  if (activeSection === "cycle-count") return renderCycleCountSection();
  if (activeSection === "fulfillment") return renderFulfillmentSection();
  if (activeSection === "audit") return renderAuditSection();
  return renderDashboardSection();
}

function renderDashboardSection() {
  const activeOperators = operators.filter((item) => item.active).length;
  const classified = classifications.filter((item) => item.product_type || item.brand || item.series).length;
  const openWarnings = recordWarnings.filter((item) => item.status === "open").length;
  return `
    <div class="dashboard-grid">
      <button class="metric-card" data-action="control-section" data-section="operators" type="button">
        <span>Accounts</span>
        <strong>${activeOperators} / ${operators.length}</strong>
        <em>active accounts</em>
      </button>
      <button class="metric-card" data-action="control-section" data-section="classification" type="button">
        <span>Item Classification</span>
        <strong>${classified} / ${classifications.length}</strong>
        <em>loaded rows classified</em>
      </button>
      <button class="metric-card" data-action="control-section" data-section="audit" type="button">
        <span>Audit Log</span>
        <strong>${audit.length}</strong>
        <em>latest records loaded</em>
      </button>
      <button class="metric-card" data-action="control-section" data-section="sync" type="button">
        <span>NetSuite Sync</span>
        <strong>${syncSettings.mode === "auto" ? "Auto" : "Manual"}</strong>
        <em>${syncSettings.running ? "sync running" : syncSettings.lastStatus || "idle"}</em>
      </button>
      <button class="metric-card ${openWarnings ? "warning" : ""}" data-action="control-section" data-section="warnings" type="button">
        <span>Operator Warnings</span>
        <strong>${openWarnings}</strong>
        <em>open reports</em>
      </button>
      <button class="metric-card" data-action="control-section" data-section="cycle-count" type="button">
        <span>Cycle Count</span>
        <strong>${cycleRecords.length}</strong>
        <em>submitted records</em>
      </button>
      <button class="metric-card" data-action="control-section" data-section="fulfillment" type="button">
        <span>Fulfillment</span>
        <strong>${fulfillmentRecords.length}</strong>
        <em>latest IF records</em>
      </button>
    </div>
    <section class="panel">
      <h2>Control Panel</h2>
      <p class="muted">Use the left menu to register operators, maintain item classification, or review audit history.</p>
      <div class="actions">
        <button class="primary" data-action="sync-inventory">Sync Inventory</button>
        <button data-action="refresh">Refresh All</button>
      </div>
    </section>
`;
}

function renderSyncSection() {
  const isAuto = syncSettings.mode === "auto";
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>NetSuite Sync Settings</h2>
          <p class="muted">Control whether the server syncs SO, TO, and PO data automatically or only when requested.</p>
        </div>
        <button data-action="refresh">Refresh</button>
      </div>
      <div class="sync-mode-grid">
        <button class="sync-mode-card ${isAuto ? "active" : ""}" data-action="set-sync-mode" data-mode="auto" type="button">
          <strong>Auto Sync</strong>
          <span>Server syncs NetSuite order feed every minute.</span>
        </button>
        <button class="sync-mode-card ${!isAuto ? "active" : ""}" data-action="set-sync-mode" data-mode="manual" type="button">
          <strong>Manual Sync</strong>
          <span>Server syncs only when an admin or dispatcher starts it.</span>
        </button>
      </div>
      <div class="sync-status-grid">
        <label>
          <span>SO placed from</span>
          <input id="syncSalesOrderCreatedFrom" type="date" value="${escapeHtml(syncSettings.salesOrderCreatedFrom || "")}" />
        </label>
        <div>
          <span>Used by</span>
          <strong>Sales Order sync</strong>
        </div>
        <div>
          <span>PO / TO</span>
          <strong>Status based</strong>
        </div>
      </div>
      <div class="sync-status-grid">
        <div><span>Mode</span><strong>${isAuto ? "Auto" : "Manual"}</strong></div>
        <div><span>Running</span><strong>${syncSettings.running ? "Yes" : "No"}</strong></div>
        <div><span>SO Placed From</span><strong>${escapeHtml(syncSettings.salesOrderCreatedFrom || "")}</strong></div>
        <div><span>Max Runtime</span><strong>${Math.round(Number(syncSettings.maxRunSeconds || 900) / 60)} min</strong></div>
        <div><span>Last Status</span><strong>${escapeHtml(syncSettings.lastStatus || "idle")}</strong></div>
        <div><span>Last Source</span><strong>${escapeHtml(syncSettings.lastSource || "")}</strong></div>
        <div><span>Last Started</span><strong>${formatDate(syncSettings.lastStartedAt)}</strong></div>
        <div><span>Last Finished</span><strong>${formatDate(syncSettings.lastFinishedAt)}</strong></div>
      </div>
      ${syncSettings.lastError ? `<div class="notice sync-error">${escapeHtml(syncSettings.lastError)}</div>` : ""}
      <div class="notice">
        <strong>NetSuite Environment</strong>
        <span>Active now: <code>${escapeHtml(envFileLabel(envSettings.activeEnvFile))}</code>. Selected: <code>${escapeHtml(envFileLabel(envSettings.selectedEnvFile))}</code>.</span>
        ${envSettings.applyError ? `<span class="sync-error">${escapeHtml(envSettings.applyError)}</span>` : ""}
        ${envSettings.restartRequired ? `<span class="sync-error">Restart is required only because the selected env could not be safely applied live.</span>` : ""}
        <div class="sync-mode-grid">
          ${(envSettings.files || []).map((file) => `
            <button class="sync-mode-card ${file.file === envSettings.selectedEnvFile ? "active" : ""}" data-action="select-env-file" data-env-file="${escapeHtml(file.file)}" type="button" ${syncSettings.running ? "disabled" : ""}>
              <strong>${escapeHtml(envFileLabel(file.file))}</strong>
              <span>${file.active ? "Active now" : file.selected ? "Selected" : "Switch now"}${file.lastModifiedAt ? ` | Updated ${formatDate(file.lastModifiedAt)}` : ""}</span>
            </button>
          `).join("") || `<div class="muted">No env files found.</div>`}
        </div>
      </div>
      <div class="actions">
        <button class="primary" data-action="connect-netsuite" type="button">Connect NetSuite</button>
        <button data-action="save-sync-settings" type="button">Save Sync Settings</button>
        <button class="primary" data-action="run-sync-now" type="button" ${syncSettings.running ? "disabled" : ""}>Run Sync Now</button>
        <button class="danger" data-action="stop-sync" type="button">Stop / Clear Sync</button>
        <button data-action="refresh" type="button">Refresh Status</button>
      </div>
      <div class="notice">
        <strong>Environment note</strong>
        <span>The selector hot-loads NetSuite/Samsara/API settings when the database URL is unchanged. If the env file points to a different database, save it and restart. <code>server/.env.old</code> is ignored by git.</span>
      </div>
      <div class="notice sync-error">
        <strong>Development clear</strong>
        <span>Clears SO/TO/PO/CO order records, dispatch plans, operator order requests, driver job records, fulfillment/receipt records, and order warnings. Accounts, sync settings, vendor yards, parser rules, item master, item classifications, and inventory balances are kept.</span>
        <div class="actions">
          <button class="danger" data-action="clear-order-data" type="button" ${syncSettings.running ? "disabled" : ""}>Clear All Order Data</button>
        </div>
      </div>
    </section>
  `;
}

function warningTypeLabel(type) {
  return {
    confirm_line: "Confirm Line",
    item_receipt: "IR",
    item_fulfillment: "IF",
    cycle_count: "Cycle",
    customer_return: "Customer Return"
  }[type] || type || "Record";
}

function renderWarningPhotos(warning) {
  const photos = warning.details?.photos || [];
  if (!photos.length) return "";
  return `
    <div class="warning-photo-grid">
      ${photos.filter(Boolean).map((photo, index) => `<img src="${photo}" alt="Warning photo ${index + 1}" />`).join("")}
    </div>
  `;
}

function renderWarningsSection() {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Operator Warnings</h2>
          <p class="muted">Records reported by operators for supervisor review.</p>
        </div>
        <button data-action="refresh">Refresh</button>
      </div>
      <div class="warning-review-list">
        ${recordWarnings.map((warning) => `
          <details class="review-record warning-record ${warning.status}">
            <summary>
              <strong>${warning.status === "open" ? "Open" : "Resolved"}</strong>
              <span>${escapeHtml(warningTypeLabel(warning.record_type))}</span>
              <span>${escapeHtml(warning.reference || warning.record_id)}</span>
              <span>${escapeHtml(warning.operator_name || warning.operator_username || "")}</span>
              <span>${formatDate(warning.created_at)}</span>
            </summary>
            <div class="warning-body">
              <div class="notice warning-note"><strong>Reported issue</strong><span>${escapeHtml(warning.reason)}</span></div>
              ${renderWarningPhotos(warning)}
              <pre>${escapeHtml(JSON.stringify(warning.details || {}, null, 2))}</pre>
              ${warning.status === "open" ? `
                <button class="primary" data-action="resolve-warning" data-id="${warning.id}" type="button">Mark Handled</button>
              ` : `
                <div class="notice"><strong>Handled by ${escapeHtml(warning.handled_by_name || "")}</strong><span>${escapeHtml(warning.resolution || "")}</span></div>
              `}
            </div>
          </details>
        `).join("") || `<p class="muted">No operator warnings.</p>`}
      </div>
    </section>
  `;
}

function renderOperatorsSection() {
  return `
    <div class="grid">
      <section class="panel">
        <h2>Register Account</h2>
        <form class="form-grid" data-form="create-operator">
          <label><span>Username</span><input id="newUsername" required /></label>
          <label><span>Display name</span><input id="newDisplayName" required /></label>
          <label><span>Password</span><input id="newPassword" type="password" required /></label>
          <label>
            <span>Role</span>
            <select id="newRole">
              <option value="operator">Operator</option>
              <option value="dispatcher">Dispatcher</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button class="primary" type="submit">Create account</button>
        </form>
      </section>
      <section class="panel">
        <h2>Accounts</h2>
        ${renderOperators()}
      </section>
    </div>
  `;
}

function renderClassificationSection() {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Item Classification</h2>
          <p class="muted">Edit local Type, Brand, and Series for cycle count filtering.</p>
        </div>
        <div class="actions">
          <input id="classificationSearch" placeholder="Search item..." value="${classificationSearch}" />
          <button data-action="sync-inventory">Sync Inventory</button>
          <button data-action="load-classifications">Reload Items</button>
        </div>
      </div>
      ${renderClassifications()}
    </section>
  `;
}

function renderAuditSection() {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Audit Log</h2>
          <p class="muted">Latest ${audit.length} records</p>
        </div>
        <button data-action="refresh">Refresh</button>
      </div>
      ${renderAudit()}
    </section>
  `;
}

function renderCycleCountSection() {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Cycle Count Review</h2>
          <p class="muted">Review submitted blind counts with system quantities and variance.</p>
        </div>
        <button data-action="refresh">Refresh</button>
      </div>
      <div class="cycle-review-list">
        ${cycleRecords.map((record) => `
          <details class="review-record">
            <summary>
              <strong>#${record.id}</strong>
              <span>${record.operator_name || "Unknown operator"}</span>
              <span>${formatDate(record.submitted_at)}</span>
              <span>${record.line_count} lines</span>
              <span>Abs Var ${valueText(record.total_abs_variance)}</span>
            </summary>
            <div class="spreadsheet-wrap small">
              <table class="spreadsheet-table cycle-review-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Location</th>
                    <th>Counted</th>
                    <th>Counted Total</th>
                    <th>System On Hand</th>
                    <th>Available</th>
                    <th>Variance</th>
                    <th>Conversion</th>
                  </tr>
                </thead>
                <tbody>
                  ${record.lines.map((line) => `
                    <tr>
                      <td><strong>${line.item_name}</strong><br><span class="muted">${line.brand || ""} ${line.series || ""}</span></td>
                      <td>${line.location || line.location_id}</td>
                      <td>${valueText(line.counted_pallet_qty)} PLT / ${valueText(line.counted_layer_qty)} LYR / ${valueText(line.counted_section_qty)} SEC / ${valueText(line.counted_piece_qty)} PCS</td>
                      <td>${valueText(line.counted_total_qty)}</td>
                      <td>${valueText(line.system_on_hand_qty)}</td>
                      <td>${valueText(line.system_available_qty)}</td>
                      <td><strong class="${Number(line.variance_qty) === 0 ? "" : Number(line.variance_qty) > 0 ? "bad" : "warn"}">${valueText(line.variance_qty)}</strong></td>
                      <td>PLT ${valueText(line.to_plt)} / LYR ${valueText(line.to_lyr)} / SEC ${valueText(line.to_sec)} / PCS ${valueText(line.to_pcs)}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          </details>
        `).join("") || `<p class="muted">No submitted cycle counts yet.</p>`}
      </div>
    </section>
  `;
}

function renderFulfillmentSection() {
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Operator Load Records</h2>
          <p class="muted">Review local load/photo records posted by operators.</p>
        </div>
        <button data-action="refresh">Refresh</button>
      </div>
      <div class="fulfillment-review-list">
        ${fulfillmentRecords.map((record) => `
          <details class="review-record">
            <summary>
              <strong>${record.fulfillment_status || "Load"}</strong>
              <span>${record.tranid || record.order_id}</span>
              <span>${record.fulfillment_status}</span>
              <span>${record.operator_name || ""}</span>
              <span>${formatDate(record.created_at)}</span>
            </summary>
            <pre>${JSON.stringify({ payload: record.payload, response: record.response, photo: record.photo_preview ? "captured" : "" }, null, 2)}</pre>
          </details>
        `).join("") || `<p class="muted">No load records yet.</p>`}
      </div>
    </section>
  `;
}

function valueText(value) {
  return value === null || value === undefined ? "" : String(value);
}

function renderClassifications() {
  return `
    <div class="spreadsheet-wrap">
      <table class="spreadsheet-table">
        <thead>
          <tr>
            <th>Internal ID</th>
            <th>Name</th>
            <th>Description</th>
            <th>On Hand</th>
            <th>Available</th>
            <th>Type</th>
            <th>Brand</th>
            <th>Series</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${classifications.map((item) => `
            <tr data-item-row="${item.item_id}">
              <td><strong>${item.item_id}</strong></td>
              <td><strong>${item.item_name || ""}</strong><br><span class="muted">${item.display_name || ""}</span></td>
              <td>${item.item_description || ""}</td>
              <td>${valueText(item.total_on_hand)}</td>
              <td>${valueText(item.total_available)}</td>
              <td><input data-field="productType" value="${valueText(item.product_type)}" /></td>
              <td><input data-field="brand" value="${valueText(item.brand)}" /></td>
              <td><input data-field="series" value="${valueText(item.series)}" /></td>
              <td><button class="primary" data-action="save-classification" data-item="${item.item_id}">Save</button></td>
            </tr>
          `).join("") || `<tr><td colspan="9" class="muted">No items yet. Click Sync Inventory.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function renderOperators() {
  return `
    <table>
      <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Password</th><th></th></tr></thead>
      <tbody>
        ${operators.map((item) => `
          <tr>
            <td><strong>${item.display_name}</strong><br><span class="muted">${item.username}</span></td>
            <td>${item.role}</td>
            <td>${item.active ? "Active" : "Disabled"}</td>
            <td>
              <form class="password-reset-form" data-form="reset-password" data-id="${item.id}" data-name="${item.display_name}">
                <input name="password" type="password" minlength="6" placeholder="New password" autocomplete="new-password" required />
                <button class="primary" type="submit">Reset</button>
              </form>
            </td>
            <td>
              <button class="${item.active ? "danger" : ""}" data-action="toggle-active" data-id="${item.id}" data-active="${!item.active}">
                ${item.active ? "Disable" : "Enable"}
              </button>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderAudit() {
  return `
    <table>
      <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Order</th><th>Details</th></tr></thead>
      <tbody>
        ${audit.map((row) => `
          <tr>
            <td>${formatDate(row.created_at)}</td>
            <td>${row.display_name || row.actor_type}</td>
            <td><strong>${row.action}</strong><br><span class="muted">${row.source}</span></td>
            <td>${row.order_id || ""}${row.line_id ? `<br><span class="muted">Line ${row.line_id}</span>` : ""}</td>
            <td><pre>${JSON.stringify(row.details || {}, null, 2)}</pre></td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function loadControlData() {
  operators = await request("/api/operators");
  audit = await request("/api/delivery/audit?limit=100");
  classifications = await request(`/api/inventory/classifications?limit=300${classificationSearch ? `&search=${encodeURIComponent(classificationSearch)}` : ""}`);
  cycleRecords = await request("/api/cycle-count/records?limit=50");
  fulfillmentRecords = await request("/api/delivery/fulfillments?limit=100");
  recordWarnings = await request("/api/control/record-warnings?limit=100");
  syncSettings = await request("/api/control/sync-settings");
  envSettings = await request("/api/control/env-settings");
  render();
}

app.addEventListener("submit", async (event) => {
  const form = event.target.closest("form");
  if (!form) return;
  event.preventDefault();
  try {
    if (form.dataset.form === "login") {
      const result = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("username").value,
          password: document.getElementById("password").value
        })
      });
      token = result.token;
      operator = result.operator;
      localStorage.setItem(TOKEN_KEY, token);
      return loadControlData();
    }
    if (form.dataset.form === "bootstrap") {
      await request("/api/auth/bootstrap", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("username").value,
          displayName: document.getElementById("displayName").value,
          password: document.getElementById("password").value
        })
      });
      bootstrapNeeded = false;
      return renderLogin("Admin created. Please login.");
    }
    if (form.dataset.form === "create-operator") {
      await request("/api/operators", {
        method: "POST",
        body: JSON.stringify({
          username: document.getElementById("newUsername").value,
          displayName: document.getElementById("newDisplayName").value,
          password: document.getElementById("newPassword").value,
          role: document.getElementById("newRole").value
        })
      });
      return loadControlData();
    }
    if (form.dataset.form === "reset-password") {
      const password = form.querySelector('input[name="password"]').value;
      if (!confirm(`Reset password for ${form.dataset.name}? This will logout existing sessions for this account.`)) return;
      await request(`/api/operators/${form.dataset.id}/password`, {
        method: "POST",
        body: JSON.stringify({ password })
      });
      form.reset();
      alert("Password updated.");
      return loadControlData();
    }
  } catch (error) {
    alert(error.message);
  }
});

app.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  try {
    if (button.dataset.action === "control-section") {
      activeSection = button.dataset.section;
      localStorage.setItem("mbbs.control.section", activeSection);
      return render();
    }
    if (button.dataset.action === "refresh") return loadControlData();
    if (button.dataset.action === "load-classifications") {
      classificationSearch = document.getElementById("classificationSearch")?.value || "";
      return loadControlData();
    }
    if (button.dataset.action === "sync-inventory") {
      await request("/api/inventory/sync", {
        method: "POST",
        body: JSON.stringify({ locationIds: [1, 13] })
      });
      return loadControlData();
    }
    if (button.dataset.action === "set-sync-mode") {
      syncSettings = await request("/api/control/sync-settings", {
        method: "PUT",
        body: JSON.stringify({ mode: button.dataset.mode })
      });
      return loadControlData();
    }
    if (button.dataset.action === "select-env-file") {
      if (syncSettings.running) return alert("Stop the current sync before switching env file.");
      const envFile = button.dataset.envFile;
      if (!confirm(`Switch to ${envFileLabel(envFile)} now? The current NetSuite connection token will be cleared if the live switch succeeds.`)) return;
      envSettings = await request("/api/control/env-settings", {
        method: "PUT",
        body: JSON.stringify({ envFile, applyNow: true })
      });
      if (envSettings.appliedNow) {
        alert(`Switched to ${envFileLabel(envSettings.activeEnvFile)}. Please reconnect NetSuite before syncing.`);
      } else if (envSettings.applyError) {
        alert(`Selected ${envFileLabel(envSettings.selectedEnvFile)}, but live switch was not applied: ${envSettings.applyError}`);
      } else {
        alert(`${envFileLabel(envSettings.selectedEnvFile)} is selected.`);
      }
      return loadControlData();
    }
    if (button.dataset.action === "save-sync-settings") {
      const salesOrderCreatedFrom = document.getElementById("syncSalesOrderCreatedFrom")?.value || "";
      if (!salesOrderCreatedFrom) return alert("Please select the Sales Order placed-from date.");
      syncSettings = await request("/api/control/sync-settings", {
        method: "PUT",
        body: JSON.stringify({ mode: syncSettings.mode, salesOrderCreatedFrom })
      });
      return loadControlData();
    }
    if (button.dataset.action === "connect-netsuite") {
      location.href = "/api/auth/netsuite/start";
      return;
    }
    if (button.dataset.action === "run-sync-now") {
      button.disabled = true;
      button.textContent = "Starting...";
      const result = await request("/api/control/sync-now", { method: "POST" });
      syncSettings = result.settings || await request("/api/control/sync-settings");
      render();
      scheduleSyncPoll();
      alert(result.skipped ? "Sync is already running." : "NetSuite sync started in the background.");
      return;
    }
    if (button.dataset.action === "stop-sync") {
      if (!confirm("Stop the current sync or clear a stale running flag?")) return;
      await request("/api/control/sync-stop", { method: "POST" });
      return loadControlData();
    }
    if (button.dataset.action === "clear-order-data") {
      const confirmText = prompt("This clears operational SO/TO/PO/CO order data and dispatch plans only. Type CLEAR ORDERS to continue.");
      if (confirmText !== "CLEAR ORDERS") return;
      button.disabled = true;
      button.textContent = "Clearing...";
      const result = await request("/api/control/order-data/clear", {
        method: "POST",
        body: JSON.stringify({ confirmText })
      });
      const total = Object.values(result.counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
      alert(`Order data cleared. ${total} rows removed.`);
      return loadControlData();
    }
    if (button.dataset.action === "save-classification") {
      const row = app.querySelector(`[data-item-row="${button.dataset.item}"]`);
      await request(`/api/inventory/classifications/${button.dataset.item}`, {
        method: "PUT",
        body: JSON.stringify({
          productType: row.querySelector('[data-field="productType"]').value,
          brand: row.querySelector('[data-field="brand"]').value,
          series: row.querySelector('[data-field="series"]').value
        })
      });
      return loadControlData();
    }
    if (button.dataset.action === "resolve-warning") {
      const resolution = prompt("Resolution note for this warning:");
      if (!resolution) return;
      await request(`/api/control/record-warnings/${button.dataset.id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolution })
      });
      return loadControlData();
    }
    if (button.dataset.action === "logout") {
      await request("/api/auth/logout", { method: "POST" }).catch(() => ({}));
      token = "";
      operator = null;
      clearSyncPoll();
      localStorage.removeItem(TOKEN_KEY);
      return renderLogin();
    }
    if (button.dataset.action === "toggle-active") {
      await request(`/api/operators/${button.dataset.id}/active`, {
        method: "POST",
        body: JSON.stringify({ active: button.dataset.active === "true" })
      });
      return loadControlData();
    }
  } catch (error) {
    alert(error.message);
  }
});

async function boot() {
  const bootstrap = await request("/api/auth/bootstrap-needed");
  bootstrapNeeded = bootstrap.needed;
  if (!token) return renderLogin();
  try {
    const result = await request("/api/auth/me");
    operator = result.operator;
    if (operator.role !== "admin") return renderLogin("Admin account required.");
    await loadControlData();
  } catch (error) {
    renderLogin();
  }
}

boot().catch((error) => renderLogin(error.message));
