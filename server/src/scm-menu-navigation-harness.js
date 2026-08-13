import assert from "node:assert/strict";
import fs from "node:fs";

const publicUrl = new URL("../public/", import.meta.url);
const readPublic = (name) => fs.readFileSync(new URL(name, publicUrl), "utf8");
const sidebar = readPublic("app-sidebar.js");
const menu = readPublic("scm-menu.html");
const page = readPublic("scm-netsuite-po.js");
const server = fs.readFileSync(new URL("server.js", import.meta.url), "utf8");

const menuRoles = 'roles: ["admin", "scm", "scm_staff", "dispatcher", "yard_manager"]';
const purchaseOrderRoles = 'roles: ["admin", "scm", "scm_staff"]';

assert.match(
  sidebar,
  /\{ label: "NetSuite PO history", href: "\/scm\/netsuite-po", icon: "PO", scmWriteOnly: true, authorities: \["admin", "scm", "scm_staff"\] \}/,
  "The SCM sidebar must expose the role-gated NetSuite PO history page."
);
assert.match(
  sidebar,
  /\{ label: "Schedule Formatting", href: "\/scm\/schedule-formatting", icon: "CF", authorities: \["admin", "scm", "scm_staff"\] \}/,
  "The SCM sidebar must expose PO/TO Schedule formatting."
);
assert.match(
  menu,
  /<button class="dispatch-menu-card primary-card" onclick="location\.href='\/scm\/netsuite-po'" type="button">[\s\S]*?<strong>NetSuite PO history<\/strong>/,
  "The visible SCM menu card grid must expose the NetSuite PO history page."
);
assert.ok(
  menu.includes(menuRoles),
  "The SCM menu must admit the complete NetSuite PO read/review role set."
);
assert.ok(
  page.includes(purchaseOrderRoles),
  "The NetSuite PO history page must remain limited to purchase-order writers."
);
assert.ok(
  server.includes('app.get("/scm/netsuite-po", (req, res) => {')
    && server.includes('res.sendFile(path.join(publicDir, "scm-netsuite-po.html"));'),
  "The NetSuite PO menu target must have a server route."
);
assert.ok(
  menu.includes("Schedule Formatting")
    && menu.includes("location.href='/scm/schedule-formatting'"),
  "The SCM menu must expose the company PO/TO Schedule formatting page."
);
assert.ok(
  server.includes('app.get("/scm/schedule-formatting", (req, res) => {')
    && server.includes('res.sendFile(path.join(publicDir, "scm-schedule-formatting.html"));'),
  "The Schedule Formatting menu target must have a server route."
);

console.log(JSON.stringify({
  ok: true,
  sidebarEntry: true,
  scmMenuCard: true,
  authorizedRolesAligned: true,
  routePresent: true,
  scheduleFormatting: true
}));
