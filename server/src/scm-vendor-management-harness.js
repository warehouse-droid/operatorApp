import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DISPATCH_VENDOR_WEEK_DAYS,
  normalizeDispatchVendorScheduleDays
} from "./dispatch-enrichment.js";

const publicUrl = new URL("../public/", import.meta.url);
const readPublic = (name) => fs.readFileSync(new URL(name, publicUrl), "utf8");
const server = fs.readFileSync(new URL("server.js", import.meta.url), "utf8");
const repository = fs.readFileSync(new URL("dispatch-enrichment.js", import.meta.url), "utf8");
const sidebar = readPublic("app-sidebar.js");
const menu = readPublic("scm-menu.html");
const page = readPublic("scm-vendors.js");
const html = readPublic("scm-vendors.html");

const normalized = normalizeDispatchVendorScheduleDays([
  { dayLabel: "Monday", active: true, windowStart: "07:00", windowEnd: "16:30", instructions: "Arrive by 16:00" },
  { dayLabel: "Saturday", active: false, windowStart: "", windowEnd: "" }
]);
assert.equal(normalized.length, 7);
assert.deepEqual(normalized.map((day) => day.dayLabel), [...DISPATCH_VENDOR_WEEK_DAYS]);
assert.equal(normalized[0].windowStart, "07:00");
assert.equal(normalized[1].active, false, "Missing weekdays must default to closed.");
assert.throws(
  () => normalizeDispatchVendorScheduleDays([{ dayLabel: "Monday", active: true, windowStart: "7am", windowEnd: "16:00" }]),
  /24-hour HH:MM/
);
assert.throws(
  () => normalizeDispatchVendorScheduleDays([{ dayLabel: "Monday", active: true, windowStart: "17:00", windowEnd: "08:00" }]),
  /later than opening/
);
assert.throws(
  () => normalizeDispatchVendorScheduleDays([{ dayLabel: "Holiday", active: true }]),
  /not valid/
);

assert.match(sidebar, /\{ label: "Local Vendors", href: "\/scm\/vendors", icon: "LV" \}/);
assert.match(menu, /location\.href='\/scm\/vendors'[\s\S]*?<strong>Local Vendors<\/strong>/);
assert.ok(html.includes("/scm-vendors.js") && html.includes("/scm-vendors.css"));
assert.ok(page.includes('roles: ["admin", "scm", "scm_staff", "dispatcher", "yard_manager"]'));
assert.ok(page.includes('return ["admin", "scm", "scm_staff"].some'));
assert.ok(page.includes('data-vendor-form="create-vendor"'));
assert.ok(page.includes('data-vendor-form="rename-vendor"'));
assert.ok(page.includes('data-vendor-form="save-yard"'));
assert.ok(page.includes('data-vendor-action="copy-weekdays"'));

assert.ok(server.includes('app.get("/api/scm/local-vendors"'));
assert.ok(server.includes('app.post("/api/scm/local-vendors", requireSmartScmWriteAccess'));
assert.ok(server.includes('app.put("/api/scm/local-vendors/:id", requireSmartScmWriteAccess'));
assert.ok(server.includes('app.post("/api/scm/local-vendors/:id/yards", requireSmartScmWriteAccess'));
assert.ok(server.includes('app.put("/api/scm/local-vendors/:id/yards/:yardRowId", requireSmartScmWriteAccess'));
assert.ok(server.includes('app.get("/scm/vendors"'));
assert.ok(repository.includes("const referencedIds = currentIds.length"));
assert.ok(repository.includes("aliasValues.push(previousYard)"));
assert.ok(repository.includes("UPDATE scm_smart_item_policies"));
assert.ok(repository.includes("UPDATE purchase_orders po"));
assert.ok(repository.includes("UPDATE scm_transport_schedule schedule"));
assert.ok(repository.includes("UPDATE scm_vrma_orders"));

console.log(JSON.stringify({
  ok: true,
  weekdayValidation: true,
  scmNavigation: true,
  scmWriteProtection: true,
  vendorAndYardCrud: true,
  renamePropagation: true
}));
