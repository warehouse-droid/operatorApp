const vendorApp = document.getElementById("scmVendorsApp");

const vendorState = {
  operator: null,
  vendors: [],
  yards: [],
  weekDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  selectedVendorId: "",
  selectedYardRowId: "",
  addingVendor: false,
  addingYard: false,
  search: "",
  busy: "",
  notice: "",
  error: ""
};

function vendorEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function vendorRoles() {
  return new Set([
    ...(Array.isArray(vendorState.operator?.roles) ? vendorState.operator.roles : []),
    vendorState.operator?.role
  ].map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_")).filter(Boolean));
}

function vendorCanWrite() {
  const roles = vendorRoles();
  return ["admin", "scm", "scm_staff"].some((role) => roles.has(role));
}

async function vendorApi(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body === "object") {
    headers["Content-Type"] = "application/json";
    options = { ...options, body: JSON.stringify(options.body) };
  }
  const response = await fetch(url, { ...options, headers });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
  return payload;
}

function selectedVendor() {
  return vendorState.vendors.find((vendor) => String(vendor.id) === String(vendorState.selectedVendorId)) || null;
}

function groupedYards(vendor = selectedVendor()) {
  if (!vendor) return [];
  const groups = new Map();
  for (const row of vendorState.yards) {
    if (String(row.vendor || "").trim().toLowerCase() !== String(vendor.name || "").trim().toLowerCase()) continue;
    const key = String(row.yard || "").trim().toLowerCase();
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, {
      key,
      rowId: row.id,
      yard: row.yard,
      address: row.address || "",
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      rows: []
    });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].sort((left, right) => left.yard.localeCompare(right.yard));
}

function selectedYard() {
  return groupedYards().find((yard) => yard.rows.some((row) => String(row.id) === String(vendorState.selectedYardRowId))) || null;
}

function activeDayRows(yard) {
  return (yard?.rows || []).filter((row) => row.active && vendorState.weekDays.includes(row.dayLabel));
}

function legacyDayApplies(label, day) {
  const index = vendorState.weekDays.indexOf(day);
  const clean = String(label || "").trim().toLowerCase();
  if (clean === "mon-fri") return index >= 0 && index <= 4;
  if (clean === "mon-sat") return index >= 0 && index <= 5;
  if (clean === "daily" || clean === "every day") return index >= 0;
  return false;
}

function scheduleRowFor(yard, day) {
  const exact = (yard?.rows || []).find((row) => row.dayLabel === day);
  if (exact) return exact;
  return (yard?.rows || []).find((row) => legacyDayApplies(row.dayLabel, day)) || null;
}

function hoursSummary(yard) {
  const active = vendorState.weekDays
    .map((day) => ({ day, row: scheduleRowFor(yard, day) }))
    .filter(({ row }) => row?.active);
  if (!active.length) return "No opening days";
  const withHours = active.filter(({ row }) => row.windowStart && row.windowEnd);
  if (!withHours.length) return `${active.length} open day${active.length === 1 ? "" : "s"} · hours not set`;
  const ranges = new Set(withHours.map(({ row }) => `${row.windowStart}–${row.windowEnd}`));
  return `${active.length} open day${active.length === 1 ? "" : "s"} · ${[...ranges].slice(0, 2).join(", ")}`;
}

function filteredVendors() {
  const term = vendorState.search.trim().toLowerCase();
  if (!term) return vendorState.vendors;
  return vendorState.vendors.filter((vendor) => {
    const yards = groupedYards(vendor);
    return `${vendor.name} ${yards.map((yard) => `${yard.yard} ${yard.address}`).join(" ")}`.toLowerCase().includes(term);
  });
}

function vendorHeader() {
  return `<header class="dispatch-topbar">
    <div class="smart-brand"><div class="smart-brand-mark">LV</div><div><p>Smart SCM setup</p><h1>Local Vendors</h1></div></div>
    <span class="smart-mode">Vendor yards & opening hours</span>
    <div class="topbar-actions">
      <span class="dispatch-user">${vendorEscape(vendorState.operator?.display_name || vendorState.operator?.username || "")}</span>
      <button type="button" onclick="location.href='/scm'">SCM menu</button>
      <button type="button" onclick="dispatchLogout()">Logout</button>
    </div>
  </header>`;
}

