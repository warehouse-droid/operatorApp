import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = await Promise.all([
  "server.js",
  "../public/control.js",
  "../public/login.js",
  "../public/operator.js",
  "../public/dispatch-auth.js",
  "../public/driver.js",
  "../public/app-sidebar.js",
  "../public/admin.html",
  "auth-repository.js"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

const [server, control, login, operator, dispatchAuth, driver, sidebar, adminHtml, authRepository] = files;
const controlCss = await readFile(new URL("../public/control.css", import.meta.url), "utf8");
const salesSettingsRepository = await readFile(new URL("sales-settings-repository.js", import.meta.url), "utf8");
const salesSettingsMigration = await readFile(new URL("../migrations/064_sales_portal_settings.sql", import.meta.url), "utf8");

function includesAll(source, values, label) {
  for (const value of values) {
    assert.ok(source.includes(value), `${label} is missing: ${value}`);
  }
}

includesAll(server, [
  '"/admin/accounts"',
  '"/admin/sync"',
  '"/admin/reconciliation"',
  '"/admin/photo-storage"',
  '"/admin/audit"',
  'return operatorHomeRoute(operator);',
  'operatorHasAnyRole(req.operator, ["admin", "yard_manager"])',
  'operatorHasAnyRole(req.operator, ["admin", "operator", "yard_manager"])',
  'action: "operator.login"',
  'action: "operator.login_failed"',
  'action: "driver.login"',
  'action: "driver.login_failed"',
  'res.status(403).json({ error: message, redirect: roleHomeRoute(operator) })',
  '"/control/order-locks"',
  '"/control/item-classification"',
  '"/control/vendor-mapping"',
  '"/control/operator-warnings"',
  '"/control/yard-in-outbound"',
  '"/control/cycle-count-review"',
  '"/control/operator-load-records"',
  'app.get("/api/admin/photo-archive"',
  'app.get("/api/admin/public-sales"',
  'app.put("/api/admin/public-sales"',
  'action: "sales.public_access_update"',
  "await isPublicSalesAccessEnabled()"
], "server authorization");

includesAll(authRepository, [
  'if (role === "admin") return "/admin";',
  'if (role === "dispatcher") return "/dispatch";',
  'if (role === "scm" || role === "scm_staff") return "/scm";',
  'if (role === "yard_manager") return "/control";',
  'if (role === "sales") return "/sales";',
  'if (role === "operator") return "/operator";'
], "shared staff home routing");

includesAll(control, [
  'const STAFF_TOKEN_KEY = "mbbs.staff.token";',
  'const STAFF_ROLES_KEY = "mbbs.staff.roles";',
  'const IS_ADMIN_PAGE = window.location.pathname.startsWith("/admin");',
  'const ADMIN_SECTIONS = new Set(["dashboard", "operators", "sync", "reconciliation", "return-automation", "storage", "audit"]);',
  'const ADMIN_SECTION_ROUTES = {',
  'operators: "/admin/accounts"',
  'reconciliation: "/admin/reconciliation"',
  'storage: "/admin/photo-storage"',
  'const CONTROL_SECTION_ROUTES = {',
  'function sectionFromCurrentRoute()',
  'window.history.pushState({ controlSection: activeSection }, "", route);',
  '? hasStaffAuthority(account, ["admin"])',
  'window.location.replace(roleHomeRoute(operator.role));',
  'request("/api/operators"),',
  'function renderStorageSection()',
  'data-new-authority',
  'data-account-authority',
  'data-account-primary-role',
  'class="account-management-layout"',
  'class="account-user-list"',
  'data-action="select-account"',
  'data-action="new-account"',
  'renderOperatorDetail(selected)',
  'data-action="save-account-roles"',
  'class="panel public-sales-access-card"',
  'data-action="toggle-public-sales"',
  'request("/api/admin/public-sales")',
  'body: JSON.stringify({ enabled })',
  'method: "PUT"',
  '`/api/operators/${button.dataset.id}/roles`',
  'classifications = await request(`/api/inventory/classifications'
], "Admin/Control page split");

assert.ok(!control.includes('class="control-menu"'), "The in-page control-menu should be removed");
assert.ok(!control.includes("function renderPageMenu()"), "The obsolete Control menu renderer should be removed");

includesAll(login, [
  'const STAFF_TOKEN_KEY = "mbbs.staff.token";',
  'if (clean === "admin") return "/admin";',
  'if (clean === "yard_manager") return "/control";'
], "login routing");

includesAll(operator, [
  'const STAFF_TOKEN_KEY = "mbbs.staff.token";',
  'const STAFF_ROLES_KEY = "mbbs.staff.roles";',
  '["admin", "operator", "yard_manager"].some((role) => roles.has(role))',
  'localStorage.getItem("mbbs.driver.token")',
  'window.location.replace(staffRoleHome(operator.role));'
], "Operator access");

includesAll(dispatchAuth, [
  'const DISPATCH_STAFF_TOKEN_KEY = "mbbs.staff.token";',
  'const DISPATCH_STAFF_ROLES_KEY = "mbbs.staff.roles";',
  "DISPATCH_PUBLIC_SALES_PAGE && dispatchAuthOperator?.publicSales",
  'if (clean === "yard_manager") return "/control";',
  'localStorage.getItem("mbbs.driver.token")',
  'window.location.replace(dispatchRoleHome(payload.operator?.role));'
], "Dispatch access");

includesAll(driver, [
  'const STAFF_TOKEN_KEY = "mbbs.staff.token";',
  'if (clean === "admin") return "/admin";',
  'window.location.replace(staffHomeRoute(payload.operator?.role));',
  'if (await redirectExistingStaffSession()) return;'
], "Driver access redirect");

includesAll(sidebar, [
  'path.startsWith("/admin")',
  'localStorage.getItem("mbbs.staff.roles")',
  'if (roles.has("admin")) return mainItems.filter((item) => item.href !== "/driver");',
  'if (roles.has("yard_manager")) ["/control", "/operator"].forEach((href) => visiblePaths.add(href));',
  '{ label: "Order Locks", href: "/control/order-locks"',
  '{ label: "Item Classification", href: "/control/item-classification"',
  '{ label: "Vendor Mapping", href: "/control/vendor-mapping"',
  '{ label: "Operator Warnings", href: "/control/operator-warnings"',
  '{ label: "In/Outbound Record", href: "/control/yard-in-outbound"',
  '{ label: "Cycle Count Review", href: "/control/cycle-count-review"',
  '{ label: "Operator Load Records", href: "/control/operator-load-records"',
  '{ label: "Accounts", href: "/admin/accounts", controlSection: "operators"',
  '{ label: "Sync", href: "/admin/sync", controlSection: "sync"',
  '{ label: "SO / PO / TO Reconcile", href: "/admin/reconciliation", controlSection: "reconciliation"',
  '{ label: "Photo Storage", href: "/admin/photo-storage", controlSection: "storage"',
  '{ label: "Audit", href: "/admin/audit", controlSection: "audit"'
], "navigation");

assert.ok(!sidebar.includes("event.preventDefault()"), "Sidebar section links must retain native navigation");
includesAll(control, [
  'IS_ADMIN_PAGE && ["sync", "reconciliation"].includes(activeSection)',
  '"admin-reconciliation-page"',
  'IS_ADMIN_PAGE && activeSection === "reconciliation"'
], "Admin Sync and reconciliation responsive scope");
includesAll(controlCss, [
  "@media (max-width: 760px)",
  ".public-sales-access-card",
  ".public-sales-access-control",
  ".admin-sync-page .sync-mode-grid",
  ".admin-sync-page .sync-status-grid",
  ".admin-sync-page .panel > .actions",
  ".scm-reconciliation-workspace",
  ".scm-reconciliation-run-browser",
  ".scm-reconciliation-selected-detail"
], "Admin Sync and reconciliation phone layout");

includesAll(salesSettingsRepository, [
  "export async function getSalesPortalSettings",
  "export async function isPublicSalesAccessEnabled",
  "export async function updateSalesPortalSettings",
  "legacy_environment",
  "typeof input.enabled !== \"boolean\""
], "Public Sales persisted settings");

includesAll(salesSettingsMigration, [
  "CREATE TABLE IF NOT EXISTS sales_portal_settings",
  "public_access_enabled boolean",
  "sales_portal_settings_singleton"
], "Public Sales settings migration");
includesAll(sidebar, [
  "body.admin-sync-page.has-app-sidebar",
  "body.scm-transfer-dependencies-page.has-app-sidebar",
  "inset: auto 0 0 0;"
], "phone bottom navigation");

includesAll(adminHtml, [
  '<title>MBBS Administration</title>',
  '<script src="/control.js?v='
], "Admin page");

console.log("Admin access regression checks passed.");
