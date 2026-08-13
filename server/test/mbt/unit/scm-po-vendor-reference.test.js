import assert from "node:assert/strict";
import test from "node:test";
import { resolveScmVendorReference } from "../../../src/scm-po-vendor-reference.js";

test("non-empty OAuth readback becomes the canonical Vendor reference", () => {
  assert.equal(resolveScmVendorReference({
    snapshotVendorReference: " NETSUITE-NEW ",
    currentVendorReference: "LOCAL-OLD",
    source: "reconciliation"
  }), "NETSUITE-NEW");
});

test("empty automatic OAuth readback preserves an established local reference", () => {
  assert.equal(resolveScmVendorReference({
    snapshotVendorReference: "",
    currentVendorReference: "#0000749961",
    source: "reconciliation"
  }), "#0000749961");
});

test("an explicit application save may replace or clear the Vendor reference", () => {
  assert.equal(resolveScmVendorReference({
    snapshotVendorReference: "UPDATED-REF",
    currentVendorReference: "#0000749961",
    source: "application",
    requestedChanges: { header: { vendorReference: "UPDATED-REF" } }
  }), "UPDATED-REF");
  assert.equal(resolveScmVendorReference({
    snapshotVendorReference: "",
    currentVendorReference: "#0000749961",
    source: "application",
    requestedChanges: { header: { vendorReference: "" } }
  }), "");
});

test("Vendor references are trimmed and bounded to the NetSuite field contract", () => {
  assert.equal(resolveScmVendorReference({
    snapshotVendorReference: ` ${"R".repeat(350)} `
  }).length, 300);
});

test("null OAuth fields and null change envelopes remain safe", () => {
  assert.equal(resolveScmVendorReference({
    snapshotVendorReference: null,
    currentVendorReference: null,
    source: "application",
    requestedChanges: null
  }), "");
  assert.equal(resolveScmVendorReference(), "");
});