function vendorList() {
  const vendors = filteredVendors();
  return `<aside class="vendor-directory">
    <div class="vendor-directory-head">
      <div><h2>Local vendors</h2><p>${vendorState.vendors.length} vendor${vendorState.vendors.length === 1 ? "" : "s"}</p></div>
      ${vendorCanWrite() ? `<button class="smart-button primary" data-vendor-action="add-vendor" type="button">+ Vendor</button>` : ""}
    </div>
    <label class="vendor-search"><span>Search</span><input id="vendorSearch" type="search" value="${vendorEscape(vendorState.search)}" placeholder="Vendor, yard, or address"></label>
    <div class="vendor-directory-list">
      ${vendors.map((vendor) => {
        const yards = groupedYards(vendor);
        const selected = String(vendor.id) === String(vendorState.selectedVendorId) && !vendorState.addingVendor;
        return `<button class="vendor-directory-card ${selected ? "selected" : ""} ${vendor.active ? "" : "inactive"}" data-vendor-action="select-vendor" data-vendor-id="${vendor.id}" type="button">
          <span><strong>${vendorEscape(vendor.name)}</strong>${vendor.active ? "" : "<em>Inactive</em>"}</span>
          <small>${yards.length} yard${yards.length === 1 ? "" : "s"} · ${Number(vendor.mappingCount || 0)} NetSuite mapping${Number(vendor.mappingCount || 0) === 1 ? "" : "s"}</small>
        </button>`;
      }).join("") || `<div class="smart-empty">No local vendor matches this search.</div>`}
    </div>
  </aside>`;
}

function newVendorForm() {
  return `<section class="smart-section vendor-editor-panel">
    <div class="smart-section-head"><div><h2>Add local vendor</h2><p>Create the vendor first, then add one or more pickup yards.</p></div></div>
    <form class="vendor-identity-form vendor-create-form" data-vendor-form="create-vendor">
      <label class="smart-field"><span>Local vendor name</span><input name="name" maxlength="180" placeholder="Example: UNILOCK" autofocus required></label>
      <div class="vendor-form-actions"><button class="smart-button" data-vendor-action="cancel-add-vendor" type="button">Cancel</button><button class="smart-button primary" type="submit">Create vendor</button></div>
    </form>
  </section>`;
}

function dayEditor(yard, disabled) {
  return `<div class="vendor-hours-table">
    <div class="vendor-hours-row vendor-hours-head"><span>Open</span><strong>Day</strong><strong>Opening time</strong><strong>Closing time</strong><strong>Instruction</strong></div>
    ${vendorState.weekDays.map((day) => {
      const row = scheduleRowFor(yard, day) || {};
      return `<div class="vendor-hours-row" data-vendor-day="${vendorEscape(day)}">
        <label class="vendor-open-check"><input name="${day}-active" type="checkbox" ${row.active ? "checked" : ""} ${disabled}> <span class="vendor-open-label">Open</span></label>
        <strong>${vendorEscape(day)}</strong>
        <input aria-label="${vendorEscape(day)} opening time" name="${day}-start" type="time" value="${vendorEscape(row.windowStart || "")}" ${disabled}>
        <input aria-label="${vendorEscape(day)} closing time" name="${day}-end" type="time" value="${vendorEscape(row.windowEnd || "")}" ${disabled}>
        <input aria-label="${vendorEscape(day)} instruction" name="${day}-instructions" value="${vendorEscape(row.instructions || "")}" placeholder="Optional receiving note" ${disabled}>
      </div>`;
    }).join("")}
  </div>`;
}

