import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { groupSmartScmVendorEmailRows } from "./smart-scm-vendor-workflow-repository.js";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

const migration = read("migrations/098_smart_scm_vendor_workflows.sql");
const emailRecipientMigration = read("migrations/100_smart_scm_vendor_email_recipient.sql");
const repository = read("src/smart-scm-vendor-workflow-repository.js");
const vendorCodeService = read("src/smart-scm-vendor-code-service.js");
const server = read("src/server.js");
const ui = read("public/scm-smart-vendor.js");
const css = read("public/scm-smart-vendor.css");

assert.match(migration, /CREATE TABLE IF NOT EXISTS scm_smart_vendor_workflows/i);
assert.match(migration, /workflow_key text NOT NULL UNIQUE/i);
assert.match(migration, /source_proposal_id bigint NOT NULL/i);
assert.match(migration, /email_subject text NOT NULL/i);
assert.match(emailRecipientMigration, /ADD COLUMN IF NOT EXISTS email_to text NOT NULL DEFAULT ''/i,
  "Vendor email recipients must persist with the workflow draft.");
assert.match(migration, /vendor_code_overrides jsonb NOT NULL/i);
assert.match(migration, /archived_at timestamptz/i);
assert.match(migration, /review_status = 'completed'[\s\S]*completed_backfill/i,
  "Existing completed regular PO workflows must backfill into history.");
assert.match(repository, /resolveSmartScmVendorItemCodes/,
  "Vendor-facing codes must resolve against the actual NetSuite vendor-item relationship.");
assert.match(repository, /emailTo: row\.email_to[\s\S]*to: draft\.to/,
  "The saved recipient list must be returned with the email draft.");
assert.match(repository, /SET email_to = \$2,[\s\S]*email_subject = \$3/,
  "Saving an email draft must persist its recipients and subject together.");
