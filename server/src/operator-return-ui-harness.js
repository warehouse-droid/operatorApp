import fs from "node:fs";
import assert from "node:assert/strict";

const operator = fs.readFileSync(new URL("../public/operator.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/operator.css", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/operator.html", import.meta.url), "utf8");
const i18n = fs.readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const serviceWorker = fs.readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");
const photoUpload = fs.readFileSync(new URL("./photo-upload.js", import.meta.url), "utf8");

const requiredOperatorTokens = [
  '"pallet-return"',
  '"stock-return"',
  "renderReturnWorkflow",
  "/api/returns/reasons",
  "/api/returns/orders/lookup",
  "/api/returns/customers?",
  "/pallet-balance?",
  "/api/returns/operator/drafts?",
  "/api/returns/operator/history?",
  "/api/returns/operator/history/",
  "/api/returns/drafts",
  "/api/returns/submit",
  "idempotencyKey",
  "return-add-split-row",
  "clientRowKey",
  "sourceLineId",
  "returnPalletPhotos",
  "returnRecordPhotos",
  "operator-return-photo",
  "CROSS_YARD_RETURN_BLOCKED",
    "returnYardName",
    "RETURN_ORDER_PREFIX_YARDS",
    "returnYardSettings",
    "returnLookupYardPreflight",
    "RETURN_MAX_PHOTOS = 5",
    "RETURN_QUANTITY_EPSILON = 1e-6",
  "stockReturnType",
  "receivingLocationId",
  "vehiclePlate",
  "let returnHeaderNote",
  'data-return-input="headerNote"',
  "note: returnHeaderNote.trim()",
  "draft.note || draft.headerNote",
  "return-header-note"
];

for (const token of requiredOperatorTokens) {
  assert.ok(operator.includes(token), `operator return UI is missing ${token}`);
}

const returnUiStart = operator.indexOf("function returnModuleActive");
const returnUiEnd = operator.indexOf("function renderDeliverySelect", returnUiStart);
assert.ok(returnUiStart >= 0 && returnUiEnd > returnUiStart, "return render section was not found");
const returnUi = operator.slice(returnUiStart, returnUiEnd);
assert.equal(returnUi.includes('type="file"'), false, "return UI must not expose gallery/file upload");
assert.ok(returnUi.includes("return-start-camera"), "return UI must expose live camera capture");
for (const unsupported of [
  "operator-stock-return-photo",
  "operator-pallet-return-photo",
  "operator-quality-return-photo"
]) {
  assert.equal(operator.includes(unsupported), false, `return UI must not request unsupported upload type ${unsupported}`);
}
assert.ok(photoUpload.includes('"operator-return-photo"'), "photo upload allowlist must accept operator-return-photo");
assert.match(operator, /RETURN_HISTORY_PAGE_SIZE\s*=\s*100/);
assert.match(operator, /\/api\/returns\/operator\/history\?\$\{params\.toString\(\)\}/);
assert.match(operator, /offset:\s*String\(returnHistoryOffset\)/);
assert.match(operator, /data-action="return-history-next"/);
assert.doesNotMatch(
  operator,
  /returns\/operator\/history[\s\S]{0,160}receivingLocationId/,
  "creator return history must not be scoped to the currently selected yard"
);
assert.match(operator, /function refreshReturnQuantityFeedback/);
assert.match(operator, /returnCustomerSearchActive/);
assert.match(operator, /returnCustomerSearchPending/);
assert.match(operator, /generation === returnCustomerSearchGeneration/);
assert.match(operator, /data-return-pallet-over/);
assert.match(operator, /data-return-line-over/);
assert.match(operator, /proposedTotal > remaining \+ RETURN_QUANTITY_EPSILON/);
assert.match(operator, /returnPalletQuantity\) > available \+ RETURN_QUANTITY_EPSILON/);
assert.match(operator, /data-action="return-step-quantity"/);
assert.match(operator, /function stepReturnQuantity/);
assert.match(operator, /data-action="return-select-stock-line"/);
assert.match(css, /\.return-line-card\.active\s*\{[^}]*box-shadow:\s*inset 6px 0 0 var\(--blue\)/);
assert.match(operator, /RETURN_LINE_PAGE_SIZE\s*=\s*3/);
assert.match(
  operator,
  /function returnLines\(\)[\s\S]*NOT_RETURNABLE[\s\S]*RETURN_QUANTITY_EPSILON/,
  "the Operator list must defensively hide blocked or exhausted return lines"
);
assert.doesNotMatch(
  returnUi,
  /<input[^>]+(?:data-return-input="palletQuantity"|data-return-line-input="(?:pallets|layers|sections|pieces|salesQuantity)")/,
  "return quantities must use + / - controls without opening a keyboard"
);
assert.match(
  returnUi,
  /<div class="return-form-grid return-quantity-grid">\s*\$\{returnMode === "stock" \? renderReturnStockLines\(\) : renderReturnPalletSelectorPanel\(\)\}\s*\$\{renderReturnSelectedLineEditor\(\)\}/,
  "return quantity form must render only the selector list and selected-line editor"
);
const stockCardStart = operator.indexOf("function renderReturnStockLine");
const stockCardEnd = operator.indexOf("function returnSelectedStockLine", stockCardStart);
const stockCardBody = operator.slice(stockCardStart, stockCardEnd);
assert.equal(stockCardBody.includes("renderReturnStockRow"), false, "middle stock cards must never contain inline quantity editors");
const palletRowStart = operator.indexOf("function renderReturnPalletSection");
const palletRowEnd = operator.indexOf("function renderReturnPalletEditor", palletRowStart);
const palletRowBody = operator.slice(palletRowStart, palletRowEnd);
assert.equal(palletRowBody.includes("return-section"), false, "PALLET selector must not use the generic return-section wrapper");
assert.match(palletRowBody, /data-source-line="PALLET"/);
assert.match(
  css,
  /\.pallet-only-selector \.return-pallet-selector-footer\s*\{[^}]*margin:\s*0;/,
  "PALLET-only selector must stay aligned to the top instead of being vertically centered"
);
const selectedEditorStart = operator.indexOf("function renderReturnSelectedLineEditor");
const selectedEditorEnd = operator.indexOf("function updateReturnPhotoRequirement", selectedEditorStart);
const selectedEditorBody = operator.slice(selectedEditorStart, selectedEditorEnd);
assert.match(
  selectedEditorBody,
  /<div class="return-balance-grid return-stock-balance-grid">[\s\S]*operator\.fulfilled[\s\S]*operator\.netsuiteReturned[\s\S]*operator\.localReserved[\s\S]*class="available"[\s\S]*operator\.remaining/,
  "selected stock lines must show the four balances as a visible 2x2 tile grid"
);
assert.match(
  css,
  /\.return-selected-editor \.return-balance-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
  "selected return balances must render in two columns"
);
assert.match(css, /\.return-stock-balance-grid strong\s*\{[^}]*font-size:\s*20px/);
assert.match(
  css,
  /\.return-selected-editor \.return-line-inputs\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  "stock quantity controls must be vertically stacked in one column"
);
assert.match(operator, /class="stepper-field return-unit-field(?: sales-uom)?"/);
assert.match(
  css,
  /\.return-selected-line-editor \.return-unit-field \.return-quantity-stepper\s*\{[^}]*grid-row:\s*auto;[^}]*grid-column:\s*auto;/,
  "stock unit steppers must occupy their own full-width row"
);
assert.match(
  css,
  /\.return-selected-line-editor \.return-unit-field \.return-quantity-stepper\s*\{[^}]*grid-template-columns:\s*48px\s*minmax\(0,\s*1fr\)\s*48px/,
  "Return steppers must match Delivery Prep's full-width 48px controls"
);
assert.match(css, /\.return-selected-line-editor \.return-unit-field\.sales-uom\s*\{[^}]*grid-column:\s*1;/);

