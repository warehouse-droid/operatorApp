import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const schedule = await readFile(
  new URL("../../../public/scm-schedule.js", import.meta.url),
  "utf8"
);

test("synthetic PO groups are identified independently of member rows", () => {
  assert.match(schedule, /function scmScheduleIsSyntheticPoGroup\(row = \{\}\)/);
  assert.match(schedule, /groupedRollup/);
  assert.match(schedule, /startsWith\("PGOB-"\)/);
});

test("synthetic PO groups cannot invoke real-PO source-line or resolution actions", () => {
  assert.match(
    schedule,
    /function scmSchedulePoSplitLineAdjustmentHtml[\s\S]*?scmScheduleIsSyntheticPoGroup\(row\)[\s\S]*?return "";/
  );
  assert.match(
    schedule,
    /function scmScheduleReconciliationActionsHtml[\s\S]*?scmScheduleIsSyntheticPoGroup\(row\)[\s\S]*?return "";/
  );
});

test("synthetic PO group detail renders member summaries instead of source-parent lines", () => {
  assert.match(schedule, /function scmScheduleReconciliationGroupMembersHtml/);
  assert.match(
    schedule,
    /function scmScheduleReconciliationDetailHtml[\s\S]*?scmScheduleIsSyntheticPoGroup\(row\)[\s\S]*?scmScheduleReconciliationGroupMembersHtml\(row\)/
  );
});
