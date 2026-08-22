import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { calculateMbbsCrossCharges } from "../../../src/mbt/local-billing-calculator.js";

const [html, script, css, router] = await Promise.all([
  readFile(new URL("../../../public/mbt-billing.html", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-billing.js", import.meta.url), "utf8"),
  readFile(new URL("../../../public/mbt-shell.css", import.meta.url), "utf8"),
  readFile(new URL("../../../src/mbt/router.js", import.meta.url), "utf8")
]);

test("S1: MBT table wrappers provide bounded vertical scrolling and sticky headers", () => {
  assert.match(css, /\.mbt-table-wrap\s*\{[^}]*max-height\s*:/su);
  assert.match(css, /\.mbt-table-wrap\s*\{[^}]*overflow\s*:\s*auto/su);
  assert.match(css, /\.mbt-table-wrap\s*\{[^}]*scrollbar-gutter\s*:\s*stable/su);
  assert.match(css, /\.mbt-table-wrap[^}]*th\s*\{[^}]*position\s*:\s*sticky/su);
});

test("S4/S6: billing UI exposes exact date and explicit database order search without default Pick-Up", () => {
  for (const id of ["mbbsCompletedDate", "mbbsOrderSearch", "searchMbbsOrders", "mbbsOrderSearchRows"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, "u"));
  }
  assert.match(html, /Delivery orders are included by default/iu);
  assert.match(html, /Pick-Up.*search/iu);
  assert.match(script, /completedDate/u);
  assert.match(script, /searchMbbsOrders/u);
  assert.match(script, /Add order/u);
});

test("S7: billing UI converts a recalculated batch through one idempotent durable endpoint", () => {
  for (const id of [
    "mbbsBillingCustomerSearch",
    "searchMbbsBillingCustomers",
    "mbbsBillingCustomerId",
    "mbbsBatchConversionReason",
    "createMbbsBillingCases"
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`, "u"));
  }
  assert.match(script, /\/api\/mbt\/billing\/mbbs\/candidates\/batch-create/u);
  assert.match(script, /commandIdentity\(["']mbt-billing-batch-create["']\)/u);
  assert.match(router, /\/billing\/mbbs\/candidates\/batch-create/u);
  assert.match(router, /idempotency-key/u);
});

test("calculation rows expose auditable relationship evidence and exactly two synchronized money edits", () => {
  assert.match(html, /Select for billing/u);
  assert.match(html, /Load \/ leg/u);
  assert.match(html, /Origin/u);
  assert.match(html, /Destination/u);
  assert.match(html, /Relationship and calculation/u);
  assert.match(html, /Pricing method/u);
  assert.match(html, /Adjustment \(CAD\)/u);
  assert.match(html, /Final charge \(CAD\)/u);
  assert.match(script, /data-mbbs-adjustment/u);
  assert.match(script, /data-mbbs-final-charge/u);
  assert.match(script, /manualAmountEdits/u);
  assert.match(script, /calculatedAmountMinor/u);
  assert.match(script, /adjustmentMinor/u);
  assert.match(script, /finalAmountMinor/u);
  assert.match(script, /data-mbbs-result-candidate-id/u);
  assert.match(script, /selectedMbbsBatchResultIds/u);
  assert.match(script, /manual_required/u);
  assert.match(script, /formatDistanceKm/u);
  assert.match(script, /data-mbbs-pricing-method/u);
  assert.match(script, /pricingSelections/u);
  assert.match(script, /pricingMethod:\s*state\.pricingSelections\.get\(candidateId\)/u);
  assert.match(script, /vendor_yard_flat/u);
  assert.match(script, /distance_band/u);
  assert.match(script, /selectedVendorRouteRate/u);
  assert.match(script, /\.format\(metres \/ 1000\)\} km/u);
  assert.doesNotMatch(script, /toLocaleString\(["']en-CA["']\)\}\s*m/u);
});

test("conversion sends only checked calculated or manual-rate rows and keeps grouped children visible", () => {
  assert.match(html, /Select all calculated results for billing/u);
  assert.match(script, /conversionCandidateIds/u);
  assert.match(script, /toggleBatchResult/u);
  assert.match(script, /memberReferences/u);
  assert.match(script, /children:/u);
  assert.match(script, /candidateIds:\s*conversionIds/u);
  assert.match(script, /manualAmountEdits:\s*conversionIds\.map/u);
  assert.match(script, /usableBatchResult\(result\)\s*\n\s*&& state\.selectedMbbsBatchResultIds\.has\(result\.candidateId\)/u);
  assert.match(script, /\.filter\(\(entry\) => entry\.status === "calculated"\)\s*\n\s*\.map\(\(entry\) => entry\.candidateId\)/u);
});

test("S5: CUSTOM is a first-class deterministic local cross-charge source", () => {
  const result = calculateMbbsCrossCharges({
    currency: "CAD",
    loads: [{
      physicalLoadId: "CUSTOM-LOAD-1",
      completedAt: "2039-07-11T16:00:00.000Z",
      planDate: "2039-07-11",
      calculatedMetres: 12_345,
      sharedTotalMinor: 20_000,
      references: [{ sourceType: "CUSTOM", rootReference: "CUSTOM-ORDER-1" }]
    }]
  });
  assert.deepEqual(result.cases.map((item) => ({
    sourceType: item.sourceType,
    deduplicationKey: item.deduplicationKey,
    allocatedAmountMinor: item.allocatedAmountMinor
  })), [{
    sourceType: "CUSTOM",
    deduplicationKey: "CUSTOM|CUSTOM-ORDER-1|CUSTOM-LOAD-1",
    allocatedAmountMinor: 20_000
  }]);
});
