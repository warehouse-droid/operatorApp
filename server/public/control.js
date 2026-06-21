const app = document.getElementById("controlApp");
const TOKEN_KEY = "mbbs.control.token";

let token = localStorage.getItem(TOKEN_KEY) || "";
let operator = null;
let operators = [];
let audit = [];
let classifications = [];
let cycleRecords = [];
let fulfillmentRecords = [];
let classificationSearch = "";
let bootstrapNeeded = false;
let activeSection = localStorage.getItem("mbbs.control.section") || "dashboard";

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

function renderLogin(message = "") {
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
          ${renderMenuButton("operators", "Operators", "Register and manage accounts")}
          ${renderMenuButton("classification", "Item Classification", "Maintain type, brand, series")}
          ${renderMenuButton("cycle-count", "Cycle Count Review", "Review submitted blind counts")}
          ${renderMenuButton("fulfillment", "Delivery Fulfillment", "Review IF posting records")}
          ${renderMenuButton("audit", "Audit Log", "Trace operator and sync actions")}
        </nav>
        <section class="control-content">
          ${renderActiveSection()}
        </section>
      </div>
    </section>
  `;
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
  if (activeSection === "cycle-count") return renderCycleCountSection();
  if (activeSection === "fulfillment") return renderFulfillmentSection();
  if (activeSection === "audit") return renderAuditSection();
  return renderDashboardSection();
}

function renderDashboardSection() {
  const activeOperators = operators.filter((item) => item.active).length;
  const classified = classifications.filter((item) => item.product_type || item.brand || item.series).length;
  return `
    <div class="dashboard-grid">
      <button class="metric-card" data-action="control-section" data-section="operators" type="button">
        <span>Operators</span>
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

function renderOperatorsSection() {
  return `
    <div class="grid">
      <section class="panel">
        <h2>Register Operator</h2>
        <form class="form-grid" data-form="create-operator">
          <label><span>Username</span><input id="newUsername" required /></label>
          <label><span>Display name</span><input id="newDisplayName" required /></label>
          <label><span>Password</span><input id="newPassword" type="password" required /></label>
          <label>
            <span>Role</span>
            <select id="newRole">
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button class="primary" type="submit">Create account</button>
        </form>
      </section>
      <section class="panel">
        <h2>Operators</h2>
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
          <h2>Delivery Fulfillment</h2>
          <p class="muted">Review NetSuite item fulfillment records posted by operators.</p>
        </div>
        <button data-action="refresh">Refresh</button>
      </div>
      <div class="fulfillment-review-list">
        ${fulfillmentRecords.map((record) => `
          <details class="review-record">
            <summary>
              <strong>${record.item_fulfillment_tranid || record.item_fulfillment_id || "No IF"}</strong>
              <span>${record.tranid || record.order_id}</span>
              <span>${record.fulfillment_status}</span>
              <span>${record.operator_name || ""}</span>
              <span>${formatDate(record.created_at)}</span>
            </summary>
            <pre>${JSON.stringify({ payload: record.payload, response: record.response, photo: record.photo_preview ? "captured" : "" }, null, 2)}</pre>
          </details>
        `).join("") || `<p class="muted">No fulfillment records yet.</p>`}
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
    if (button.dataset.action === "logout") {
      await request("/api/auth/logout", { method: "POST" }).catch(() => ({}));
      token = "";
      operator = null;
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
