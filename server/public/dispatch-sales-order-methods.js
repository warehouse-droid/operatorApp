let soMethodOperator = null;
let soMethodRows = [];
let soMethodSearch = "";
let soMethodSaving = "";
let soMethodNotice = "";

const soMethodApp = document.getElementById("soMethodApp");
const soMethodT = (key, fallback) => window.MBBS_I18N?.t?.(key, fallback) || fallback;

function soMethodEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function soMethodDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10) || "--";
  return date.toLocaleDateString("en-CA", { day: "2-digit", month: "short" });
}

function soMethodRender() {
  const operator = soMethodOperator || {};
  soMethodApp.innerHTML = `
    <header class="dispatch-topbar">
      <div>
        <p>${soMethodT("app.transportation", "MBBS Transportation")}</p>
        <h1>${soMethodT("dispatch.salesOrderMethods", "Sales Order Method")}</h1>
      </div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div>
      <div class="topbar-actions">
        <button onclick="location.href='/dispatch'" type="button">${soMethodT("common.menu", "Menu")}</button>
        <span class="dispatch-user">${soMethodEscape(operator.display_name || operator.username || "")}</span>
        <button onclick="dispatchLogout()" type="button">${soMethodT("common.logout", "Logout")}</button>
      </div>
    </header>
    <section class="so-method-page">
      <div class="so-method-toolbar">
        <div>
          <h2>${soMethodT("dispatch.localMethodOverride", "Local Method Override")}</h2>
          <p>Use this when NetSuite says Pick-Up but dispatch needs to plan the sales order locally.</p>
        </div>
        <label class="so-method-search">
          <span>${soMethodT("common.search", "Search")}</span>
          <input id="soMethodSearchInput" value="${soMethodEscape(soMethodSearch)}" placeholder="SOA04992 / customer" autocomplete="off" />
        </label>
      </div>
      ${soMethodNotice ? `<div class="route-notice scm-notice"><span>${soMethodEscape(soMethodNotice)}</span><button class="scm-notice-close" data-action="close-notice" type="button">x</button></div>` : ""}
      <div class="so-method-list">
        ${soMethodRows.map(soMethodRowHtml).join("") || `<div class="empty-state"><strong>No sales orders found</strong><span>Type a sales order number or customer name.</span></div>`}
      </div>
    </section>
  `;
  const input = document.getElementById("soMethodSearchInput");
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function soMethodRowHtml(row) {
  const visible = row.dispatchVisible;
  const saving = soMethodSaving === row.tranid;
  const localMethod = row.localMethod || "--";
  const netsuiteMethod = row.netsuiteMethod || "--";
  return `
    <article class="so-method-card ${visible ? "dispatch-visible" : "dispatch-hidden"}">
      <div class="so-method-main">
        <strong>${soMethodEscape(row.tranid)}</strong>
        <span>${soMethodEscape(row.customer || "--")}</span>
        <small>${soMethodEscape(row.statusText || row.status || "--")}</small>
      </div>
      <div class="so-method-meta">
        <span>Order ${soMethodDate(row.trandate)}</span>
        <span>Expected ${soMethodDate(row.expectedDeliveryDate)}</span>
        <span>${soMethodEscape(row.outboundLocation || "--")}</span>
        <span>${row.activeLineCount || 0} lines</span>
      </div>
      <div class="so-method-values">
        <div><span>NetSuite</span><b>${soMethodEscape(netsuiteMethod)}</b></div>
        <div><span>Local</span><b>${soMethodEscape(localMethod)}</b></div>
        <div><span>Dispatch</span><b>${visible ? "Visible" : "Hidden"}</b></div>
        <div><span>Override</span><b>${row.overrideActive ? "Yes" : "No"}</b></div>
      </div>
      <div class="so-method-actions">
        <button class="primary-action" data-action="set-method" data-tranid="${soMethodEscape(row.tranid)}" data-method="Delivery" ${saving || localMethod === "Delivery" ? "disabled" : ""} type="button">Set Delivery</button>
        <button class="secondary-button" data-action="set-method" data-tranid="${soMethodEscape(row.tranid)}" data-method="Pick-Up" ${saving || localMethod === "Pick-Up" ? "disabled" : ""} type="button">Set Pick-Up</button>
      </div>
    </article>
  `;
}

let soMethodSearchTimer = null;
async function soMethodLoad() {
  const search = soMethodSearch.trim();
  const response = await fetch(`/api/dispatch/sales-order-methods?search=${encodeURIComponent(search)}&limit=50`);
  if (!response.ok) throw new Error(await response.text());
  soMethodRows = await response.json();
  soMethodRender();
}

function soMethodScheduleSearch(value) {
  soMethodSearch = value;
  window.clearTimeout(soMethodSearchTimer);
  soMethodSearchTimer = window.setTimeout(async () => {
    try {
      await soMethodLoad();
    } catch (error) {
      soMethodNotice = `Search failed: ${error.message}`;
      soMethodRender();
    }
  }, 180);
}

async function soMethodSet(tranid, method) {
  soMethodSaving = tranid;
  soMethodNotice = "";
  soMethodRender();
  try {
    const response = await fetch(`/api/dispatch/sales-order-methods/${encodeURIComponent(tranid)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method })
    });
    if (!response.ok) throw new Error(await response.text());
    const payload = await response.json();
    soMethodRows = soMethodRows.map((row) => row.tranid === tranid ? payload.updated : row);
    soMethodNotice = `${tranid} local method updated to ${payload.updated.localMethod}.`;
  } catch (error) {
    soMethodNotice = `Update failed: ${error.message}`;
  } finally {
    soMethodSaving = "";
    soMethodRender();
  }
}

soMethodApp.addEventListener("input", (event) => {
  if (event.target?.id === "soMethodSearchInput") soMethodScheduleSearch(event.target.value);
});

soMethodApp.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.dataset.action === "close-notice") {
    soMethodNotice = "";
    soMethodRender();
  }
  if (button.dataset.action === "set-method") {
    soMethodSet(button.dataset.tranid, button.dataset.method);
  }
});

window.addEventListener("mbbs-language-changed", soMethodRender);

requireDispatchLogin({
  mount: soMethodApp,
  onReady(operator) {
    soMethodOperator = operator;
    soMethodRender();
    soMethodLoad().catch((error) => {
      soMethodNotice = `Load failed: ${error.message}`;
      soMethodRender();
    });
  }
});
