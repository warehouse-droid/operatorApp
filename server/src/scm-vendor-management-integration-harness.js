import assert from "node:assert/strict";
import { closeDb, query } from "./db.js";
import {
  createDispatchLocalVendor,
  listDispatchVendorYards,
  saveDispatchVendorYardSchedule,
  updateDispatchLocalVendor
} from "./dispatch-enrichment.js";

const suffix = Date.now().toString(36);
const vendorName = `SCM Vendor Test ${suffix}`;
const renamedVendor = `${vendorName} Renamed`;
const yardName = `SCM Yard ${suffix}`;
const renamedYard = `${yardName} Renamed`;

const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((dayLabel) => ({
  dayLabel,
  active: true,
  windowStart: "07:00",
  windowEnd: "16:30",
  instructions: dayLabel === "Friday" ? "Arrive by 16:00" : ""
}));

async function cleanup() {
  await query(
    "DELETE FROM dispatch_vendor_yards WHERE LOWER(vendor) IN (LOWER($1), LOWER($2))",
    [vendorName, renamedVendor]
  );
  await query(
    "DELETE FROM dispatch_local_vendors WHERE LOWER(name) IN (LOWER($1), LOWER($2))",
    [vendorName, renamedVendor]
  );
}

try {
  const vendor = await createDispatchLocalVendor({ name: vendorName, updatedBy: "scm-vendor-harness" });
  assert(vendor?.id);

  const created = await saveDispatchVendorYardSchedule({
    localVendorId: vendor.id,
    yard: yardName,
    address: "100 Test Road, Toronto, ON",
    aliases: ["Test pickup"],
    days: weekdays,
    updatedBy: "scm-vendor-harness"
  });
  assert.equal(created.rows.length, 7);
  assert.equal(created.rows.filter((row) => row.active).length, 5);
  const originalIds = new Set(created.rows.map((row) => String(row.id)));

  const renamed = await saveDispatchVendorYardSchedule({
    localVendorId: vendor.id,
    yardRowId: created.rows[0].id,
    yard: renamedYard,
    address: "200 Test Road, Toronto, ON",
    aliases: ["Updated pickup"],
    days: weekdays.map((day) => ({ ...day, windowStart: "08:00", windowEnd: "17:00" })),
    updatedBy: "scm-vendor-harness"
  });
  assert.equal(renamed.previousYard, yardName);
  assert(renamed.rows.every((row) => row.yard === renamedYard));
  assert(renamed.rows.every((row) => row.aliases.includes(yardName)), "A renamed yard must retain its old name as an alias.");
  assert(renamed.rows.some((row) => originalIds.has(String(row.id))), "Yard schedule row IDs were not preserved.");

  const localVendor = await updateDispatchLocalVendor(vendor.id, {
    name: renamedVendor,
    active: true,
    updatedBy: "scm-vendor-harness"
  });
  assert.equal(localVendor.name, renamedVendor);
  const rows = (await listDispatchVendorYards()).filter((row) => row.yard === renamedYard);
  assert.equal(rows.length, 7);
  assert(rows.every((row) => row.vendor === renamedVendor), "Vendor rename did not cascade to its yard schedule.");

  console.log(JSON.stringify({
    ok: true,
    atomicWeekSchedule: true,
    yardRenamePreservesIds: true,
    oldNameAliasPreserved: true,
    vendorRenameCascades: true
  }));
} finally {
  await cleanup();
  await closeDb();
}
