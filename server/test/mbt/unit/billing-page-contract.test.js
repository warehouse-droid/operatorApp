import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, script, css] = await Promise.all([
  readFile(new URL("../../../public/mbt-billing.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-billing.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.css", import.meta.url), "utf8")
]);

test("billing page exposes only the local candidate and billing-case workspaces", () => {
  assert.match(html, /Local only/i);
  assert.match(html, /No outbox or NetSuite transport/i);
  assert.match(html, /Billing case queue/i);
  assert.match(html, /Completed MBBS order candidates/i);
  assert.match(html, /Driver PWA and reconciliation/i);
  assert.match(html, /DELIVERY_CHARGE_MBBS/u);
  assert.doesNotMatch(html, /Calculation evidence and versions/i);
  assert.doesNotMatch(html, /Pilot reconciliation/i);
  assert.doesNotMatch(html, /id=["']calculateBillingForm["']/u);
  assert.doesNotMatch(html, /id=["']approveBillingForm["']/u);
  assert.doesNotMatch(html, /id=["']reconciliationTitle["']/u);
  assert.match(html, /mbt-billing\.js/iu);
  assert.match(css, /data-mbt-surface=["']billing["']/u);
});

test("P3-F27 browser contract keeps reads available while disabling every command from server gate state", () => {
  assert.match(script, /\/api\/mbt\/billing\/status/u);
  assert.match(script, /commandsEnabled\s*=\s*result\.commandState\?\.enabled\s*===\s*true/u);
  assert.match(script, /querySelectorAll\(["']\.mbt-command["']\)/u);
  assert.match(script, /button\.disabled\s*=\s*!state\.commandsEnabled/u);
  assert.match(script, /\/api\/mbt\/billing\/cases/u);
  assert.match(script, /\/api\/mbt\/billing\/mbbs\/candidates/u);
  assert.match(script, /\/candidates\/batch-preview/u);
  assert.match(script, /local_only_preview/u);
  assert.doesNotMatch(script, /\/api\/mbt\/reconciliation\/batches/u);
});

test("browser contract delegates candidate money to server endpoints and has no posting path", () => {
  assert.match(script, /\/batch-preview/u);
  assert.doesNotMatch(script, /subtotalMinor\s*=|totalMinor\s*=|allocatedAmountMinor\s*=/u);
  assert.doesNotMatch(script, /netsuite.*(?:post|write)|(?:post|write).*netsuite/iu);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML/u);
});

test("candidate and billing-case workspaces use top-level tabs and master/detail panels", () => {
  for (const id of [
    "billingWorkspaceCandidateTab",
    "billingWorkspaceCaseTab",
    "mbbsCandidateWorkspace",
    "billingCaseWorkspace",
    "mbbsCandidateMaster",
    "mbbsCandidateDetail",
    "billingCaseMaster",
    "billingCaseDetail"
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, "u"), `${id} must be rendered.`);
  }
  assert.match(html, /role=["']tablist["']/u);
  assert.match(html, /role=["']tabpanel["']/u);
  assert.match(css, /mbt-billing-master-detail/u);
  assert.match(script, /selectBillingWorkspace/u);
});

test("billing-case actions stay inside the selected detail and do not require copied UUIDs", () => {
  for (const id of [
    "billingCaseCalculationForm",
    "billingCaseWaiverCad",
    "billingCaseWaiverReason",
    "billingCaseApprovalForm"
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, "u"), `${id} must be rendered in the detail.`);
  }
  assert.match(html, /Optional audited waiver/u);
  assert.match(script, /state\.selectedBillingCase/u);
  assert.match(script, /selected\.serviceVisitId/u);
  assert.match(script, /selected\.visitDistanceSnapshotId/u);
  assert.doesNotMatch(html, /Billing case UUID|Service visit UUID|Distance snapshot UUID/u);
});

test("missing candidate addresses are edited only through the audited billing override endpoint", () => {
  for (const id of ["mbbsAddressOverrideForm", "mbbsAddressOverrideText", "mbbsAddressOverrideReason"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, "u"), `${id} must be rendered.`);
  }
  assert.match(script, /\/address-override/u);
  assert.match(script, /commandIdentity\(["']mbt-billing-address-override["']\)/u);
  assert.doesNotMatch(script, /sales[_-]orders.*(?:put|patch|post)|driver.*(?:put|patch|post)/iu);
});

test("MBBS candidate workflow selects completion month, active rate version, and a bounded batch", () => {
  for (const id of [
    "mbbsCompletedMonth",
    "mbbsRateCardVersion",
    "selectAllMbbsCandidates",
    "calculateSelectedMbbsCandidates",
    "mbbsBatchResultRows"
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, "u"), `${id} must be rendered.`);
  }
  assert.match(html, /Completed month \(Toronto\)/u);
  assert.match(html, /Choose MBBS rate card/u);
  assert.match(html, /Calculate selected orders/u);
  assert.match(script, /completedMonth/u);
  assert.match(script, /rateOptions/u);
  assert.match(script, /rateCardVersionId/u);
  assert.match(script, /data-mbbs-candidate-id/u);
  assert.match(script, /\/api\/mbt\/billing\/mbbs\/candidates\/batch-preview/u);
  assert.match(script, /URLSearchParams\(\{ limit: "1000" \}\)/u);
  assert.match(script, /candidateIds/u);
  assert.match(script, /successCount/u);
  assert.match(script, /failureCount/u);
});
