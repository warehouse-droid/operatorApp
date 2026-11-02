import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { closeDb, query } from "../../../src/db.js";
import { createDispatchLocalVendor, saveDispatchVendorYardSchedule } from "../../../src/dispatch-enrichment.js";
import { listSmartScmVendorYards } from "../../../src/smart-scm-item-repository.js";
import { loadSmartScmPlanningPolicies } from "../../../src/smart-scm-planning-repository.js";
import {
  addSmartScmProposalLine,
  createSmartScmManualLoad,
  groupSmartScmProposals,
  searchSmartScmProposalItems
} from "../../../src/smart-scm-proposal-editor.js";
import { canonicalVendorYardIds } from "../../../src/vendor-yard-identity.js";

const suffix = `${Date.now().toString(36)}-${process.pid}`;
const vendorName = `Yard Identity Vendor ${suffix}`;
const actor = "vendor-yard-identity-test";
const itemBase = 9700000000000 + (Date.now() % 1000000000);
const netsuiteVendorId = 9600000 + (Date.now() % 100000);
const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
let localVendor;
let itemSequence = 0;

function schedule(openDays = WEEK.slice(0, 5), hours = ["08:00", "17:00"]) {
  return WEEK.map((dayLabel) => ({
    dayLabel,
    active: openDays.includes(dayLabel),
    windowStart: openDays.includes(dayLabel) ? hours[0] : "",
    windowEnd: openDays.includes(dayLabel) ? hours[1] : "",
    instructions: ""
  }));
}

async function insertYardRow(yard, dayLabel, active = true, hours = ["08:00", "17:00"]) {
  const result = await query(
    `INSERT INTO dispatch_vendor_yards (vendor, yard, aliases, day_label, window_start, window_end, instructions, address, active)
     VALUES ($1, $2, '', $3, $4, $5, '', '1 Test Road, Ayr, ON', $6)
     RETURNING id`,
    [vendorName, yard, dayLabel, active ? hours[0] : "", active ? hours[1] : "", active]
  );
  return Number(result.rows[0].id);
}

// Production shape before the fix: an original "Mon-Fri" row plus one row per weekday.
async function legacyYard(yard, days = WEEK) {
  const legacyId = await insertYardRow(yard, "Mon-Fri", true, ["07:00", "17:00"]);
  const dayIds = {};
  for (const day of days) dayIds[day] = await insertYardRow(yard, day, WEEK.indexOf(day) < 5);
  return { legacyId, dayIds };
}

async function plannedItem(vendorYardId, label) {
  const itemId = itemBase + (itemSequence += 1);
  const name = `YARD-ID-${label}-${suffix}`;
  await query(
    `INSERT INTO inventory_items (item_id, item_name, display_name, item_description, stock_unit,
       to_plt, to_lyr, to_sec, to_pcs, item_weight, vendor_id, vendor)
     VALUES ($1, $2, $2, 'Vendor yard identity fixture', 'EA', 10, 5, 2, 1, 100, $3, $4)`,
    [itemId, name, netsuiteVendorId, vendorName]
  );
  await query(
    `INSERT INTO scm_smart_item_policies (item_id, item_name, item_description, vendor, vendor_code, stock_unit,
       to_plt, to_lyr, to_sec, to_pcs, lead_time_days, pallet_weight_lbs,
       inactive, discontinued, planning_enabled, vendor_yard_id, updated_by)
     VALUES ($1, $2, 'Vendor yard identity fixture', $3, $4, 'EA', 10, 5, 2, 1, 7, 1000,
       false, false, true, $5, $6)`,
    [itemId, name, vendorName, String(netsuiteVendorId), vendorYardId, actor]
  );
  await query(
    `INSERT INTO scm_smart_item_yard_policies (item_id, location_id, yard_code, eligible, capacity_pallets,
       service_quantile, minimum_safety_pallets, updated_by)
     VALUES ($1, 1, '3445', true, 25, 0.90, 1, $2)`,
    [itemId, actor]
  );
  return { itemId, name };
}

async function policyYard(itemId) {
  return Number((await query("SELECT vendor_yard_id FROM scm_smart_item_policies WHERE item_id = $1", [itemId])).rows[0].vendor_yard_id);
}

