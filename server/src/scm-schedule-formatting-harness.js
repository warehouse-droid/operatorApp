import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beginRollbackContext, closeDb } from "./db.js";
import {
  defaultScmScheduleFormattingRules,
  getScmScheduleFormatting,
  normalizeScmScheduleFormattingRules,
  SCM_SCHEDULE_FORMATTING_TYPES,
  updateScmScheduleFormatting
} from "./scm-schedule-formatting-repository.js";

const [client, setupClient, css, setupCss, menu, server, migration, html] = await Promise.all([
  "../public/scm-schedule.js",
  "../public/scm-schedule-formatting.js",
  "../public/dispatch.css",
  "../public/scm-schedule-formatting.css",
  "../public/scm-menu.html",
  "./server.js",
  "../migrations/083_scm_schedule_formatting.sql",
  "../public/scm-schedule-formatting.html"
].map((file) => readFile(new URL(file, import.meta.url), "utf8")));

const defaults = defaultScmScheduleFormattingRules();
assert.equal(defaults.status.Planned.rowEnabled, true);
assert.equal(defaults.status.Planned.rowBackground, "#fff4b8");
assert.equal(defaults.status.Completed.rowColor, "#54636c");
assert.equal(defaults.status["Reconcile Review"].rowBackground, "#fff8e7");
assert.equal(defaults.type.PO.cellEnabled, false);
assert.deepEqual([...SCM_SCHEDULE_FORMATTING_TYPES], ["PO", "TO", "VRMA", "Sp.O"]);
assert.equal(defaults.type["Sp.O"].cellEnabled, false);

const normalized = normalizeScmScheduleFormattingRules({
  rules: {
    status: {
      Urgent: {
        cellEnabled: true,
        cellBackground: "#991B1B",
        cellColor: "#FFFFFF",
        rowEnabled: true,
        rowBackground: "#8b1e1e",
        rowColor: "#ffffff"
      }
    },
    type: {
      TO: {
        cellEnabled: true,
        cellBackground: "#1E3A5F",
        cellColor: "#FFFFFF"
      },
      "Sp.O": {
        cellEnabled: true,
        cellBackground: "#6B21A8",
        cellColor: "#FFFFFF"
      }
    },
    dropoffPoint: {
      "3445": {
        cellEnabled: true,
        cellBackground: "#FACC15",
        cellColor: "#422006"
      }
    }
  }
});
assert.equal(normalized.status.Urgent.cellBackground, "#991b1b");
assert.equal(normalized.type.TO.cellColor, "#ffffff");
assert.equal(normalized.type["Sp.O"].cellBackground, "#6b21a8");
assert.equal(normalized.dropoffPoint["3445"].cellEnabled, true);
assert.throws(
  () => normalizeScmScheduleFormattingRules({
    status: { Queued: { cellEnabled: true, cellBackground: "red" } }
  }),
  /six-digit hex color/
);
assert.throws(
  () => normalizeScmScheduleFormattingRules({ status: { Unknown: {} } }),
  /Unknown PO\/TO Schedule status/
);

for (const expected of [
  "loadScmScheduleFormattingOnce",
  "scmScheduleCellFormatting",
  "scmScheduleRowFormatting",
  'row.isSpecialOrder ? "Sp.O" : row.orderKind',
  'scmScheduleCellFormatting("dropoffPoint", row.dropoffPoint)',
  'scmScheduleCellFormatting("status", row.status)',
  "scmScheduleTableRowHtml"
]) {
  assert(client.includes(expected), `Schedule formatting renderer is missing ${expected}.`);
}
for (const expected of [
  "Suggested color combinations",
  "Good contrast",
  "Low contrast",
  'scope === "row" ? "Whole row" : "Cell"',
  "schedule-format-enabled",
  "schedule-formatting-tabs",
  'data-action="show-section"',
  "Type &amp; Sp.O",
  'data-form="add-dropoff"',
  "/api/scm/schedule-formatting"
]) {
  assert(setupClient.includes(expected), `Schedule formatting setup is missing ${expected}.`);
}
for (const expected of [
  ".schedule-formatting-page",
  "overflow: auto",
  ".schedule-formatting-tabs"
]) {
  assert(setupCss.includes(expected), `Schedule formatting editor CSS is missing ${expected}.`);
}
for (const expected of [
  ".scm-sheet-row.scm-custom-row-format .scm-sheet-cell",
  ".scm-sheet-cell.scm-custom-cell-format",
  ".scm-sheet-row.reconcile-review .scm-sheet-cell"
]) {
  assert(css.includes(expected), `Schedule formatting CSS is missing ${expected}.`);
}
assert(menu.includes("Schedule Formatting")
  && menu.includes("location.href='/scm/schedule-formatting'"),
"SCM Menu does not expose Schedule Formatting.");
for (const expected of [
  'app.get("/api/scm/schedule-formatting"',
  'app.get("/api/dispatch/schedule-formatting"',
  'app.get("/api/sales/schedule-formatting"',
  'app.put("/api/scm/schedule-formatting", requireSmartScmWriteAccess',
  'app.get("/scm/schedule-formatting"'
]) {
  assert(server.includes(expected), `Schedule formatting API/navigation is missing ${expected}.`);
}
assert(migration.includes("scm_schedule_formatting_settings"));
assert(migration.includes("CHECK (jsonb_typeof(rules) = 'object')"));
assert(html.includes("/scm-schedule-formatting.js?v=20260730-schedule-formatting-v2"));

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    const initial = await getScmScheduleFormatting();
    assert.equal(initial.rules.status.Planned.rowBackground, "#fff4b8");
    assert(initial.options.dropoffPoints.includes("3445"));
    const saved = await updateScmScheduleFormatting({
      rules: {
        ...initial.rules,
        status: {
          ...initial.rules.status,
          Urgent: {
            ...initial.rules.status.Urgent,
            cellEnabled: true,
            cellBackground: "#991b1b",
            cellColor: "#ffffff"
          }
        }
      }
    }, "formatting-harness");
    assert.equal(saved.rules.status.Urgent.cellEnabled, true);
    assert.equal(saved.rules.status.Urgent.cellBackground, "#991b1b");
    assert.equal(saved.updatedBy, "formatting-harness");
    const reread = await getScmScheduleFormatting();
    assert.equal(reread.rules.status.Urgent.cellBackground, "#991b1b");
  });
  console.log("Company-wide PO/TO Schedule formatting harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
