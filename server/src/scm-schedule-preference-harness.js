import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beginRollbackContext, closeDb, query } from "./db.js";
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
  client.includes('key === "method" && !scmScheduleCanShowMethodFilter()'),
  "Hidden Method preferences can still constrain the Dispatch view."
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
assert(html.includes("/scm-schedule.js?v=20261001-schedule-multi-sort-v1"),
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
    kinds: ["Sp.O"],
    methods: ["MBT"],
    dropoffPoints: [],
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
    kinds: ["PO"],
    methods: ["Vendor"],
    dropoffPoints: [],
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
    kind: "TO",
    method: "",
    kinds: ["TO"],
    methods: ["MBT"],
    dropoffPoints: [],
    status: ["Completed"]
  },
  "Dispatch keeps the legacy Method field empty while retaining Method selections for its Completed view."
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
assert.deepEqual(normalizeScmSchedulePreference({
  kinds: ["TO", "sp.o", "TO"], methods: ["MBT", "Vendor", "MBT"], dropoffPoints: ["3445", "150", "3445"]
}, { surface: "scm" }), {
  surface: "scm", kind: "TO", method: "MBT", kinds: ["TO", "Sp.O"], methods: ["MBT", "Vendor"],
  dropoffPoints: ["3445", "150"], status: []
});
assert.throws(() => normalizeScmSchedulePreference({ kinds: ["PO", "Invalid"] }, { surface: "scm" }), /Invalid PO\/TO Schedule Type/);
assert.throws(() => normalizeScmSchedulePreference({ dropoffPoints: ["3445", "Unknown"] }, { surface: "scm" }), /Invalid PO\/TO Schedule Drop-off Point/);

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

    const multi = { kinds: ["Sp.O", "TO"], methods: ["MBT", "Vendor"], dropoffPoints: ["3445", "150"], status: ["Queued"] };
    await updateScmSchedulePreference(first.id, "scm", multi);
    const reloadedMulti = await getScmSchedulePreference(first.id, "scm");
    for (const field of Object.keys(multi)) assert.deepEqual(reloadedMulti[field], multi[field]);
    await updateScmSchedulePreference(first.id, "scm", { kinds: [], methods: [], dropoffPoints: [], status: [] });
    const cleared = await getScmSchedulePreference(first.id, "scm");
    assert.deepEqual(cleared.kinds, []);
    assert.deepEqual(cleared.methods, []);
    assert.deepEqual(cleared.dropoffPoints, []);
    assert.equal(cleared.kind, "");
    assert.equal(cleared.method, "");

    // Rows written by an older client keep their single selections during the upgrade.
    await query(`INSERT INTO scm_schedule_user_preferences (operator_id, surface, order_kind, method)
      VALUES ($1, 'sales', 'TO', 'Vendor')`, [first.id]);
    const multiMigration = await readFile(new URL("../migrations/248_scm_schedule_multi_filters.sql", import.meta.url), "utf8");
    await query(multiMigration);
    await query(multiMigration);
    const backfilled = await query("SELECT order_kinds, methods FROM scm_schedule_user_preferences WHERE operator_id = $1 AND surface = 'sales'", [first.id]);
    assert.deepEqual(backfilled.rows[0].order_kinds, ["TO"]);
    assert.deepEqual(backfilled.rows[0].methods, ["Vendor"]);
    const salesSaved = await updateScmSchedulePreference(first.id, "sales", multi);
    assert.deepEqual(salesSaved.kinds, multi.kinds);
    assert.deepEqual(salesSaved.methods, multi.methods);

    const otherSurface = await getScmSchedulePreference(first.id, "dispatch");
    assert.equal(otherSurface.persisted, false, "SCM preference leaked into the Dispatch surface.");
    const otherUser = await getScmSchedulePreference(second.id, "scm");
    assert.equal(otherUser.persisted, false, "One operator received another operator's filters.");

    const dispatchSaved = await updateScmSchedulePreference(second.id, "dispatch", {
      kind: "PO",
      method: "Vendor",
      status: ["Completed"]
    });
    assert.equal(dispatchSaved.kind, "PO");
    assert.equal(dispatchSaved.method, "");
    assert.deepEqual(dispatchSaved.status, ["Completed"]);
    const dispatchMulti = await updateScmSchedulePreference(second.id, "dispatch", multi);
    assert.deepEqual(dispatchMulti.kinds, multi.kinds);
    assert.deepEqual(dispatchMulti.dropoffPoints, multi.dropoffPoints);
    assert.deepEqual(dispatchMulti.methods, multi.methods, "Method selections must remain available in the Completed view.");
  });

  console.log("Per-user PO/TO Schedule filter preference harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
