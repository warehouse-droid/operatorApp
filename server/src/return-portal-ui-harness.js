import assert from "node:assert/strict";
import fs from "node:fs/promises";

const publicFile = (name) => fs.readFile(new URL(`../public/${name}`, import.meta.url), "utf8");

const [
  control,
  controlCss,
  controlHtml,
  adminHtml,
  sidebar,
  sales,
  salesCss,
  salesHtml,
  smart,
  smartCss,
  smartHtml
] = await Promise.all([
  publicFile("control.js"),
  publicFile("control.css"),
  publicFile("control.html"),
  publicFile("admin.html"),
  publicFile("app-sidebar.js"),
  publicFile("sales.js"),
  publicFile("sales.css"),
  publicFile("sales.html"),
  publicFile("scm-smart.js"),
  publicFile("scm-smart.css"),
  publicFile("scm-smart.html")
]);

assert.match(sidebar, /Return Management.+\/control\/returns/s);
assert.match(sidebar, /Return Automation.+\/admin\/return-automation/s);
assert.match(sidebar, /Return Records.+\/sales\/returns/s);

assert.match(control, /"returns":?\s*"\/control\/returns"|returns:\s*"\/control\/returns"/);
assert.match(control, /"return-automation":\s*"\/admin\/return-automation"/);
assert.match(control, /Allowing cross-yard stock returns for this yard means this yard accepts stock from both its own orders and orders from other yards\./);
assert.match(control, /Customer-level PALLET returns are accepted at every yard\./);
assert.match(control, /request\("\/api\/control\/return-settings"\)/);
assert.match(control, /hasStaffAuthority\(operator,\s*\["admin"\]\)[\s\S]+syncStatus === "failed"/);
assert.match(control, /\/api\/admin\/return-settings/);
assert.match(control, /autoCreateStockRa/);
assert.match(control, /autoCreatePalletCreditMemo/);
assert.match(control, /\/api\/returns\/\$\{encodeURIComponent\(selectedReturnId\)\}\/lines\/\$\{encodeURIComponent\(button\.dataset\.lineId\)\}\/decision/);
assert.match(control, /\/api\/returns\/\$\{encodeURIComponent\(button\.dataset\.id\)\}\/void/);
assert.match(control, /\/api\/returns\/\$\{encodeURIComponent\(button\.dataset\.id\)\}\/sync\/retry/);
assert.match(control, /\/api\/returns\/\$\{encodeURIComponent\(form\.dataset\.id\)\}\/netsuite-link/);
assert.match(control, /\/api\/returns\/drafts\/\$\{encodeURIComponent\(button\.dataset\.id\)\}\/discard/);
assert.match(control, />Drafts</);
assert.match(control, /Only the creating operator can resume this draft in the Operator PWA/);
assert.match(control, /A rejection reason is required/);
assert.match(control, /A void reason is required/);
assert.match(control, /Estimated credit/);
assert.match(control, /Actual credit/);
assert.match(control, /data-field="returnPolicyOverride"/);
assert.match(control, /\/api\/inventory\/classifications\/\$\{button\.dataset\.item\}/);
assert.match(control, /payload\.returnPolicyOverride\s*=\s*selectedPolicy === "DEFAULT" \? null : selectedPolicy/);
assert.match(control, /expectedReturnPolicyContext/);
assert.match(control, /returnDashboardCounts/);
assert.match(control, /partially_rejected/);
assert.doesNotMatch(
  control,
  /\/api\/scm\/smart\/items\/\$\{button\.dataset\.item\}[\s\S]{0,300}returnPolicyOverride/,
  "Control classification and Return Policy must save atomically through one endpoint."
);
assert.match(control, /Company-wide/);
assert.match(control, /returnPhotoRef[\s\S]+photoReference/);
assert.match(control, /fetch\(`\/api\/photo-upload\/preview\?ref=\$\{encodeURIComponent\(ref\)\}`[\s\S]+Authorization:\s*`Bearer \$\{token\}`/);
assert.match(control, /URL\.createObjectURL/);
assert.match(control, /URL\.revokeObjectURL/);
assert.doesNotMatch(control, /photo-upload\/preview\?ref=[^\n]+token=/, "Control photo URLs must not embed the staff bearer token.");
assert.match(controlCss, /\.return-management-layout/);
assert.match(controlCss, /\.return-photo-grid/);
assert.match(controlCss, /\.return-automation-grid/);
assert.match(controlHtml, /control\.js\?v=20260805-so-type-filter-v2/);
assert.match(adminHtml, /control\.js\?v=20260805-so-type-filter-v2/);

assert.match(sales, /SALES_RETURNS_PAGE = window\.location\.pathname === "\/sales\/returns"/);
assert.match(sales, /allowPublicSales:\s*!SALES_RETURNS_PAGE/);
assert.match(sales, /\/api\/sales\/returns/);
assert.match(sales, /ordering yard\(s\)/i);
assert.match(sales, /Estimated credit/);
assert.match(sales, /Actual NetSuite credit/);
assert.match(sales, /partially_rejected/);
assert.match(sales, /salesReturnPhotoRef[\s\S]+photoReference/);
assert.match(sales, /fetch\(`\/api\/photo-upload\/preview\?ref=\$\{encodeURIComponent\(ref\)\}`[\s\S]+Authorization:\s*`Bearer \$\{dispatchAuthToken\}`/);
assert.match(sales, /URL\.createObjectURL/);
assert.match(sales, /URL\.revokeObjectURL/);
assert.doesNotMatch(sales, /photo-upload\/preview\?ref=[^\n]+token=/, "Sales photo URLs must not embed the staff bearer token.");
assert.doesNotMatch(sales, /decide-return-line|void-return|retry-return-sync|manual-return-link/);
assert.match(salesCss, /\.sales-return-layout/);
assert.match(salesCss, /\.sales-return-photo-grid/);
assert.match(salesHtml, /sales\.css\?v=20260729-return-records-v1/);
assert.match(salesHtml, /sales\.js\?v=20260729-return-records-v1/);

assert.match(smart, /function smartCanManageReturnPolicy\(\)[\s\S]+smartRoles\(\)\.has\("admin"\)/);
assert.match(smart, /returnPolicy:\s*smartState\.itemReturnPolicy/);
assert.match(smart, /returnPolicyOverride:\s*smartState\.itemReturnPolicyOverride/);
assert.match(smart, /ALLOWED/);
assert.match(smart, /APPROVAL_REQUIRED/);
assert.match(smart, /NOT_RETURNABLE/);
assert.match(smart, /Reset to default/);
assert.match(smart, /return_policy use ALLOWED, APPROVAL_REQUIRED, NOT_RETURNABLE, or DEFAULT\/blank/);
assert.match(smart, /data-item-field="returnPolicyOverride"/);
assert.match(smart, /returnPolicyOverride:\s*null,[\s\S]+expectedReturnPolicyRevision:/);
assert.match(smartCss, /\.smart-return-policy-cell/);
assert.match(smartCss, /\.smart-return-effective\.approval_required/);
assert.match(smartHtml, /scm-smart\.css\?v=20260801-blanket-ui-v2/);
assert.match(smartHtml, /scm-smart\.js\?v=20260801-focus-preservation-v1/);

console.log("Return portal UI harness passed.");