async function yardRow(id) {
  return (await query("SELECT * FROM dispatch_vendor_yards WHERE id = $1", [id])).rows[0];
}

async function newestProposalId(runId) {
  return Number((await query("SELECT MAX(id) AS id FROM scm_smart_proposals WHERE run_id = $1", [runId])).rows[0].id);
}

before(async () => {
  localVendor = await createDispatchLocalVendor({ name: vendorName, updatedBy: actor });
});

after(async () => {
  await query(
    `DELETE FROM scm_smart_proposal_lines WHERE proposal_id IN (
       SELECT id FROM scm_smart_proposals WHERE source_vendor_yard_id IN (
         SELECT id FROM dispatch_vendor_yards WHERE vendor = $1))`,
    [vendorName]
  );
  await query("DELETE FROM scm_smart_proposals WHERE source_vendor_yard_id IN (SELECT id FROM dispatch_vendor_yards WHERE vendor = $1)", [vendorName]);
  await query("DELETE FROM scm_smart_item_yard_policies WHERE item_id BETWEEN $1 AND $2", [itemBase, itemBase + 1000]);
  await query("DELETE FROM scm_smart_item_policies WHERE item_id BETWEEN $1 AND $2", [itemBase, itemBase + 1000]);
  await query("DELETE FROM inventory_items WHERE item_id BETWEEN $1 AND $2", [itemBase, itemBase + 1000]);
  await query("DELETE FROM dispatch_vendor_yards WHERE vendor = $1", [vendorName]);
  await query("DELETE FROM dispatch_local_vendors WHERE name = $1", [vendorName]);
  await closeDb();
});

test("renaming a yard keeps its original Mon-Fri row as the picker and Item Master identity", async () => {
  const oldName = `Ayr Yard ${suffix}`;
  const newName = `UNILOCK Ayr ${suffix}`;
  const { legacyId, dayIds } = await legacyYard(oldName);
  const oldItem = await plannedItem(legacyId, "OLD");
  const newItem = await plannedItem(dayIds.Monday, "NEW");

  const saved = await saveDispatchVendorYardSchedule({
    localVendorId: localVendor.id,
    yardRowId: dayIds.Friday,
    yard: newName,
    days: schedule(),
    updatedBy: actor
  });

  const legacy = await yardRow(legacyId);
  assert.equal(legacy.day_label, "Mon-Fri", "The original row must not be relabelled as a weekday.");
  assert.equal(legacy.active, true, "The original row must stay active while Monday-Friday is open.");
  assert.equal(legacy.yard, newName);
  assert.equal(`${legacy.window_start}-${legacy.window_end}`, "08:00-17:00", "The summary row mirrors the open weekday hours.");
  for (const [day, id] of Object.entries(dayIds)) {
    assert.equal((await yardRow(id)).day_label, day, `${day} kept its own row.`);
  }
  assert.equal(saved.canonicalRowId, legacyId);
  assert.equal(saved.repointedItemPolicies, 1);
  const picker = (await listSmartScmVendorYards()).find((yard) => yard.yard === newName);
  assert.equal(picker?.id, legacyId, "The vendor-yard picker must keep offering the original yard ID.");
  assert.equal(await policyYard(oldItem.itemId), legacyId);
  assert.equal(await policyYard(newItem.itemId), legacyId, "Items set up on a weekday row join the yard identity.");
});

test("a yard without weekend rows gets new weekend rows instead of reusing its Mon-Fri row", async () => {
  const yard = `UNILOCK Georgetown ${suffix}`;
  const { legacyId, dayIds } = await legacyYard(yard, WEEK.slice(0, 5));
  const item = await plannedItem(legacyId, "GEO");

  const saved = await saveDispatchVendorYardSchedule({
    localVendorId: localVendor.id,
    yardRowId: dayIds.Monday,
    yard,
    days: schedule(),
    updatedBy: actor
  });

  const legacy = await yardRow(legacyId);
  assert.equal(legacy.day_label, "Mon-Fri");
  assert.equal(legacy.active, true);
  const weekendIds = saved.rows.filter((row) => ["Saturday", "Sunday"].includes(row.dayLabel)).map((row) => Number(row.id));
  assert.equal(weekendIds.length, 2);
  assert(!weekendIds.includes(legacyId), "Saturday/Sunday must be new rows, not the original yard row.");
  assert.equal(await policyYard(item.itemId), legacyId);
});

