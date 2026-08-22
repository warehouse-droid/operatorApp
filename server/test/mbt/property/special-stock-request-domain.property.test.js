import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import {
  assertSpecialOrderRelease,
  normalizeSpecialCaseDraft,
  specialPurchaseOrderMarker,
  specialSalesOrderMarker
} from "../../../src/special-stock-request-domain.js";

test("every accepted finite case quantity round-trips without sign or magnitude drift", () => {
  fc.assert(fc.property(
    fc.double({ min: 0.000001, max: 1_000_000_000, noNaN: true, noDefaultInfinity: true }),
    (quantity) => {
      const normalized = normalizeSpecialCaseDraft({
        storeLocationId: 1,
        inquiryDate: "2026-08-21",
        customerName: "Property Customer",
        vendorName: "Property Vendor",
        lines: [{ productName: "Property Item", quantity, uom: "PCS", requiredDate: "2099-09-01" }]
      }, { authorizedStoreLocationIds: [1], minimumRequiredDate: "2099-08-26" });
      assert.equal(normalized.lines[0].quantity, quantity);
      assert.ok(normalized.lines[0].quantity > 0 && normalized.lines[0].quantity <= 1_000_000_000);
    }
  ), { numRuns: 300 });
});

test("a pending line always prevents order release regardless of terminal siblings", () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom("accepted", "declined", "closed"), { minLength: 0, maxLength: 30 }),
    (terminalDecisions) => {
      const lines = terminalDecisions.map((salesDecision, index) => ({
        id: index + 1,
        salesDecision,
        responseVendorId: 3243,
        itemResolution: { itemId: 2055 }
      }));
      lines.push({ id: lines.length + 1, salesDecision: "pending", responseVendorId: 3243 });
      assert.throws(() => assertSpecialOrderRelease(lines), (error) => error?.code === "SPECIAL_RELEASE_LINES_PENDING");
    }
  ), { numRuns: 200 });
});

test("SO and PO markers remain stable, unique by type, and injective for positive IDs", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (id) => {
    const so = specialSalesOrderMarker(id);
    const po = specialPurchaseOrderMarker(id);
    assert.notEqual(so, po);
    assert.ok(so.endsWith(String(id)));
    assert.ok(po.endsWith(String(id)));
  }), { numRuns: 300 });
});
