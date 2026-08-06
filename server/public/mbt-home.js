const token = localStorage.getItem("mbbs.staff.token") || "";
const statusRegion = document.querySelector(".mbt-status");
const menu = document.getElementById("mbtMenu");

const menuItems = Object.freeze([
  Object.freeze({
    title: "Feature gates",
    href: "/admin/mbt-gates",
    roles: Object.freeze(["admin"]),
    capability: null,
    summary: "Turn local MBT modules on or off with revision protection and an audit reason."
  }),
  Object.freeze({
    title: "Configuration",
    href: "/mbt/config",
    roles: Object.freeze(["admin"]),
    capability: null,
    summary: "Import customers by file and configure local items, materials, dump sites, templates, and rate cards."
  }),
  Object.freeze({
    title: "Asset registry",
    href: "/mbt/assets",
    roles: Object.freeze(["admin", "dispatcher"]),
    capability: null,
    summary: "Import or register BIN assets and inspect their append-only movement evidence."
  }),
  Object.freeze({
    title: "Front Desk",
    href: "/mbt/frontdesk",
    roles: Object.freeze(["admin", "mbt_frontdesk"]),
    capability: "frontdesk",
    summary: "Create local customer-site, quote, contract, and current front-leg records."
  }),
  Object.freeze({
    title: "BIN Dispatch",
    href: "/dispatch/planning",
    roles: Object.freeze(["admin", "dispatcher"]),
    capability: "binDispatch",
    summary: "Assign the current contract leg to an eligible BIN truck and driver."
  }),
  Object.freeze({
    title: "Driver PWA",
    href: "/driver",
    roles: Object.freeze(["admin", "dispatcher"]),
    capability: "driverBin",
    summary: "Open the Driver PWA login for the local BIN visit pilot and offline evidence workflow."
  }),
  Object.freeze({
    title: "Local billing",
    href: "/mbt/billing",
    roles: Object.freeze(["admin", "mbt_billing"]),
    capability: "billing",
    summary: "Compare receipts and distances, then calculate and review local shadow billing without posting."
  })
]);

function normalizedRoles(operator) {
  return new Set([...(Array.isArray(operator?.roles) ? operator.roles : []), operator?.role]
    .map((role) => String(role || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_"))
    .filter(Boolean));
}

async function api(path) {
  const response = await fetch(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "The MBT menu is unavailable.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

function replaceStatus(title, lines, tone = "safe") {
  if (!statusRegion) return;
  statusRegion.replaceChildren();
  statusRegion.dataset.tone = tone;
  statusRegion.setAttribute("aria-busy", "false");
  const heading = document.createElement("h2");
  heading.textContent = title;
  statusRegion.append(heading);
  for (const line of lines) {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    statusRegion.append(paragraph);
  }
}

function capabilityState(item, status) {
  if (!item.capability) return { label: "Local setup", state: "enabled" };
  const enabled = status?.capabilities?.[item.capability]?.enabled === true;
  return enabled
    ? { label: "Enabled for testing", state: "enabled" }
    : { label: "Closed", state: "closed" };
}

function renderMenu(operator, status) {
  if (!menu) return;
  const granted = normalizedRoles(operator);
  menu.replaceChildren();
  for (const item of menuItems.filter(({ roles }) => roles.some((role) => granted.has(role)))) {
    const link = document.createElement("a");
    link.className = "mbt-menu-card";
    link.href = item.href;

    const state = capabilityState(item, status);
    const badge = document.createElement("span");
    badge.className = "mbt-menu-state";
    badge.dataset.state = state.state;
    badge.textContent = state.label;

    const title = document.createElement("strong");
    title.textContent = item.title;
    const summary = document.createElement("p");
    summary.textContent = item.summary;
    link.append(badge, title, summary);
    menu.append(link);
  }
}

async function load() {
  if (!token) {
    location.replace("/");
    return;
  }
  try {
    const [{ operator }, status] = await Promise.all([
      api("/api/auth/me"),
      api("/api/mbt/status")
    ]);
    const granted = normalizedRoles(operator);
    const allowed = ["admin", "dispatcher", "mbt_frontdesk", "mbt_billing"]
      .some((role) => granted.has(role));
    if (!allowed) {
      location.replace(operator?.homeRoute || "/");
      return;
    }
    renderMenu(operator, status);
    const localCapabilities = ["frontdesk", "binDispatch", "driverBin", "billing"];
    const enabledCount = localCapabilities.filter((name) => (
      status?.capabilities?.[name]?.enabled === true
    )).length;
    replaceStatus("Local testing menu ready", [
      `${enabledCount} of ${localCapabilities.length} local operational workflows report enabled.`,
      "Customer CSV import is local. Live customer synchronization and all NetSuite posting remain closed."
    ]);
  } catch (error) {
    if (error.status === 401) {
      location.replace("/");
      return;
    }
    replaceStatus("MBT menu unavailable", [error.message], "attention");
  }
}

load();
