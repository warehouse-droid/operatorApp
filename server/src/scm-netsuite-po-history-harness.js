import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("migrations/099_scm_netsuite_po_history.sql");
const repository = read("src/scm-netsuite-po-history-repository.js");
const service = read("src/scm-netsuite-po-history-service.js");
const vendorCodes = read("src/smart-scm-vendor-code-service.js");
const netsuite = read("src/netsuite.js");
const worker = read("netsuite-order-webhook-scheduled.js");
const restlet = read("netsuite-smart-scm-picking-ticket-restlet.js");
const ui = read("public/scm-netsuite-po.js");

assert.match(migration, /CREATE TABLE IF NOT EXISTS scm_netsuite_po_history/);
assert.match(migration, /creation_snapshot jsonb NOT NULL/);
assert.match(migration, /archived_at timestamptz/);
assert.match(migration, /remote_last_modified_at/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS scm_netsuite_vendor_item_codes/);
assert.match(migration, /source IN \('item_vendor', 'single_vendor_fallback'\)/);

for (const name of ["listScmNetSuitePoHistory", "recordScmNetSuitePoCreation", "setScmNetSuitePoHistoryArchived", "persistScmNetSuitePoSnapshot"]) {
  assert.match(repository, new RegExp(`export async function ${name}\\b`));
}
for (const name of ["registerScmNetSuitePoHistoryCreation", "refreshScmNetSuitePoHistory", "updateScmNetSuitePoHistory", "getScmNetSuitePoHistoryPdf", "processScmNetSuitePoHistoryWebhook"]) {
  assert.match(service, new RegExp(`export async function ${name}\\b`));
}
assert.match(service, /received, closed, cancelled, or inactive and is read-only/);
assert.match(service, /expectedLastModifiedAt/);
assert.match(service, /source: "application"/);

assert.match(vendorCodes, /export async function resolveSmartScmVendorItemCodes/);
assert.match(netsuite, /FROM itemvendor iv/);
assert.match(netsuite, /i\.vendorname AS vendor_code/);
assert.match(worker, /lastModifiedDate/);
assert.match(worker, /vendorReference/);
assert.match(worker, /closed:/);
assert.match(restlet, /render\.transaction/);
assert.match(restlet, /MBBS_PO_VERSION_CONFLICT/);
assert.match(restlet, /quantityreceived/);

assert.match(ui, /Archived application-created POs/);
assert.match(ui, /setInterval\(\(\) => \{[\s\S]*60000\)/);
assert.match(ui, /new EventSource\("\/api\/events\?client=scm-netsuite-po-history"\)/);
assert.match(ui, /Preview PDF/);
assert.match(ui, /Return to Vendor Replies/);
assert.match(ui, /expectedLastModifiedAt/);

const loadSource = ui.slice(
  ui.indexOf("async function load("),
  ui.indexOf("function changesForCard(")
);
const quietGuard = "quiet && !force && quietRefreshBlocked()";
const loadAwaitIndex = loadSource.indexOf("await api(");
const postAwaitQuietGuardIndex = loadSource.indexOf(quietGuard, loadAwaitIndex + 1);
const recordsCommitIndex = loadSource.indexOf("poState.records =", loadAwaitIndex + 1);
const postAwaitRenderIndex = loadSource.indexOf("render()", loadAwaitIndex + 1);
assert.ok(loadAwaitIndex >= 0, "PO history loading must await the server response.");
assert.ok(
  postAwaitQuietGuardIndex > loadAwaitIndex,
  "A quiet non-forced PO history refresh must recheck whether editing began while its request was in flight."
);
assert.ok(
  recordsCommitIndex > postAwaitQuietGuardIndex,
  "A newly blocked quiet refresh must be rejected before it replaces the current PO records."
);
assert.ok(
  postAwaitRenderIndex > postAwaitQuietGuardIndex,
  "A newly blocked quiet refresh must be rejected before any post-request redraw can interrupt the editor."
);
assert.match(
  loadSource,
  /let discardQuietResponse = false;[\s\S]*?quiet && !force && quietRefreshBlocked\(\)[\s\S]*?discardQuietResponse = true;[\s\S]*?finally\s*\{[\s\S]*?!discardQuietResponse[\s\S]*?render\(\)/,
  "Returning from the quiet-response guard must also suppress the finally-block redraw."
);

console.log("NetSuite PO history persistence, guarded editing, PDF, webhook, vendor-code, and live-refresh contracts passed.");
