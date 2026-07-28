const salesApp = document.getElementById("salesApp");
const salesT = (key, fallback) => window.MBBS_I18N?.t(key, fallback) || fallback;
const SALES_YARDS = [
  { locationId: 1, yardCode: "3445" },
  { locationId: 28, yardCode: "2967" },
  { locationId: 15, yardCode: "12441" },
  { locationId: 26, yardCode: "150" }
];
let salesOperator = null;

function salesEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function salesRoles(operator) {
  return new Set([...(operator?.roles || []), operator?.role].map((role) => String(role || "").trim().toLowerCase()));
}

function salesYardCodes(operator) {
  if (salesRoles(operator).has("admin")) return SALES_YARDS.map((yard) => yard.yardCode);
  const allowed = new Set((operator?.yardLocationIds || []).map(Number));
  return SALES_YARDS.filter((yard) => allowed.has(yard.locationId)).map((yard) => yard.yardCode);
}

function renderSales() {
  const operator = salesOperator || {};
  const yards = salesYardCodes(operator);
  salesApp.innerHTML = `
    <header class="dispatch-topbar">
      <div><p>MBBS Operation</p><h1>${salesT("sales.title", "Sales")}</h1></div>
      <div class="topbar-language">${window.MBBS_I18N?.toggleHtml?.() || ""}</div>
      <div class="topbar-actions">
        <span class="dispatch-user">${salesEscape(operator.display_name || operator.username || "")}</span>
        ${operator.publicSales ? "" : `<button onclick="dispatchLogout()" type="button">${salesT("common.logout", "Logout")}</button>`}
      </div>
    </header>
    <section class="dispatch-menu-page">
      <div class="dispatch-menu-heading">
        <h2>${salesT("sales.menu", "Sales Menu")}</h2>
        <p>${operator.publicSales ? "Available" : "Authorized"} yards: ${salesEscape(yards.join(", ") || "None assigned")}</p>
      </div>
      ${yards.length ? "" : `<div class="route-notice"><span>No Sales yards are assigned to this account. Ask an administrator to update Account Management.</span></div>`}
      <div class="dispatch-menu-grid">
        <button class="dispatch-menu-card primary-card" onclick="location.href='/sales/planning'" type="button">
          <strong>Dispatch Planning</strong><span>Review daily loads, routes, trucks, orders, and stops in permanent view-only mode.</span>
        </button>
        <button class="dispatch-menu-card" onclick="location.href='/sales/schedule'" type="button">
          <strong>PO / TO Schedule</strong><span>Review Yard Manager and Completed schedule views for your authorized yards.</span>
        </button>
        <button class="dispatch-menu-card" onclick="location.href='/sales/monitor'" type="button">
          <strong>Truck Monitor</strong><span>View live truck locations, active loads, and stop progress.</span>
        </button>
        <button class="dispatch-menu-card" onclick="location.href='/sales/printing'" type="button">
          <strong>Sales Order Printing</strong><span>Find Delivery orders by ordering location, preview the selected line-yard ticket, and review every stored print snapshot.</span>
        </button>
        ${operator.publicSales ? "" : `
          <button class="dispatch-menu-card" onclick="location.href='/sales/in-outbound-record'" type="button">
            <strong>${salesT("control.loadedExport", "In/Outbound Record")}</strong>
            <span>${salesT("control.loadedExportHelp", "Review yard processing, driver delivery timestamps, details, and photo proof.")}</span>
          </button>
        `}
      </div>
    </section>
  `;
}

window.addEventListener("mbbs-language-changed", renderSales);
requireDispatchLogin({
  mount: salesApp,
  roles: ["sales", "admin"],
  onReady(operator) {
    salesOperator = operator;
    renderSales();
  }
});
