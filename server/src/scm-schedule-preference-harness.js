import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beginRollbackContext, closeDb } from "./db.js";
import { createOperator } from "./auth-repository.js";
import {
  getScmSchedulePreference,
  normalizeScmSchedulePreference,
  updateScmSchedulePreference
} from "./scm-schedule-preference-repository.js";

const [client, server, html, migration, specialOrderMigration] = await Promise.all([
  readFile(new URL("../public/scm-schedule.js", import.meta.url), "utf8"),
  readFile(new URL("./server.js", import.meta.url), "utf8"),
  readFile(new URL("../public/scm-schedule.html", import.meta.url), "utf8"),
  readFile(new URL("../migrations/079_scm_schedule_user_preferences.sql", import.meta.url), "utf8"),
  readFile(new URL("../migrations/084_scm_schedule_special_order_preference.sql", import.meta.url), "utf8")
]);

for (const expected of [
  "SCM_SCHEDULE_FILTER_PREF_KEY",
  "scmScheduleFilterPreferenceKey",
  "loadLocalScmScheduleFilterPreference",
  "saveLocalScmScheduleFilterPreference",
  "loadScmScheduleFilterPreference",
  "saveScmScheduleFilterPreference",
  "scmScheduleSurface",
  "scmScheduleHasPrivatePreferenceAccount",
  "persisted !== false"
]) {
  assert(client.includes(expected), `Schedule preference client is missing ${expected}.`);
}
assert(
  client.includes('(key === "kind" || key === "method") && !scmScheduleCanShowScmWorkingControls()'),
  "Hidden SCM-only Type and Method preferences can still constrain another schedule view."
);
const applyHandler = client.match(/async function applyScmScheduleFilters\(\) \{([\s\S]*?)\n\}/)?.[1] || "";
assert(applyHandler.includes("saveScmScheduleFilterPreference()"), "Apply does not persist the signed-in user's filters.");
assert(!client.match(/queueScmScheduleSearch[\s\S]{0,500}saveScmScheduleFilterPreference\(\)/),
  "Typing in global search must not persist the structured filters.");
assert(client.includes("if (!scmScheduleHasPrivatePreferenceAccount()) return"),
  "Public Sales is not kept on local-only schedule preferences.");

for (const expected of [
  'app.get("/api/scm/schedule-preferences/:surface"',
  'app.put("/api/scm/schedule-preferences/:surface"',
  'app.get("/api/sales/schedule-preferences"',
  'app.put("/api/sales/schedule-preferences"',
  "req.operator?.id",
  "req.publicSalesAccess",
  "getScmSchedulePreference",
  "updateScmSchedulePreference"
]) {
  assert(server.includes(expected), `Schedule preference routes are missing ${expected}.`);
}
assert(html.includes("/scm-schedule.js?v=20260813-status-concurrency-v2"),
  "Schedule preference client cache bust is missing.");
assert(migration.includes("PRIMARY KEY (operator_id, surface)"), "Schedule preferences are not isolated by user and surface.");
assert(migration.includes("REFERENCES operators(id) ON DELETE CASCADE"), "Deleted staff accounts retain schedule preferences.");
assert(specialOrderMigration.includes("'Sp.O'"), "Special Order is not allowed by the persisted Type filter constraint.");

assert.deepEqual(
  normalizeScmSchedulePreference({
    kind: "sp.o",
    method: "MBT",
    status: []
  }, { surface: "scm" }),
  {
    surface: "scm",
    kind: "Sp.O",
    method: "MBT",
    status: []
  }
);
assert.deepEqual(
  normalizeScmSchedulePreference({
    kind: "po",
    method: "Vendor",
    status: ["Queued", "Priority", "Queued"]
  }, { surface: "scm" }),
  {
    surface: "scm",
    kind: "PO",
    method: "Vendor",
    status: ["Queued", "Priority"]
  }
);
assert.deepEqual(
  normalizeScmSchedulePreference({
    kind: "TO",
    method: "MBT",
    statuses: ["Completed"]
  }, { surface: "dispatch" }),
  {
    surface: "dispatch",
    kind: "",
    method: "",
    status: ["Completed"]
  },
  "Dispatch must not persist hidden SCM-only Type or Method filters."
);
assert.throws(
  () => normalizeScmSchedulePreference({ status: ["Not a status"] }, { surface: "scm" }),
  /Invalid PO\/TO Schedule status/
);
assert.throws(
  () => normalizeScmSchedulePreference({ method: "Courier" }, { surface: "scm" }),
  /Invalid PO\/TO Schedule Method/
);
assert.throws(
  () => normalizeScmSchedulePreference({}, { surface: "other" }),
  /surface must be scm, dispatch, or sales/
);

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    const suffix = Date.now().toString(36);
    const first = await createOperator({
      username: `schedule-pref-one-${suffix}`,
      displayName: "Schedule Preference One",
      password: "schedule-preference-test",
      role: "scm"
    });
    const second = await createOperator({
      username: `schedule-pref-two-${suffix}`,
      displayName: "Schedule Preference Two",
      password: "schedule-preference-test",
      role: "dispatcher"
    });

    const initial = await getScmSchedulePreference(first.id, "scm");
    assert.equal(initial.persisted, false);
    assert.deepEqual(initial.status, []);

    await updateScmSchedulePreference(first.id, "scm", {
      kind: "Sp.O",
      method: "MBT",
      status: ["Priority"]
    });
    const specialOrderSaved = await getScmSchedulePreference(first.id, "scm");
    assert.equal(specialOrderSaved.kind, "Sp.O");
    assert.equal(specialOrderSaved.method, "MBT");
    assert.deepEqual(specialOrderSaved.status, ["Priority"]);

    await updateScmSchedulePreference(first.id, "scm", {
      kind: "TO",
      method: "Customer Pickup",
      status: ["Queued", "Hold"]
    });
    const saved = await getScmSchedulePreference(first.id, "scm");
    assert.equal(saved.persisted, true);
    assert.equal(saved.kind, "TO");
    assert.equal(saved.method, "Customer Pickup");
    assert.deepEqual(saved.status, ["Queued", "Hold"]);

    const otherSurface = await getScmSchedulePreference(first.id, "dispatch");
    assert.equal(otherSurface.persisted, false, "SCM preference leaked into the Dispatch surface.");
    const otherUser = await getScmSchedulePreference(second.id, "scm");
    assert.equal(otherUser.persisted, false, "One operator received another operator's filters.");

    const dispatchSaved = await updateScmSchedulePreference(second.id, "dispatch", {
      kind: "PO",
      method: "Vendor",
      status: ["Completed"]
    });
    assert.equal(dispatchSaved.kind, "");
    assert.equal(dispatchSaved.method, "");
    assert.deepEqual(dispatchSaved.status, ["Completed"]);
  });

  console.log("Per-user PO/TO Schedule filter preference harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
