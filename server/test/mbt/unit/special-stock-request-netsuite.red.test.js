import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSpecialPurchaseOrderPayload,
  buildSpecialSalesOrderPayload,
  selectSpecialMarkerRecord
} from "../../../src/special-stock-request-netsuite.js";

const orderDraft = {
  customerId: 800833,
  operationalYardLocationId: 15,
  fulfillmentMethod: "mbt_delivery",
  deliveryAddress: "37 Sunmount Rd, Scarborough, ON M1T 2A4",
  deliveryDate: "2026-09-10",
  windowStart: "09:00",
  windowEnd: "12:00",
  deliveryInstructions: "Call before unloading.",
  materialLines: [{ caseLineId: 3, itemId: 2055, quantity: 768, uom: "PC", rate: 4.25, description: "Raffinato wall" }],
  ancillaryLines: [{ itemId: 1987, quantity: 1, uom: "EA", rate: 250, description: "Delivery Charge" }]
};

test("standalone SO payload carries marker, exact accepted lines, delivery method, date, and instructions", () => {
  const payload = buildSpecialSalesOrderPayload({
    caseId: 42,
    draft: orderDraft,
    netsuiteLocationId: 10,
    subsidiaryId: 2,
    deliveryMethodId: 2
  });
  assert.equal(payload.entity.id, "800833");
  assert.equal(payload.location.id, "10");
  assert.equal(payload.custbody3.id, "2");
  assert.equal(payload.custbody4, "2026-09-10");
  assert.match(payload.custbody7, /Delivery Address: 37 Sunmount Rd[\s\S]*Delivery Date: 2026-09-10[\s\S]*09:00-12:00[\s\S]*Call before unloading\./u);
  assert.equal(payload.shipOverride, true);
  assert.deepEqual(payload.shippingAddress, {
    override: true,
    addrText: "37 Sunmount Rd, Scarborough, ON M1T 2A4"
  });
  assert.equal(Object.hasOwn(payload, "shipAddress"), false);
  assert.match(payload.memo, /MBBS-SPECIAL-SO:42/u);
  assert.deepEqual(payload.item.items.map((line) => line.item.id), ["2055", "1987"]);
});

test("PO payload uses the same yard and only the exact material mappings", () => {
  const payload = buildSpecialPurchaseOrderPayload({
    caseId: 42,
    vendorId: 3243,
    netsuiteLocationId: 10,
    subsidiaryId: 2,
    lines: [{ itemId: 2055, quantity: 768, rate: 2.1, description: "Raffinato wall" }]
  });
  assert.equal(payload.entity.id, "3243");
  assert.equal(payload.item.items.length, 1);
  assert.match(payload.memo, /MBBS-SPECIAL-PO:42/u);
});

test("pickup payload and remote payload validation fail closed", () => {
  const pickup = buildSpecialSalesOrderPayload({
    caseId: 43,
    draft: { ...orderDraft, fulfillmentMethod: "vendor_pickup", materialLines: orderDraft.materialLines, ancillaryLines: [] },
    netsuiteLocationId: 10,
    pickupMethodId: 4
  });
  assert.equal(pickup.custbody3.id, "4");
  assert.equal(Object.hasOwn(pickup, "shippingAddress"), false);
  assert.equal(Object.hasOwn(pickup, "subsidiary"), false);
  assert.throws(
    () => buildSpecialSalesOrderPayload({ caseId: 43, draft: orderDraft, netsuiteLocationId: 10 }),
    (error) => error?.code === "SPECIAL_REMOTE_CONFIGURATION_MISSING"
  );
  assert.throws(
    () => buildSpecialSalesOrderPayload({ caseId: 43, draft: { ...orderDraft, materialLines: [], ancillaryLines: [] }, netsuiteLocationId: 10, deliveryMethodId: 2 }),
    (error) => error?.code === "SPECIAL_REMOTE_PAYLOAD_INVALID"
  );
  assert.throws(
    () => buildSpecialSalesOrderPayload({ caseId: 43, draft: { ...orderDraft, materialLines: [{ itemId: 2055, quantity: 0 }] }, netsuiteLocationId: 10, deliveryMethodId: 2 }),
    (error) => error?.code === "SPECIAL_REMOTE_PAYLOAD_INVALID"
  );
  assert.throws(
    () => buildSpecialPurchaseOrderPayload({ caseId: 43, vendorId: null, netsuiteLocationId: 10, lines: orderDraft.materialLines }),
    (error) => error?.code === "SPECIAL_REMOTE_CONFIGURATION_MISSING"
  );
  assert.throws(
    () => buildSpecialPurchaseOrderPayload({ caseId: 43, vendorId: 3243, netsuiteLocationId: 10, lines: [] }),
    (error) => error?.code === "SPECIAL_REMOTE_PAYLOAD_INVALID"
  );
  const cost = buildSpecialPurchaseOrderPayload({
    caseId: 43, vendorId: 3243, netsuiteLocationId: 10,
    lines: [{ itemId: 2055, quantity: 1, rate: 999, unitPurchaseCost: 12.5 }]
  });
  assert.equal(cost.item.items[0].rate, 12.5);
});

test("marker recovery refuses ambiguous or wrong-entity results", () => {
  assert.equal(selectSpecialMarkerRecord([], { marker: "M" }), null);
  assert.equal(selectSpecialMarkerRecord([{ id: "9", entity_id: "3243" }], { marker: "M", entityId: 3243 }).id, 9);
  assert.throws(
    () => selectSpecialMarkerRecord([{ id: 9 }, { id: 10 }], { marker: "M" }),
    (error) => error?.code === "SPECIAL_REMOTE_MARKER_DUPLICATE"
  );
  assert.throws(
    () => selectSpecialMarkerRecord([{ id: 9, entity_id: 99 }], { marker: "M", entityId: 3243 }),
    (error) => error?.code === "SPECIAL_REMOTE_MARKER_MISMATCH"
  );
  assert.throws(
    () => selectSpecialMarkerRecord([{ id: "invalid", entity_id: 3243 }], { marker: "M", entityId: 3243 }),
    (error) => error?.code === "SPECIAL_REMOTE_MARKER_INVALID"
  );
  assert.throws(
    () => selectSpecialMarkerRecord([{ id: 9, entity_id: 3243, location_id: 99 }], { marker: "M", entityId: 3243, locationId: 10 }),
    (error) => error?.code === "SPECIAL_REMOTE_MARKER_MISMATCH"
  );
});
