import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const client = fs.readFileSync(new URL("../../../public/scm-schedule.js", import.meta.url), "utf8");

function scheduleSaveHelpersContext(fields = []) {
  const start = client.indexOf("function scheduleRowId");
  const end = client.indexOf("function collectScmScheduleReconciliationAllocations", start);
  assert.ok(start >= 0 && end > start, "The schedule save helper block must remain inspectable.");
  const context = vm.createContext({
    CSS: { escape: (value) => String(value) },
    scmScheduleRows: [{
      orderKind: "PO",
      orderRef: "STATUS-SPLIT",
      updatedAt: "2026-08-13T20:00:00.456Z",
      isScmSplit: true,
      scmSplitRevision: 7
    }],
    scmScheduleApp: {
      querySelectorAll: () => fields
    }
  });
  vm.runInContext(client.slice(start, end), context);
  return context;
}

test("PO/TO Schedule collects the live status with the loaded row revision", () => {
  const fields = [{
    dataset: { field: "status" },
    type: "select-one",
    value: "Hold",
    disabled: false
  }];
  const context = scheduleSaveHelpersContext(fields);
  const patch = vm.runInContext('collectRowPatch("PO::STATUS-SPLIT")', context);
  assert.equal(patch.orderKind, "PO");
  assert.equal(patch.status, "Hold");
  assert.equal(patch.expectedUpdatedAt, "2026-08-13T20:00:00.456Z",
    "an older browser row must not overwrite a newer status");
  assert.equal(patch.expectedSplitRevision, 7,
    "the schedule mutation must protect the split PO revision as well as the schedule timestamp");
});

test("PO/TO Schedule renders row-owned route options and locks operational split rows", () => {
  assert.match(client, /const rowPickupOptions = Array\.isArray\(row\.pickupOptions\)/);
  assert.match(client, /const rowDropoffOptions = Array\.isArray\(row\.dropoffOptions\)/);
  assert.match(client, /options: rowPickupOptions/,
    "a filtered result set must not become the pickup option source");
  assert.match(client, /options: rowDropoffOptions/,
    "PO and TO drop-offs must use the server-owned route domain");
  assert.match(client, /splitOperationalLock/);
  assert.match(client, />Unplan first</);
});

test("PO/TO Schedule submits an explicit order-wide PO destination override", () => {
  const fields = [{
    dataset: { field: "dropoffPoint" },
    type: "select-one",
    value: "12441",
    disabled: false
  }];
  const context = scheduleSaveHelpersContext(fields);
  const patch = vm.runInContext('collectRowPatch("PO::STATUS-SPLIT")', context);
  assert.equal(patch.dropoffPoint, "12441");
  assert.match(client, /function poDestinationOverrideSelectHtml/u);
  assert.match(client, /const destinationSource = isSplit \? "Split confirmation" : "NetSuite"/u,
    "the retained route must disclose whether the split confirmation or NetSuite owns it");
  assert.match(client, /\$\{scmScheduleEscape\(effectiveDestination\)\} \(\$\{destinationSource\}\)/u);
  assert.match(client, /Overrides all PO lines/u);
});

test("PO/TO Schedule freezes and restores row editors around a pending save", () => {
  const fields = [
    { disabled: false },
    { disabled: false },
    { disabled: false }
  ];
  const context = scheduleSaveHelpersContext(fields);
  vm.runInContext('setScmScheduleRowControlsDisabled("PO::STATUS-SPLIT", true)', context);
  assert.deepEqual(fields.map((field) => field.disabled), [true, true, true]);
  vm.runInContext('setScmScheduleRowControlsDisabled("PO::STATUS-SPLIT", false)', context);
  assert.deepEqual(fields.map((field) => field.disabled), [false, false, false]);
});

test("the save handler brackets its request with row-editor locking", () => {
  const saveHandler = client.match(/if \(action === "save-row"\) \{([\s\S]*?)\n  \}\n\}\);/)?.[1] || "";
  assert.ok(saveHandler, "The PO/TO Schedule save handler must remain inspectable.");
  assert.match(saveHandler, /setScmScheduleRowControlsDisabled\(rowId, true\)/);
  assert.match(saveHandler, /finally \{[\s\S]*?setScmScheduleRowControlsDisabled\(rowId, false\)/,
    "successes and failures must both restore the row editors");
});
