import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import {
  isUnchangedScmPoPickup,
  scmPoPickupNeedsNetSuiteAddressLookup
} from "../../../src/scm-po-pickup-save-policy.js";

const pickupCharacters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789# .-"];
const pickup = fc.array(fc.constantFrom(...pickupCharacters), { minLength: 1, maxLength: 80 })
  .map((characters) => characters.join(""))
  .filter((value) => Boolean(value.trim()));

test("stored pickup identity is case-insensitive and never falls through to a vendor fallback", () => {
  fc.assert(fc.property(pickup, pickup, (stored, other) => {
    const requested = `  ${stored.toUpperCase()}  `;
    assert.equal(isUnchangedScmPoPickup({
      requestedPickup: requested,
      currentPickup: stored,
      groupRef: "PGOB-ANY",
      netSuiteAddressVendor: other
    }), true);
    assert.equal(scmPoPickupNeedsNetSuiteAddressLookup({
      requestedPickup: requested,
      currentPickup: stored,
      groupRef: ""
    }), false);
  }), { numRuns: 200 });
});

test("a NetSuite-address label is compatible only for an ungrouped PO with no stored pickup", () => {
  fc.assert(fc.property(pickup, (vendor) => {
    assert.equal(isUnchangedScmPoPickup({
      requestedPickup: vendor.toUpperCase(),
      currentPickup: "",
      groupRef: "",
      netSuiteAddressVendor: vendor
    }), true);
    assert.equal(scmPoPickupNeedsNetSuiteAddressLookup({
      requestedPickup: vendor,
      currentPickup: "",
      groupRef: ""
    }), true);
    assert.equal(isUnchangedScmPoPickup({
      requestedPickup: vendor,
      currentPickup: "",
      groupRef: "PGOB-LOCKED",
      netSuiteAddressVendor: vendor
    }), false);
    assert.equal(scmPoPickupNeedsNetSuiteAddressLookup({
      requestedPickup: vendor,
      currentPickup: "",
      groupRef: "PGOB-LOCKED"
    }), false);
  }), { numRuns: 200 });
});

test("blank and unrelated pickups are never treated as unchanged", () => {
  fc.assert(fc.property(pickup, pickup, (vendor, unrelated) => {
    fc.pre(vendor.trim().toLowerCase() !== unrelated.trim().toLowerCase());
    assert.equal(isUnchangedScmPoPickup({
      requestedPickup: unrelated,
      currentPickup: "",
      groupRef: "",
      netSuiteAddressVendor: vendor
    }), false);
    assert.equal(
      isUnchangedScmPoPickup({
        requestedPickup: vendor,
        currentPickup: unrelated,
        groupRef: "",
        netSuiteAddressVendor: vendor
      }),
      false,
      "a stored pickup must remain authoritative over the vendor fallback"
    );
    assert.equal(isUnchangedScmPoPickup({
      requestedPickup: "   ",
      currentPickup: vendor,
      netSuiteAddressVendor: vendor
    }), false);
  }), { numRuns: 200 });
});