function yardEditor(vendor, yard = null) {
  const isNew = vendorState.addingYard || !yard;
  const disabled = vendorCanWrite() ? "" : "disabled";
  return `<form class="vendor-yard-editor" data-vendor-form="save-yard">
    <div class="vendor-yard-editor-head">
      <div><h3>${isNew ? "Add vendor yard" : vendorEscape(yard.yard)}</h3><p>${isNew ? `Create a pickup yard for ${vendorEscape(vendor.name)}.` : "Rename the yard or adjust its weekly opening schedule."}</p></div>
      ${vendorCanWrite() && isNew ? `<button class="smart-button" data-vendor-action="cancel-add-yard" type="button">Cancel</button>` : ""}
    </div>
    <div class="vendor-yard-fields">
      <label class="smart-field"><span>Yard name</span><input name="yard" maxlength="180" value="${vendorEscape(yard?.yard || "")}" placeholder="Example: UNILOCK Gormley" required ${disabled}></label>
      <label class="smart-field"><span>Address</span><input name="address" value="${vendorEscape(yard?.address || "")}" placeholder="Street, city, province, postal code" ${disabled}></label>
      <label class="smart-field"><span>Aliases</span><input name="aliases" value="${vendorEscape((yard?.aliases || []).join(", "))}" placeholder="Memo names, separated by commas" ${disabled}></label>
    </div>
    <div class="vendor-hours-title">
      <div><h4>Opening days and hours</h4><p>Closed days stay available for future changes but are ignored by dispatch planning.</p></div>
      ${vendorCanWrite() ? `<button class="smart-button" data-vendor-action="copy-weekdays" type="button">Copy Monday to Mon–Fri</button>` : ""}
    </div>
    ${dayEditor(yard, disabled)}
    <div class="vendor-save-bar">
      <span>${isNew ? "The yard will become available to PO Split, Smart SCM, VRMA, and dispatch after save." : "Changes apply to the shared local-vendor record used throughout SCM and dispatch."}</span>
      ${vendorCanWrite() ? `<button class="smart-button primary" type="submit">${isNew ? "Create vendor yard" : "Save yard & hours"}</button>` : ""}
    </div>
  </form>`;
}

function vendorWorkspace() {
  if (vendorState.addingVendor) return newVendorForm();
  const vendor = selectedVendor();
  if (!vendor) return `<section class="smart-section vendor-editor-panel"><div class="smart-empty">Select a local vendor to manage its yards and opening hours.</div></section>`;
  const yards = groupedYards(vendor);
  const yard = selectedYard() || (!vendorState.addingYard ? yards[0] : null);
  if (yard && !vendorState.selectedYardRowId) vendorState.selectedYardRowId = yard.rowId;
  return `<section class="smart-section vendor-editor-panel">
    <div class="vendor-identity-head">
      <div><span class="vendor-kicker">Local vendor</span><h2>${vendorEscape(vendor.name)}</h2><p>Renaming this vendor also updates its vendor yards and NetSuite vendor mappings.</p></div>
      <span class="vendor-status ${vendor.active ? "active" : "inactive"}">${vendor.active ? "Active" : "Inactive"}</span>
    </div>
    <form class="vendor-identity-form" data-vendor-form="rename-vendor">
      <label class="smart-field"><span>Vendor name</span><input name="name" maxlength="180" value="${vendorEscape(vendor.name)}" required ${vendorCanWrite() ? "" : "disabled"}></label>
      ${vendorCanWrite() ? `<button class="smart-button primary" type="submit">Save vendor name</button>` : ""}
    </form>
    <div class="vendor-yard-layout">
      <aside class="vendor-yard-directory">
        <div class="vendor-yard-directory-head"><div><h3>Vendor yards</h3><p>${yards.length} yard${yards.length === 1 ? "" : "s"}</p></div>${vendorCanWrite() ? `<button class="smart-button" data-vendor-action="add-yard" type="button">+ Yard</button>` : ""}</div>
        <div class="vendor-yard-list">
          ${yards.map((item) => `<button class="vendor-yard-card ${yard?.key === item.key && !vendorState.addingYard ? "selected" : ""}" data-vendor-action="select-yard" data-yard-row-id="${item.rowId}" type="button">
            <strong>${vendorEscape(item.yard)}</strong><span>${vendorEscape(item.address || "No address entered")}</span><small>${vendorEscape(hoursSummary(item))}</small>
          </button>`).join("") || `<div class="smart-empty">No yard has been added for this vendor.</div>`}
        </div>
      </aside>
      <div class="vendor-yard-workspace">
        ${vendorState.addingYard || !yards.length
          ? (vendorCanWrite() ? yardEditor(vendor) : `<div class="smart-empty">This vendor has no yard records.</div>`)
          : yardEditor(vendor, yard)}
      </div>
    </div>
  </section>`;
}