const formStart = operator.indexOf("function renderReturnForm");
const formEnd = operator.indexOf("function returnSelectedRows", formStart);
const formBody = operator.slice(formStart, formEnd);
assert.match(
  formBody,
  /class="return-form-shell \$\{returnMode === "stock" \? "stock-return-form" : "pallet-return-form"\}"/,
  "stock and PALLET forms must expose separate layout scopes"
);
assert.match(
  css,
  /\.stock-return-form \.return-quantity-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*3fr\)\s*minmax\(340px,\s*2fr\)/,
  "the Stock Return selector/editor workspace must use a 60/40 split"
);
assert.equal(formBody.includes('data-return-input="vehiclePlate"'), false, "vehicle plate must not be entered on the quantity form");
assert.equal(formBody.includes('data-return-input="headerNote"'), false, "header note must not be entered on the quantity form");
assert.equal(formBody.includes("renderReturnPhotoWorkspace"), false, "photo capture must not occupy the quantity form");
const quantityEditorStart = operator.indexOf("function renderReturnPalletEditor");
const quantityEditorEnd = operator.indexOf("function updateReturnPhotoRequirement", quantityEditorStart);
const quantityEditorBody = operator.slice(quantityEditorStart, quantityEditorEnd);
assert.equal(quantityEditorBody.includes("return-open-camera"), false, "quantity editors must not expose photo capture");
const reviewStart = operator.indexOf("function renderReturnReview()");
const reviewEnd = operator.indexOf("function renderReturnSuccess", reviewStart);
const reviewBody = operator.slice(reviewStart, reviewEnd);
assert.match(reviewBody, /data-return-input="vehiclePlate"/);
assert.match(reviewBody, /data-return-input="headerNote"/);
assert.match(reviewBody, /<section class="fulfillment-screen return-review-screen">/);
assert.match(reviewBody, /renderReturnPhotoWorkspace\(\)/);
assert.match(operator, /function renderReturnPalletReviewLine\(\)[\s\S]*class="return-review-line pallet-return-review-line"/);
assert.match(reviewBody, /const palletReviewLine = renderReturnPalletReviewLine\(\);/);
assert.match(
  operator,
  /<span class="return-review-reason">\$\{escapeHtml\(reason\.label \|\| "-"\)\}<\/span>/,
  "the Review reason must have its own prominent typography target"
);
assert.match(css, /\.return-review-line \.return-review-reason\s*\{[^}]*font-size:\s*16px;[^}]*font-weight:\s*1000;/);
assert.match(css, /\.return-review-line > div strong\s*\{[^}]*font-size:\s*17px;/);
assert.match(css, /\.return-review-line > b\s*\{[^}]*font-size:\s*18px;/);
assert.doesNotMatch(reviewBody, /operator\.stockLines|class="return-review-meta"/, "Review must not show the redundant stock-line count");
assert.ok(
  reviewBody.indexOf('class="fulfillment-lines return-review-lines"') < reviewBody.indexOf('class="return-review-entry-fields"'),
  "vehicle plate and note must follow the return lines at the bottom of the Review container"
);
assert.ok(
  reviewBody.indexOf("operator.finalValidationNotice") < reviewBody.indexOf('class="return-review-entry-fields"'),
  "vehicle plate and note must be the final Review content"
);
assert.match(css, /\.return-review-detail-scroll\s*\{[^}]*flex:\s*1 1 auto;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/);
assert.match(css, /\.return-review-entry-fields\s*\{[^}]*margin-top:\s*auto;/);
assert.match(css, /\.return-review-lines\s*\{[^}]*flex:\s*0 0 auto;/);
assert.match(css, /\.return-review-lines > \.pallet-return-review-line\s*\{[^}]*background:\s*#fff1cf;/);
assert.match(operator, /data-action="return-select-evidence-target"/);
assert.match(operator, /function returnReviewPhotoTargets\(\)/);
assert.match(operator, /returnType === "quality"[\s\S]*kind:\s*"line"/);
assert.match(operator, /Number\(returnPalletQuantity\) > 0[\s\S]*kind:\s*"pallet"/);
assert.match(operator, /validateReturnForReview\(\{\s*requireVehiclePlate:\s*false,\s*requirePhotos:\s*false\s*\}\)/);
assert.match(operator, /function validateReturnForReview\(\{\s*requireVehiclePlate = true,\s*requirePhotos = true\s*\}/);
assert.match(operator, /if \(requirePhotos && palletQty > 0/);
assert.match(operator, /if \(requirePhotos && returnType === "quality"/);
assert.match(operator, /if \(requirePhotos && returnMode === "stock" && returnType === "normal"/);
assert.match(operator, /returnStage = "review";\s*return render\(\);/);
assert.match(operator, /ORDER_NOT_FULLY_FULFILLED/);
assert.match(operator, /NetSuite status must show fully fulfilled before recording a return/);
assert.doesNotMatch(operator, /Item Receipts/, "fulfillment error copy must not tell the operator to wait for Item Receipts");
assert.equal(returnUi.includes("return-review-aside"), false, "return checklist must not be rendered");
assert.equal(returnUi.includes("operator.returnChecklist"), false, "return checklist copy must not be rendered");
assert.match(css, /\.sync-alert\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/);

const lookupStart = operator.indexOf("async function lookupReturnOrder");
const lookupEnd = operator.indexOf("async function searchReturnCustomers", lookupStart);
const lookupBody = operator.slice(lookupStart, lookupEnd);
assert.match(lookupBody, /ORDER_NOT_FULLY_FULFILLED/);
assert.ok(lookupBody.indexOf("returnLookupYardPreflight(clean)") >= 0, "return lookup must run the local yard preflight");
assert.match(
  lookupBody,
  /if \(returnMode === "stock"\) \{\s*const yardPreflight = returnLookupYardPreflight\(clean\);/,
  "only stock returns may be blocked by the order-prefix yard preflight"
);
assert.ok(
  lookupBody.indexOf("returnLookupYardPreflight(clean)") < lookupBody.indexOf('api("/api/returns/orders/lookup"'),
  "wrong-yard returns must be rejected before the NetSuite lookup API request"
);
assert.match(
  lookupBody,
  /JSON\.stringify\(\{\s*code:\s*clean,\s*receivingLocationId:\s*locationId,\s*mode:\s*returnMode\s*\}\)/,
  "order lookup must tell the API whether this is a PALLET-only or stock return"
);
assert.match(operator, /SOA:\s*\{\s*locationId:\s*28,\s*yardCode:\s*"2967"\s*\}/);
assert.match(operator, /SOB:\s*\{\s*locationId:\s*1,\s*yardCode:\s*"3445"\s*\}/);
assert.match(operator, /SOM:\s*\{\s*locationId:\s*26,\s*yardCode:\s*"150"\s*\}/);
assert.match(
  operator,
  /function draftReturnMode\(draft\)[\s\S]*if \(type\.includes\("pallet"\)\) return "pallet";[\s\S]*draft\?\.orderId/,
  "an explicit PALLET draft mode must take precedence over its Sales Order reference"
);
assert.match(
  operator,
  /fetch\(`\/api\/photo-upload\/preview\?ref=\$\{encodeURIComponent\(ref\)\}`[\s\S]+Authorization:\s*`Bearer \$\{authToken\}`/,
  "protected return photos must be fetched with the operator Authorization header"
);
assert.ok(operator.includes("URL.createObjectURL"), "protected return photos must use browser object URLs");
assert.ok(operator.includes("URL.revokeObjectURL"), "protected return photo object URLs must be cleaned up");
assert.doesNotMatch(
  operator,
  /photo-upload\/preview\?ref=[^\n]+token=/,
  "operator return photo URLs must not embed the long-lived bearer token"
);

for (const selector of [
  ".return-lookup-grid",
  ".return-form-shell",
  ".return-line-card",
  ".return-photo-workspace",
  ".return-stock-selector-panel",
  ".return-selected-editor",
  ".return-pallet-compact",
  ".return-review-screen",
  ".return-review-details-card",
  ".return-evidence-targets",
  ".return-records-shell",
  ".return-review-entry-fields",
  ".return-header-note",
  ".return-quantity-stepper"
]) {
  assert.ok(css.includes(selector), `return tablet CSS is missing ${selector}`);
}

for (const key of [
  "operator.normalStockReturn",
  "operator.qualityReturn",
  "operator.returnApprovalRequired",
  "operator.vehiclePlateRequired",
  "operator.returnNoteOptional",
  "operator.decreaseQuantity",
  "operator.increaseQuantity",
  "operator.selectedReturnItem",
  "operator.requiredBeforeConfirm",
  "operator.orderNotFullyFulfilled",
  "operator.finalValidationHelp",
  "operator.addAnotherReason",
  "operator.evidenceTargets",
  "operator.evidenceReady"
]) {
  assert.ok(i18n.includes(`"${key}"`), `Chinese dictionary is missing ${key}`);
}

for (const asset of [
  "/operator.css?v=20260810-operator-performance-v1",
  "/i18n.js?v=20260815-customer-pickup-photo-gate-v1",
  "/operator.js?v=20260815-customer-pickup-photo-gate-v1"
]) {
  assert.ok(html.includes(asset), `operator HTML cachebuster is missing ${asset}`);
  assert.ok(serviceWorker.includes(asset), `service worker shell is missing ${asset}`);
}
assert.ok(
  serviceWorker.includes("mbbs-yard-operator-v140-customer-pickup-photo-gate-v1"),
  "service worker cache name must retain the current driver-cache isolation version"
);

console.log("operator return UI harness passed");
