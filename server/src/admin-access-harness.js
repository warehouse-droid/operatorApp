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
  "../public/admin.html"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

const [server, control, login, operator, dispatchAuth, driver, sidebar, adminHtml] = files;

function includesAll(source, values, label) {
  for (const value of values) {
    assert.ok(source.includes(value), `${label} is missing: ${value}`);
  }
}

includesAll(server, [
  'app.get("/admin"',
  'if (role === "admin") return "/admin";',
  'if (role === "yard_manager") return "/control";',
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
  'app.get("/api/admin/photo-archive"'
], "server authorization");

includesAll(control, [
  'const STAFF_TOKEN_KEY = "mbbs.staff.token";',
  'const STAFF_ROLES_KEY = "mbbs.staff.roles";',
  'const IS_ADMIN_PAGE = window.location.pathname.startsWith("/admin");',
  'const ADMIN_SECTIONS = new Set(["dashboard", "operators", "sync", "storage", "audit"]);',
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
  '{ label: "Yard In/Outbound", href: "/control/yard-in-outbound"',
  '{ label: "Cycle Count Review", href: "/control/cycle-count-review"',
  '{ label: "Operator Load Records", href: "/control/operator-load-records"',
  '{ label: "Photo Storage", href: "/admin", controlSection: "storage"'
], "navigation");

includesAll(adminHtml, [
  '<title>MBBS Administration</title>',
  '<script src="/control.js?v='
], "Admin page");

console.log("Admin access regression checks passed.");