function vendorRender() {
  vendorApp.innerHTML = `${vendorHeader()}<div class="smart-main vendor-main">
    ${vendorState.error ? `<div class="smart-notice error">${vendorEscape(vendorState.error)}</div>` : ""}
    ${vendorState.notice ? `<div class="smart-notice">${vendorEscape(vendorState.notice)}</div>` : ""}
    ${vendorState.busy ? `<div class="smart-notice">${vendorEscape(vendorState.busy)}…</div>` : ""}
    ${!vendorCanWrite() ? `<div class="smart-notice">Read-only access. An Admin, SCM, or SCM Staff account is required to change local vendors.</div>` : ""}
    <div class="vendor-manager-layout">${vendorList()}${vendorWorkspace()}</div>
  </div>`;
}

function applyVendorPayload(payload) {
  vendorState.vendors = Array.isArray(payload?.vendors) ? payload.vendors : [];
  vendorState.yards = Array.isArray(payload?.yards) ? payload.yards : [];
  if (Array.isArray(payload?.weekDays) && payload.weekDays.length) vendorState.weekDays = payload.weekDays;
  if (!vendorState.vendors.some((vendor) => String(vendor.id) === String(vendorState.selectedVendorId))) {
    vendorState.selectedVendorId = String(vendorState.vendors.find((vendor) => vendor.active)?.id || vendorState.vendors[0]?.id || "");
  }
  const yards = groupedYards();
  if (!yards.some((yard) => yard.rows.some((row) => String(row.id) === String(vendorState.selectedYardRowId)))) {
    vendorState.selectedYardRowId = String(yards[0]?.rowId || "");
  }
}

async function vendorLoad() {
  vendorState.busy = "Loading local vendors";
  vendorRender();
  const payload = await vendorApi("/api/scm/local-vendors");
  applyVendorPayload(payload);
  vendorState.busy = "";
  vendorRender();
}

function collectYardPayload(form) {
  const data = new FormData(form);
  return {
    yard: String(data.get("yard") || "").trim(),
    address: String(data.get("address") || "").trim(),
    aliases: String(data.get("aliases") || "").split(",").map((value) => value.trim()).filter(Boolean),
    days: vendorState.weekDays.map((dayLabel) => ({
      dayLabel,
      active: data.get(`${dayLabel}-active`) === "on",
      windowStart: String(data.get(`${dayLabel}-start`) || "").trim(),
      windowEnd: String(data.get(`${dayLabel}-end`) || "").trim(),
      instructions: String(data.get(`${dayLabel}-instructions`) || "").trim()
    }))
  };
}

vendorApp.addEventListener("input", (event) => {
  if (event.target?.id !== "vendorSearch") return;
  vendorState.search = event.target.value;
  const caret = event.target.selectionStart;
  vendorRender();
  const next = document.getElementById("vendorSearch");
  next?.focus();
  next?.setSelectionRange(caret, caret);
});