assert.doesNotMatch(repository, /COALESCE\(NULLIF\(item\.vendor_code/,
  "A universal item code must not override vendor-specific NetSuite codes.");
assert.match(vendorCodeService, /\$3::bigint = 0 OR subsidiary_id IN \(0, \$3\)/,
  "An omitted subsidiary must read authoritative codes stored for real NetSuite subsidiaries.");
assert.match(vendorCodeService, /WHEN \$3 > 0 AND subsidiary_id = \$3 THEN 0[\s\S]*source = 'item_vendor'[\s\S]*preferred_vendor DESC/,
  "Vendor codes must prefer an exact requested subsidiary, then authoritative and preferred Item Vendor rows.");

const grouped = groupSmartScmVendorEmailRows([
  { id: 1, itemId: 24023, itemName: "TH-COV60T-3045-BEI", itemDescription: "Beige coping", proposedPallets: 3, destinationLocationId: 1 },
  { id: 2, itemId: 24023, itemName: "TH-COV60T-3045-BEI", itemDescription: "Beige coping", proposedPallets: 4.5, destinationLocationId: 28 },
  { id: 3, itemId: 777, itemName: "Other", itemDescription: "Other description", proposedPallets: 2, destinationLocationId: 1 },
  { id: 4, itemId: 999, itemName: "PALLET", itemDescription: "Official PALLET", proposedPallets: 9, ancillaryPallet: true }
], new Map([
  [24023, { vendorCode: "V-24023" }],
  [777, { vendorCode: "" }]
]), { 777: "MANUAL-777" });

assert.equal(grouped.length, 2, "Official PALLET must be excluded from vendor-facing rows.");
const merged = grouped.find((row) => row.itemId === 24023);
assert.equal(merged.requestedPallets, 7.5, "The same NetSuite item must merge across destination yards.");
assert.equal(merged.destinationCount, 2);
assert.equal(merged.vendorCode, "V-24023");
assert.equal(grouped.find((row) => row.itemId === 777).vendorCode, "MANUAL-777");

assert.match(repository, /export async function backfillSmartScmVendorWorkflows/);
assert.match(repository, /export async function saveSmartScmVendorEmailDraft/);
assert.match(repository, /export async function linkSmartScmVendorWorkflowReview/);
assert.match(repository, /export async function getSmartScmVendorWorkflowActionTarget/);
assert.match(repository, /export async function findSmartScmVendorWorkflowByPurchaseOrder/);
assert.match(repository, /export async function setSmartScmVendorWorkflowArchivedByPurchaseOrder/);
assert.match(repository, /export async function recordSmartScmVendorWorkflowPurchaseResult/);
assert.match(repository, /export async function recordSmartScmVendorWorkflowBlanketSplit/);
assert.match(repository, /export async function setSmartScmVendorWorkflowArchived/);
assert.match(repository, /archived_at = NULL,[\s\S]*archive_reason = NULL/,
  "Regular PO history moves must be reversible.");
assert.match(repository, /workflow\.workflow_status <> 'cancelled'/,
  "Cancelled Vendor Replies workflows must stay durable but leave the active queue.");
assert.match(repository, /canMoveToHistory:[\s\S]*netsuitePurchaseOrderId[\s\S]*> 0/,
  "Only a real NetSuite PO may move into application PO history.");
assert.match(repository, /WHEN \$6 = 'released' THEN 'split_created'/,
  "A fully released Blanket workflow must become completed.");
assert.match(repository, /archived_at = CASE WHEN \$7 THEN COALESCE\(archived_at, now\(\)\) ELSE NULL END/,
  "Only terminal Blanket releases must leave Vendor Replies automatically.");

const regularPurchaseRouteStart = server.indexOf('app.post("/api/scm/smart/vendor-workflows/:id/create-purchase-order"');
const blanketSplitRouteStart = server.indexOf('app.post("/api/scm/smart/vendor-workflows/:id/create-blanket-split"');
const archiveRouteStart = server.indexOf('app.patch("/api/scm/smart/vendor-workflows/:id/archive"');
assert(regularPurchaseRouteStart >= 0 && blanketSplitRouteStart > regularPurchaseRouteStart,
  "The regular NetSuite PO and local Blanket split routes must both exist.");
assert(archiveRouteStart > blanketSplitRouteStart,
  "The local Blanket split route must have a bounded server route block.");
const regularPurchaseRoute = server.slice(regularPurchaseRouteStart, blanketSplitRouteStart);
const blanketSplitRoute = server.slice(blanketSplitRouteStart, archiveRouteStart);
assert.match(regularPurchaseRoute, /target\.workflowKind !== "regular_po"/,
  "The server must reject a Blanket workflow before any NetSuite PO execution.");
assert(regularPurchaseRoute.indexOf('target.workflowKind !== "regular_po"')
  < regularPurchaseRoute.indexOf("executeSmartScmPurchaseProposal"),
  "The origin guard must run before the NetSuite purchase service is called.");
assert.match(regularPurchaseRoute, /executeSmartScmPurchaseProposal/,
  "A regular PO proposal must retain its explicit NetSuite creation path.");
assert.match(blanketSplitRoute, /target\.workflowKind !== "blanket_po"/,
  "Only Blanket workflows may use the local split endpoint.");
assert.match(blanketSplitRoute, /finalizeSmartScmBlanketVendorWorkflow/,
  "Blanket vendor confirmation must finalize against the local source-PO ledger.");
assert.doesNotMatch(blanketSplitRoute,
  /executeSmartScmPurchaseProposal|registerScmNetSuitePoHistoryCreation|createPurchaseOrderInNetSuite/,
  "A Blanket split must never call NetSuite PO creation or register NetSuite PO history.");

const listeners = new Map();
const context = vm.createContext({
  console,
  smartCanWrite: () => true,
  smartEscape: (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
  smartNumber: (value, places = 2) => Number(value || 0).toFixed(places).replace(/\.00$/, ""),
  smartDate: () => "Aug 1, 2026",
  smartPill: (value, label = null) => `<span class="smart-pill ${value}">${label || value}</span>`,
  smartProposalRoute: (proposal) => `${proposal.vendor} → ${proposal.destinationName}`,
  smartScmApp: { addEventListener(type, handler) { listeners.set(type, handler); } },
  smartState: { vendorReplyLoads: [], vendorSearch: "", busy: "", notice: "", error: "" },
  smartApi: async () => ({}),
  smartWork: async (_label, action) => action(),
  smartRender() {},
  document: { querySelector: () => null, getElementById: () => null, createElement: () => ({ style: {}, select() {}, remove() {} }), body: { appendChild() {} }, execCommand() {} },
  navigator: { clipboard: { writeText: async () => {} } },
  window: { open() {}, addEventListener() {} },
  confirm: () => true,
  Blob,
  URLSearchParams,
  setTimeout,
  clearTimeout
});
vm.runInContext(`${ui}\nglobalThis.__openSmartVendorEmail = (workflowId) => { smartVendorEmailModalWorkflowId = workflowId; };`, context, { filename: "scm-smart-vendor.js" });

const base = {
  id: 501,
  sourceProposalId: 501,
  workflowId: 902,
  workflowKind: "regular_po",
  workflowStatus: "vendor_replied",
  status: "vendor_replied",
  canEditVendorReply: true,
  canCreatePurchaseOrder: true,
  vendor: "Vendor A",
  destinationName: "3445",
  totalPallets: 7.5,
  totalWeightLbs: 8000,
  vendorResponseStatus: "partial",
  lines: [
    { id: 11, itemId: 24023, itemName: "TH-COV60T-3045-BEI", itemDescription: "Beige coping", proposedPallets: 3, toPlt: 10, destinationLocationId: 1, destinationName: "3445", vendorResponses: [] },
    { id: 12, itemId: 24023, itemName: "TH-COV60T-3045-BEI", itemDescription: "Beige coping", proposedPallets: 4.5, toPlt: 10, destinationLocationId: 28, destinationName: "12441", vendorResponses: [] }
  ],
  physicalPalletLines: [],
  vendorEmailRows: [{ itemId: 24023, itemName: "TH-COV60T-3045-BEI", vendorCode: "V-24023", description: "Beige coping", requestedPallets: 7.5 }],
  vendorEmailDraft: { to: "orders@vendor.example", subject: "Request", intro: "Hello", closing: "Thanks" }
};

const regularHtml = context.smartVendorLoadCard(base);
assert.match(regularHtml, /smart-vendor-card-primary/);
assert.match(regularHtml, /smart-vendor-card-facts/);
assert.doesNotMatch(regularHtml, /smart-proposal-head/,
  "Vendor cards must not inherit the generic proposal header grid.");
assert.match(regularHtml, /data-smart-action="create-vendor-po"/);
assert.doesNotMatch(regularHtml, /data-smart-action="create-blanket-split"/,
  "A regular proposal must not expose the local Blanket split action.");
assert.match(regularHtml, /data-smart-action="toggle-vendor-email"/,
  "A regular proposal must support drafting the vendor email.");
assert.doesNotMatch(regularHtml, /data-vendor-email-editor/,
  "The email draft must be a popup, not an inline section that expands the load card.");
assert.ok(regularHtml.indexOf('data-smart-action="save-vendor-load"') < regularHtml.indexOf('data-smart-action="toggle-vendor-email"'),
  "Save draft must sit immediately to the left of Draft email in the load header.");

context.smartState.vendorReplyLoads = [base];
context.__openSmartVendorEmail(902);
const regularEmailHtml = context.smartVendorEmailModal();
assert.match(regularEmailHtml, /smart-vendor-email-modal/);
assert.match(regularEmailHtml, /role="dialog" aria-modal="true"/);
assert.match(regularEmailHtml, />New message</);
assert.match(regularEmailHtml, /data-vendor-email-field="to"[^>]+orders@vendor\.example/);
assert.match(regularEmailHtml, /data-vendor-email-field="subject"[^>]+Request/);
assert.match(regularEmailHtml, /data-vendor-email-code="24023"[^>]+V-24023/);
assert.match(regularEmailHtml, /data-smart-action="copy-vendor-email-rich"/);
assert.match(regularEmailHtml, /data-smart-action="open-vendor-gmail"/);
assert.equal((regularEmailHtml.match(/<td><strong>TH-COV60T-3045-BEI<\/strong><\/td>/g) || []).length, 1,
  "The email popup must show a same-item multi-yard request as one visible merged table row.");

context.smartState.vendorReplyLoads = [{
  ...base,
  vendorCodeLookupError: "NetSuite vendor-code lookup is temporarily unavailable.",
  vendorEmailRows: [{ ...base.vendorEmailRows[0], vendorCode: "" }]
}];
const missingCodeHtml = context.smartVendorEmailModal();
assert.match(missingCodeHtml, /vendor-code lookup is temporarily unavailable/);
assert.match(missingCodeHtml, /missing a NetSuite vendor code/);

const liveFields = [
  { dataset: { vendorEmailField: "to" }, value: "edited@vendor.example" },
  { dataset: { vendorEmailField: "subject" }, value: "Edited request" },
  { dataset: { vendorEmailField: "intro" }, value: "Live introduction" },
  { dataset: { vendorEmailField: "closing" }, value: "Live closing" }
];
const liveCode = { dataset: { vendorEmailCode: "24023" }, value: "LIVE-CODE" };
const liveRow = {
  cells: [{ innerText: "TH-COV60T-3045-BEI" }, {}, { innerText: "Beige coping" }, { innerText: "7.5 PLT" }],
  querySelector(selector) { return selector === "[data-vendor-email-code]" ? liveCode : null; }
};
const liveEditor = {
  querySelectorAll(selector) {
    if (selector === "[data-vendor-email-field]") return liveFields;
    if (selector === "[data-vendor-email-code]") return [liveCode];
    if (selector === "[data-vendor-email-item]") return [liveRow];
    return [];
  }
};
const liveContent = context.smartVendorEmailContent(liveEditor);
assert.equal(liveContent.to, "edited@vendor.example");
assert.match(liveContent.html, /LIVE-CODE/);
assert.match(liveContent.html, /Live introduction/);
assert.match(liveContent.plain, /7\.5 PLT/);

const blanketHtml = context.smartVendorLoadCard({
  ...base,
  workflowId: 903,
  workflowKind: "blanket_po",
  canCreatePurchaseOrder: false,
  canCreateBlanketSplit: true,
  sourcePurchaseOrderRef: "PO-BLANKET-1"
});
assert.match(blanketHtml, /data-smart-action="create-blanket-split"/);
assert.doesNotMatch(blanketHtml, /data-smart-action="create-vendor-po"/,
  "A Blanket release must not expose NetSuite PO creation.");
assert.match(blanketHtml, /data-smart-action="toggle-vendor-email"/,
  "A Blanket release must support drafting the vendor email while awaiting confirmation.");
assert.match(blanketHtml, /data-vendor-load-field="splitPoRef"/);
assert.match(blanketHtml, /same source PO and its remaining quantity/);
assert.match(blanketHtml, /data-destination-location-id="1"/);

const blanketEmailProposal = {
  ...base,
  workflowId: 903,
  workflowKind: "blanket_po",
  sourcePurchaseOrderRef: "PO-BLANKET-1"
};
context.smartState.vendorReplyLoads = [blanketEmailProposal];
context.__openSmartVendorEmail(903);
const blanketEmailHtml = context.smartVendorEmailModal();
assert.match(blanketEmailHtml, /Source PO[^<]*PO-BLANKET-1/,
  "A Blanket email draft must visibly identify its source PO.");
const blanketEmailContent = context.smartVendorEmailContent({
  ...liveEditor,
  dataset: { vendorEmailSourcePo: "PO-BLANKET-1" }
});
assert.match(blanketEmailContent.html, /Source PO[^<]*<\/strong>[^<]*PO-BLANKET-1/,
  "Copied rich Blanket email content must include its source PO.");
assert.match(blanketEmailContent.plain, /Source PO:\s*PO-BLANKET-1/,
  "Gmail and plain-text Blanket email content must include its source PO.");

const blanketAlternativeHtml = context.smartVendorAlternativeMarkup(501, [{
  sourceLineId: 70001,
  itemId: 24023,
  itemName: "TH-COV60T-3045-BEI",
  description: "Beige coping",
  palletWeightLbs: 1000,
  remainingPallets: 5,
  sourcePoRef: "PO-BLANKET-1"
}], { isBlanket: true });
assert.match(blanketAlternativeHtml, /data-source-line-id="70001"/);
assert.match(blanketAlternativeHtml, /Remaining/);
assert.match(blanketAlternativeHtml, /max="5"/);
assert.match(ui, /destinationLocationId,/);

const createdHtml = context.smartVendorLoadCard({
  ...base,
  canEditVendorReply: false,
  canCreatePurchaseOrder: false,
  canMoveToHistory: true,
  workflowStatus: "po_created",
  netsuitePurchaseOrderId: 7654,
  netsuitePurchaseOrderRef: "PO7654"
});
assert.match(createdHtml, /data-smart-action="preview-vendor-po"/);
assert.match(createdHtml, /data-smart-action="archive-vendor-workflow"/);

assert.match(css, /\.smart-vendor-card-primary\s*\{/);
assert.match(css, /grid-template-columns: max-content minmax\(180px, 1fr\) max-content/);
assert.match(css, /\.smart-vendor-card-facts\s*\{/);
assert.match(css, /\.smart-vendor-email-table\s*\{/);
assert.match(css, /\.smart-vendor-email-modal\s*\{/);
assert.match(css, /\.smart-vendor-email-dialog\s*\{/);
assert.match(css, /\.smart-vendor-email-envelope-row\s*\{/);
assert.match(ui, /smartVendorEmailModal\(\)/);
assert.match(ui, /new URLSearchParams\(\{ view: "cm", fs: "1", su: content\.subject, body: content\.plain \}\)/,
  "Open Gmail must use the current modal values, with a send-ready plain body fallback.");
assert.match(ui, /smartVendorWriteClipboard\(\{ html: content\.html, plain: content\.plain \}\)/,
  "Open Gmail must also place the current rich HTML table on the clipboard.");

console.log(JSON.stringify({
  ok: true,
  durableWorkflow: true,
  groupedVendorRows: grouped.length,
  mergedPallets: merged.requestedPallets,
  regularDirectCreate: true,
  blanketSplit: true,
  reversibleHistory: true,
  gmailPopupAndLiveCopy: true,
  compactTwoBandHeader: true
}));
