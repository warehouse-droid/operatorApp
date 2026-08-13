import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import {
  SMART_SCM_VENDOR_UNIT_PRICE_MAX,
  normalizeSmartScmVendorUnitPrice,
  smartScmVendorUnitPriceEdit
} from "../../../src/smart-scm-vendor-unit-price.js";

test("every accepted finite price stays positive, bounded, six-decimal, and resettable", () => {
  fc.assert(fc.property(
    fc.double({ min: 0.000001, max: SMART_SCM_VENDOR_UNIT_PRICE_MAX, noNaN: true, noDefaultInfinity: true }),
    (rawPrice) => {
      const normalized = normalizeSmartScmVendorUnitPrice(rawPrice);
      assert(normalized > 0);
      assert(normalized <= SMART_SCM_VENDOR_UNIT_PRICE_MAX);
      assert.equal(normalized, Math.round((normalized + Number.EPSILON) * 1_000_000) / 1_000_000);
      const edited = smartScmVendorUnitPriceEdit({}, { unitPrice: rawPrice }, {
        updatedAt: "2026-08-11T00:00:00.000Z",
        updatedBy: "property"
      });
      assert.equal(edited.unitPrice, normalized);
      const reset = smartScmVendorUnitPriceEdit(edited.draft, { unitPrice: null });
      assert.equal(reset.unitPrice, null);
      assert.equal(Object.hasOwn(reset.draft, "unitPrice"), false);
    }
  ), { numRuns: 500, seed: 116758 });
});

test("all non-positive finite prices are rejected", () => {
  fc.assert(fc.property(
    fc.double({ min: -SMART_SCM_VENDOR_UNIT_PRICE_MAX, max: 0, noNaN: true, noDefaultInfinity: true }),
    (rawPrice) => {
      assert.throws(() => normalizeSmartScmVendorUnitPrice(rawPrice), /greater than zero/);
    }
  ), { numRuns: 500, seed: 117328 });
});
