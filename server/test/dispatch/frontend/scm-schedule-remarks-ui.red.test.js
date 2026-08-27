import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const scheduleClient = fs.readFileSync(new URL("../../../public/scm-schedule.js", import.meta.url), "utf8");
const schedulePage = fs.readFileSync(new URL("../../../public/scm-schedule.html", import.meta.url), "utf8");
const splitClient = fs.readFileSync(new URL("../../../public/dispatch-scm.js", import.meta.url), "utf8");
const splitPage = fs.readFileSync(new URL("../../../public/dispatch-scm.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");

test("Remark is immediately after Content in PO / TO Schedule", () => {
  const contentIndex = scheduleClient.indexOf('{ key: "content", label: "Content"');
  const remarkIndex = scheduleClient.indexOf('{ key: "remark", label: "Remark"');
  const orderIndex = scheduleClient.indexOf('{ key: "order", label: "Order Number"');
  assert.ok(contentIndex >= 0 && remarkIndex > contentIndex && orderIndex > remarkIndex);
  assert.match(scheduleClient, /data-field="remarkOverride"/);
  assert.match(scheduleClient, /row\.netSuiteMemo/);
});

test("PO Split edits the shared schedule remark and supports locked split remark-only save", () => {
  assert.match(splitClient, /data-scm-field="remarkOverride"/);
  assert.match(splitClient, /data-action="save-scm-remark"/);
  assert.match(splitClient, /\/api\/scm\/schedule\/\$\{encodeURIComponent\(order\.id\)\}\/remark/);
  assert.match(splitClient, /splitLocked[\s\S]*Save Remark/);
});

test("the server exposes an optimistic, audited remark-only endpoint", () => {
  assert.match(server, /app\.put\("\/api\/scm\/schedule\/:id\/remark"/);
  assert.match(server, /requiredScmScheduleRevision/);
  assert.match(server, /scm\.schedule\.remark\.updated/);
});

test("each changed page carries its current fresh cache key", () => {
  assert.match(schedulePage, /scm-schedule\.js\?v=20260827-schedule-remarks-v1/);
  assert.match(splitPage, /dispatch-scm\.js\?v=20260827-split-create-metadata-v1/);
});