vendorApp.addEventListener("click", (event) => {
  const button = event.target.closest("[data-vendor-action]");
  if (!button || vendorState.busy) return;
  vendorState.error = "";
  vendorState.notice = "";
  const action = button.dataset.vendorAction;
  if (action === "add-vendor") {
    vendorState.addingVendor = true;
    vendorState.addingYard = false;
  } else if (action === "cancel-add-vendor") {
    vendorState.addingVendor = false;
  } else if (action === "select-vendor") {
    vendorState.selectedVendorId = button.dataset.vendorId;
    vendorState.selectedYardRowId = "";
    vendorState.addingVendor = false;
    vendorState.addingYard = false;
  } else if (action === "add-yard") {
    vendorState.addingYard = true;
  } else if (action === "cancel-add-yard") {
    vendorState.addingYard = false;
  } else if (action === "select-yard") {
    vendorState.selectedYardRowId = button.dataset.yardRowId;
    vendorState.addingYard = false;
  } else if (action === "copy-weekdays") {
    const form = button.closest("form");
    const mondayActive = form.elements["Monday-active"].checked;
    const mondayStart = form.elements["Monday-start"].value;
    const mondayEnd = form.elements["Monday-end"].value;
    const mondayInstructions = form.elements["Monday-instructions"].value;
    for (const day of vendorState.weekDays.slice(1, 5)) {
      form.elements[`${day}-active`].checked = mondayActive;
      form.elements[`${day}-start`].value = mondayStart;
      form.elements[`${day}-end`].value = mondayEnd;
      form.elements[`${day}-instructions`].value = mondayInstructions;
    }
    vendorState.notice = "Monday hours copied to Tuesday through Friday. Save the yard to apply them.";
    return;
  }
  vendorRender();
});

vendorApp.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-vendor-form]");
  if (!form || vendorState.busy || !vendorCanWrite()) return;
  event.preventDefault();
  vendorState.error = "";
  vendorState.notice = "";
  try {
    if (form.dataset.vendorForm === "create-vendor") {
      const name = String(new FormData(form).get("name") || "").trim();
      if (!name) throw new Error("Enter a local vendor name.");
      vendorState.busy = `Creating ${name}`;
      vendorRender();
      const payload = await vendorApi("/api/scm/local-vendors", { method: "POST", body: { name } });
      applyVendorPayload(payload);
      vendorState.selectedVendorId = String(payload.created?.id || vendorState.selectedVendorId);
      vendorState.selectedYardRowId = "";
      vendorState.addingVendor = false;
      vendorState.addingYard = true;
      vendorState.notice = `${name} created. Add its first vendor yard.`;
    } else if (form.dataset.vendorForm === "rename-vendor") {
      const vendor = selectedVendor();
      const name = String(new FormData(form).get("name") || "").trim();
      if (!vendor || !name) throw new Error("Enter a local vendor name.");
      vendorState.busy = `Saving ${name}`;
      vendorRender();
      const payload = await vendorApi(`/api/scm/local-vendors/${encodeURIComponent(vendor.id)}`, {
        method: "PUT",
        body: { name, active: vendor.active !== false }
      });
      applyVendorPayload(payload);
      vendorState.notice = `Local vendor name saved as ${name}.`;
    } else if (form.dataset.vendorForm === "save-yard") {
      const vendor = selectedVendor();
      if (!vendor) throw new Error("Select a local vendor.");
      const payload = collectYardPayload(form);
      if (!payload.yard) throw new Error("Enter a vendor yard name.");
      const isNew = vendorState.addingYard || !selectedYard();
      const yardRowId = selectedYard()?.rowId;
      vendorState.busy = `${isNew ? "Creating" : "Saving"} ${payload.yard}`;
      vendorRender();
      const result = await vendorApi(
        isNew
          ? `/api/scm/local-vendors/${encodeURIComponent(vendor.id)}/yards`
          : `/api/scm/local-vendors/${encodeURIComponent(vendor.id)}/yards/${encodeURIComponent(yardRowId)}`,
        { method: isNew ? "POST" : "PUT", body: payload }
      );
      applyVendorPayload(result);
      vendorState.selectedYardRowId = String(result.saved?.rows?.[0]?.id || vendorState.selectedYardRowId);
      vendorState.addingYard = false;
      vendorState.notice = `${payload.yard} and its opening hours saved. Dispatch enrichment was refreshed.`;
    }
  } catch (error) {
    vendorState.error = error.message;
  } finally {
    vendorState.busy = "";
    vendorRender();
  }
});

window.addEventListener("mbbs-language-changed", vendorRender);

requireDispatchLogin({
  mount: vendorApp,
  roles: ["admin", "scm", "scm_staff", "dispatcher", "yard_manager"],
  async onReady(operator) {
    vendorState.operator = operator;
    vendorRender();
    try {
      await vendorLoad();
    } catch (error) {
      vendorState.busy = "";
      vendorState.error = error.message;
      vendorRender();
    }
  }
});
