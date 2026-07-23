import assert from "node:assert/strict";
import fs from "node:fs";

const publicUrl = new URL("../public/", import.meta.url);
const readPublic = (name) => fs.readFileSync(new URL(name, publicUrl), "utf8");
const sidebar = readPublic("app-sidebar.js");
const menu = readPublic("scm-menu.html");
const page = readPublic("scm-netsuite-po.js");
const server = fs.readFileSync(new URL("server.js", import.meta.url), "utf8");

const allowedRoles = 'roles: ["admin", "scm", "scm_staff", "dispatcher", "yard_manager"]';

assert.match(
  sidebar,
  /\{ label: "NetSuite PO", href: "\/scm\/netsuite-po", icon: "PO" \}/,
  "The SCM sidebar must expose the NetSuite PO review page."
);
assert.match(
  menu,
  /<button class="dispatch-menu-card primary-card" onclick="location\.href='\/scm\/netsuite-po'" type="button">[\s\S]*?<strong>NetSuite PO<\/strong>/,
  "The visible SCM menu card grid must expose the NetSuite PO review page."
);
assert.ok(
  menu.includes(allowedRoles),
  "The SCM menu must admit the complete NetSuite PO read/review role set."
);
assert.ok(
  page.includes(allowedRoles),
  "The NetSuite PO page role set must stay aligned with the SCM menu."
);
assert.ok(
  server.includes('app.get("/scm/netsuite-po", (req, res) => {')
    && server.includes('res.sendFile(path.join(publicDir, "scm-netsuite-po.html"));'),
  "The NetSuite PO menu target must have a server route."
);

console.log(JSON.stringify({
  ok: true,
  sidebarEntry: true,
  scmMenuCard: true,
  authorizedRolesAligned: true,
  routePresent: true
}));