test("closing every day a summary row covers moves its items to the yard's open row", async () => {
  const yard = `Weekend Yard ${suffix}`;
  const { legacyId, dayIds } = await legacyYard(yard);
  const item = await plannedItem(legacyId, "WKD");

  const saved = await saveDispatchVendorYardSchedule({
    localVendorId: localVendor.id,
    yardRowId: legacyId,
    yard,
    days: schedule(["Saturday"]),
    updatedBy: actor
  });

  assert.equal((await yardRow(legacyId)).active, false);
  assert.equal(saved.canonicalRowId, dayIds.Saturday);
  assert.equal(await policyYard(item.itemId), dayIds.Saturday, "Items must follow the yard to its open row.");
});

test("load editor, grouping and planner treat schedule rows of one yard as one pickup point", async () => {
  const yard = `Shared Pickup ${suffix}`;
  const legacyId = await insertYardRow(yard, "Mon-Fri");
  const mondayId = await insertYardRow(yard, "Monday");
  const otherYardId = await insertYardRow(`Other Pickup ${suffix}`, "Mon-Fri");
  const onLegacy = await plannedItem(legacyId, "LEGACY");
  const onMonday = await plannedItem(mondayId, "MONDAY");
  const onMondayToo = await plannedItem(mondayId, "MONDAY2");
  const otherYard = await plannedItem(otherYardId, "OTHER");

  assert.equal((await canonicalVendorYardIds([mondayId])).get(mondayId), legacyId);

  const runId = Number((await query(
    `INSERT INTO scm_smart_planning_runs (trigger_source, status, plan_kind, settings_snapshot)
     VALUES ('vendor-yard-identity', 'ready', 'inventory', '{"truck_capacity_lbs":78000}') RETURNING id`
  )).rows[0].id);
  await createSmartScmManualLoad(runId, { proposalType: "PO", itemId: onLegacy.itemId, destinationLocationId: 1, proposedPallets: 1 }, null);
  const loadId = await newestProposalId(runId);

  const found = await searchSmartScmProposalItems(loadId, { search: `YARD-ID-`, limit: 30 });
  const foundIds = new Set(found.map((item) => item.itemId));
  assert(foundIds.has(onMonday.itemId), "An item on another schedule row of the same yard must be offered.");
  assert(!foundIds.has(otherYard.itemId), "An item from a different yard must not be offered.");

  const added = await addSmartScmProposalLine(loadId, { itemId: onMonday.itemId, proposedPallets: 1 }, null);
  assert(added.lines.some((line) => Number(line.itemId) === onMonday.itemId));
  await assert.rejects(
    () => addSmartScmProposalLine(loadId, { itemId: otherYard.itemId, proposedPallets: 1 }, null),
    /different vendor pickup yard/
  );

  await createSmartScmManualLoad(runId, { proposalType: "PO", itemId: onMondayToo.itemId, destinationLocationId: 1, proposedPallets: 1 }, null);
  const secondLoadId = await newestProposalId(runId);
  assert.equal(Number((await query("SELECT source_vendor_yard_id FROM scm_smart_proposals WHERE id = $1", [secondLoadId])).rows[0].source_vendor_yard_id), legacyId,
    "New manual PO loads use the yard identity.");
  // A load planned before the fix still carries the weekday row id.
  await query("UPDATE scm_smart_proposals SET source_vendor_yard_id = $2 WHERE id = $1", [secondLoadId, mondayId]);
  const grouped = await groupSmartScmProposals([loadId, secondLoadId], null);
  assert(grouped.proposals.some((proposal) => proposal.lines?.some((line) => Number(line.itemId) === onMondayToo.itemId)));

  const policies = await loadSmartScmPlanningPolicies({ includeTemporarilyExcluded: true });
  const planned = policies.find((policy) => Number(policy.item_id) === onMonday.itemId && Number(policy.location_id) === 1);
  assert.equal(Number(planned.vendor_yard_id), legacyId, "The planner groups the item under the yard identity.");
  assert.equal(await policyYard(onMonday.itemId), mondayId, "Planning must not rewrite Item Master.");
});
