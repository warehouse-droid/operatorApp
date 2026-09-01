import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSpecialPurchaseRelease,
  assertSpecialOrderRelease,
  deriveSpecialCaseStage,
  matchSpecialOrderCoverage,
  minimumSpecialCaseRequiredDate,
  normalizeSpecialCaseDraft,
  normalizeSpecialHandoffRoute,
  normalizeSpecialSalesDecision,
  normalizeSpecialSalesOrderDraft,
  normalizeSpecialSupplyResponse,
  normalizeSpecialVendorPickupCompletion,
  specialPurchaseOrderMarker,
  specialSalesOrderMarker
} from "../../../src/special-stock-request-domain.js";

const baseCase = () => ({
  storeLocationId: 1,
  inquiryDate: "2026-08-21",
  customerName: "Landscape Customer",
  customerPhone: "416 555 0100",
  vendorName: "Techo-Bloc",
  requiredDate: "2026-09-01",
  remarks: "Customer is waiting for availability.",
  lines: [
    {
      brand: "TECHO-BLOC",
      productName: "Raffinato wall",
      color: "Caffe Crema",
      size: "180mm",
      quantity: 24,
      uom: "PLT",
      requiredDate: "2026-09-01",
      customerNote: "Full pallets only"
    },
    {
      brand: "TECHO-BLOC",
      productName: "Raffinato cap",
      color: "Caffe Crema",
      size: "60mm",
      quantity: 10,
      uom: "PLT",
      requiredDate: "2026-09-01"
    }
  ]
});

const baseOrderDraft = () => ({
  customerId: 800833,
  operationalYardLocationId: 15,
  fulfillmentMethod: "mbt_delivery",
  deliveryAddress: "37 Sunmount Rd, Scarborough, ON M1T 2A4",
  deliveryDate: "2026-09-10",
  windowStart: "09:00",
  windowEnd: "12:00",
  deliveryInstructions: "Call the site contact before unloading.",
  media: [{ id: "01911111-1111-7111-8111-111111111111", mimeType: "image/jpeg", byteSize: 1024 }],
  materialLines: [{ caseLineId: 1, itemId: 2055, quantity: 768, uom: "PC", rate: 4.25 }],
  ancillaryLines: [{ itemId: 1987, quantity: 1, rate: 250 }]
});

const caseOptions = (authorizedStoreLocationIds = [1]) => ({
  authorizedStoreLocationIds,
  minimumRequiredDate: "2026-08-26"
});

function errorCode(fn, code) {
  assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
}

test("Sales submits one normalized multi-line special case for one vendor", () => {
  const normalized = normalizeSpecialCaseDraft(baseCase(), caseOptions([1, 28]));
  assert.equal(normalized.storeLocationId, 1);
  assert.equal(normalized.vendorName, "Techo-Bloc");
  assert.equal(normalized.lines.length, 2);
  assert.deepEqual(normalized.lines.map((line) => [line.productName, line.quantity, line.uom]), [
    ["Raffinato wall", 24, "PLT"],
    ["Raffinato cap", 10, "PLT"]
  ]);
  assert.equal(normalized.customerPhone, "416 555 0100");
});

test("case validation rejects hostile quantities, unauthorized stores, and missing lines atomically", () => {
  errorCode(
    () => normalizeSpecialCaseDraft({ ...baseCase(), storeLocationId: 15 }, caseOptions()),
    "SPECIAL_CASE_STORE_FORBIDDEN"
  );
  errorCode(
    () => normalizeSpecialCaseDraft({ ...baseCase(), lines: [] }, caseOptions()),
    "SPECIAL_CASE_LINES_INVALID"
  );
  for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_001]) {
    const draft = baseCase();
    draft.lines[0].quantity = quantity;
    errorCode(() => normalizeSpecialCaseDraft(draft, caseOptions()), "SPECIAL_CASE_QUANTITY_INVALID");
  }
});

test("initial lines use only the approved UOMs and a three-working-day minimum", () => {
  assert.equal(minimumSpecialCaseRequiredDate(new Date("2026-08-21T15:00:00.000Z")), "2026-08-26");
  assert.equal(minimumSpecialCaseRequiredDate(new Date("2026-08-23T15:00:00.000Z")), "2026-08-26");
  for (const uom of ["PLT", "LYR", "SEC", "PCS", "EACH"]) {
    const draft = baseCase();
    draft.lines[0].uom = uom;
    assert.equal(normalizeSpecialCaseDraft(draft, {
      authorizedStoreLocationIds: [1], minimumRequiredDate: "2026-08-26"
    }).lines[0].uom, uom);
  }
  const badUom = baseCase();
  badUom.lines[0].uom = "BOX";
  errorCode(() => normalizeSpecialCaseDraft(badUom, {
    authorizedStoreLocationIds: [1], minimumRequiredDate: "2026-08-26"
  }), "SPECIAL_CASE_UOM_INVALID");
  const early = baseCase();
  early.lines[0].requiredDate = "2026-08-25";
  errorCode(() => normalizeSpecialCaseDraft(early, {
    authorizedStoreLocationIds: [1], minimumRequiredDate: "2026-08-26"
  }), "SPECIAL_CASE_REQUIRED_DATE_TOO_SOON");
});

test("case validation covers malformed records, dates, IDs, line caps, and bounded text", () => {
  errorCode(() => normalizeSpecialCaseDraft(null, caseOptions()), "SPECIAL_CASE_INVALID");
  errorCode(() => normalizeSpecialCaseDraft({ ...baseCase(), storeLocationId: 99 }, caseOptions([99])), "SPECIAL_CASE_STORE_INVALID");
  errorCode(() => normalizeSpecialCaseDraft({ ...baseCase(), inquiryDate: "21-Aug-2026" }, caseOptions()), "SPECIAL_CASE_INQUIRY_DATE_INVALID");
  errorCode(() => normalizeSpecialCaseDraft({ ...baseCase(), inquiryDate: "2026-02-30" }, caseOptions()), "SPECIAL_CASE_INQUIRY_DATE_INVALID");
  errorCode(() => normalizeSpecialCaseDraft({ ...baseCase(), lines: [null] }, caseOptions()), "SPECIAL_CASE_LINES_INVALID");
  errorCode(
    () => normalizeSpecialCaseDraft({ ...baseCase(), lines: Array.from({ length: 101 }, () => baseCase().lines[0]) }, caseOptions()),
    "SPECIAL_CASE_LINES_INVALID"
  );
  errorCode(() => normalizeSpecialCaseDraft({ ...baseCase(), remarks: "x".repeat(8_001) }, caseOptions()), "SPECIAL_FIELD_TOO_LONG");
  const withIds = normalizeSpecialCaseDraft({
    ...baseCase(), customerId: 800833, vendorId: 3243, estimateId: 14078
  }, caseOptions());
  assert.deepEqual([withIds.customerId, withIds.vendorId, withIds.estimateId], [800833, 3243, 14078]);
});

test("SCM response models vendor supply without creating an internal transfer", () => {
  const response = normalizeSpecialSupplyResponse({
    supplyStatus: "vendor_transfer",
    availabilityMode: "dated",
    availableDate: "2026-09-05",
    vendorId: 3243,
    vendorName: "Techo-Bloc",
    vendorYard: "TECHO BLOC Vaughan",
    vendorReference: "LOINC-TEST",
    salesVisibleNote: "Vendor is moving stock to Vaughan.",
    scmInternalNote: "Internal purchasing note",
    unitPurchaseCost: 12.5,
    currency: "CAD",
    itemResolution: {
      itemId: 2055,
      itemName: "MBBS-Special Order",
      description: "Raffinato wall Caffe Crema 180mm",
      salesUom: "PC",
      purchaseUom: "PC",
      salesQuantity: 768,
      palletQuantity: 24
    }
  });
  assert.equal(response.supplyStatus, "vendor_transfer");
  assert.equal(response.createsInternalTransfer, false);
  assert.equal(response.availableDate, "2026-09-05");
  assert.equal(response.unitPurchaseCost, 12.5);
  assert.equal(response.itemResolution.itemId, 2055);
});

test("availability requires a coherent date or explicit no-projection mode", () => {
  const base = {
    supplyStatus: "production",
    vendorId: 3243,
    vendorName: "Techo-Bloc",
    vendorYard: "Vaughan",
    itemResolution: {
      itemId: 2055,
      itemName: "MBBS-Special Order",
      description: "Custom item",
      salesUom: "PC",
      purchaseUom: "PC",
      salesQuantity: 10,
      palletQuantity: 1
    }
  };
  errorCode(() => normalizeSpecialSupplyResponse({ ...base, availabilityMode: "dated" }), "SPECIAL_RESPONSE_DATE_REQUIRED");
  const noProjection = normalizeSpecialSupplyResponse({ ...base, availabilityMode: "no_projection" });
  assert.equal(noProjection.availableDate, null);
  errorCode(
    () => normalizeSpecialSupplyResponse({ ...base, availabilityMode: "no_projection", availableDate: "2026-09-01" }),
    "SPECIAL_RESPONSE_DATE_CONFLICT"
  );
  errorCode(() => normalizeSpecialSupplyResponse({ ...base, supplyStatus: "unknown", availabilityMode: "dated", availableDate: "2026-09-01" }), "SPECIAL_RESPONSE_STATUS_INVALID");
  errorCode(() => normalizeSpecialSupplyResponse({ ...base, availabilityMode: "eventually" }), "SPECIAL_RESPONSE_AVAILABILITY_INVALID");
  const firstReply = normalizeSpecialSupplyResponse({
    ...base, availabilityMode: "dated", availableDate: "2026-09-01", itemResolution: null
  });
  assert.equal(firstReply.itemResolution, null);
  errorCode(() => normalizeSpecialSupplyResponse({ ...base, availabilityMode: "dated", availableDate: "2026-09-01", itemResolution: [] }), "SPECIAL_RESPONSE_ITEM_INVALID");
  errorCode(() => normalizeSpecialSupplyResponse({ ...base, availabilityMode: "dated", availableDate: "2026-09-01", unitPurchaseCost: Number.POSITIVE_INFINITY }), "SPECIAL_MONEY_INVALID");
  const noStock = normalizeSpecialSupplyResponse({
    supplyStatus: "no_stock", availabilityMode: "no_projection",
    vendorId: 3243, vendorName: "Techo-Bloc", vendorYard: "Vaughan", itemResolution: null
  });
  assert.equal(noStock.itemResolution, null);
  const converted = normalizeSpecialSupplyResponse({
    ...base, availabilityMode: "dated", availableDate: "2026-09-01",
    itemResolution: { ...base.itemResolution, purchaseQuantity: 12, palletQuantity: null }
  });
  assert.equal(converted.itemResolution.purchaseQuantity, 12);
});

test("Sales decisions are explicit and non-acceptance requires a reason", () => {
  const accepted = normalizeSpecialSalesDecision({
    decision: "accepted",
    customerNote: "Proceed",
    itemResolution: {
      itemId: 2055,
      itemName: "MBBS-SPECIAL",
      description: "Raffinato wall Caffe Crema 180mm",
      salesUom: "PC",
      salesQuantity: 768
    }
  });
  assert.deepEqual(accepted, {
    decision: "accepted",
    customerNote: "Proceed",
    reason: "",
    itemResolution: {
      itemId: 2055,
      itemName: "MBBS-SPECIAL",
      description: "Raffinato wall Caffe Crema 180mm",
      salesUom: "PC",
      purchaseUom: "PC",
      salesQuantity: 768,
      purchaseQuantity: 768,
      palletQuantity: null
    }
  });
  errorCode(() => normalizeSpecialSalesDecision({ decision: "accepted" }), "SPECIAL_DECISION_ITEM_REQUIRED");
  for (const decision of ["request_update", "declined", "closed"]) {
    errorCode(() => normalizeSpecialSalesDecision({ decision }), "SPECIAL_DECISION_REASON_REQUIRED");
    assert.equal(normalizeSpecialSalesDecision({ decision, reason: "Customer requested this." }).decision, decision);
  }
  errorCode(() => normalizeSpecialSalesDecision({ decision: "maybe" }), "SPECIAL_DECISION_INVALID");
});

test("PO release requires durable second-SCM-response evidence on every accepted line", () => {
  const lines = [
    { id: 1, salesDecision: "accepted", responseVendorId: 3243, poReady: true, itemResolution: { itemId: 2055 } },
    { id: 2, salesDecision: "declined", responseVendorId: 3243, poReady: false, itemResolution: null }
  ];
  assert.deepEqual(assertSpecialPurchaseRelease(lines).acceptedLines.map((line) => line.id), [1]);
  errorCode(
    () => assertSpecialPurchaseRelease(lines.map((line) => line.id === 1 ? { ...line, poReady: false } : line)),
    "SPECIAL_PO_SECOND_RESPONSE_REQUIRED"
  );
});

test("all lines resolve before release and only accepted lines enter the SO", () => {
  const lines = [
    { id: 1, salesDecision: "accepted", responseVendorId: 3243, itemResolution: { itemId: 2055 } },
    { id: 2, salesDecision: "declined", responseVendorId: 3243, itemResolution: { itemId: 2055 } },
    { id: 3, salesDecision: "closed", responseVendorId: 3243, itemResolution: { itemId: 5163 } }
  ];
  const released = assertSpecialOrderRelease(lines);
  assert.deepEqual(released.acceptedLines.map((line) => line.id), [1]);
  errorCode(
    () => assertSpecialOrderRelease([...lines, { id: 4, salesDecision: "pending", responseVendorId: 3243 }]),
    "SPECIAL_RELEASE_LINES_PENDING"
  );
  errorCode(
    () => assertSpecialOrderRelease(lines.map((line, index) => ({ ...line, responseVendorId: index ? 330 : 3243 }))),
    "SPECIAL_RELEASE_MIXED_VENDOR"
  );
  errorCode(() => assertSpecialOrderRelease([]), "SPECIAL_RELEASE_LINES_INVALID");
  errorCode(
    () => assertSpecialOrderRelease([{ salesDecision: "declined", responseVendorId: 3243, itemResolution: { itemId: 2055 } }]),
    "SPECIAL_RELEASE_NO_ACCEPTED_LINES"
  );
  errorCode(
    () => assertSpecialOrderRelease([{ salesDecision: "accepted", responseVendorId: 3243, itemResolution: null }]),
    "SPECIAL_RELEASE_ITEM_UNRESOLVED"
  );
});

test("delivery SO draft requires customer, yard, address, date, Toronto window, text, and valid media", () => {
  const input = baseOrderDraft();
  const normalized = normalizeSpecialSalesOrderDraft(input);
  assert.equal(normalized.deliveryDate, "2026-09-10");
  assert.equal(normalized.windowStart, "09:00");
  assert.equal(normalized.windowEnd, "12:00");
  assert.equal(normalized.materialLines[0].caseLineId, 1);
  assert.equal(normalized.ancillaryLines[0].itemId, 1987);

  for (const key of ["deliveryAddress", "deliveryDate", "windowStart", "windowEnd", "deliveryInstructions"]) {
    errorCode(() => normalizeSpecialSalesOrderDraft({ ...input, [key]: "" }), "SPECIAL_SO_DELIVERY_REQUIRED");
  }
  errorCode(
    () => normalizeSpecialSalesOrderDraft({ ...input, windowStart: "13:00", windowEnd: "12:00" }),
    "SPECIAL_SO_WINDOW_INVALID"
  );
  errorCode(() => normalizeSpecialSalesOrderDraft({ ...input, windowStart: "9:00" }), "SPECIAL_SO_WINDOW_INVALID");
});

test("SO draft rejects malformed fulfillment, yard, order-line, and media shapes", () => {
  const input = baseOrderDraft();
  errorCode(() => normalizeSpecialSalesOrderDraft({ ...input, fulfillmentMethod: "courier" }), "SPECIAL_SO_FULFILLMENT_INVALID");
  errorCode(() => normalizeSpecialSalesOrderDraft({ ...input, operationalYardLocationId: 999 }), "SPECIAL_SO_YARD_INVALID");
  errorCode(() => normalizeSpecialSalesOrderDraft({ ...input, materialLines: [] }), "SPECIAL_SO_MATERIAL_LINES_REQUIRED");
  errorCode(() => normalizeSpecialSalesOrderDraft({ ...input, materialLines: [null] }), "SPECIAL_SO_LINE_INVALID");
  errorCode(() => normalizeSpecialSalesOrderDraft({ ...input, materialLines: [input.materialLines[0], input.materialLines[0]] }), "SPECIAL_SO_LINE_DUPLICATE");
  errorCode(() => normalizeSpecialSalesOrderDraft({ ...input, ancillaryLines: {} }), "SPECIAL_SO_LINE_INVALID");
  errorCode(() => normalizeSpecialSalesOrderDraft({ ...input, media: {} }), "SPECIAL_SO_MEDIA_INVALID");
  errorCode(() => normalizeSpecialSalesOrderDraft({ ...input, media: [null] }), "SPECIAL_SO_MEDIA_INVALID");
  errorCode(
    () => normalizeSpecialSalesOrderDraft({ ...input, media: [{ id: "bad", mimeType: "text/plain", byteSize: 0 }] }),
    "SPECIAL_SO_MEDIA_INVALID"
  );
});

test("customer pickup methods do not invent delivery requirements", () => {
  const common = {
    customerId: 800833,
    operationalYardLocationId: 15,
    materialLines: [{ caseLineId: 1, itemId: 2055, quantity: 10, uom: "PC", rate: 4.25 }]
  };
  assert.equal(normalizeSpecialSalesOrderDraft({ ...common, fulfillmentMethod: "vendor_pickup" }).deliveryDate, null);
  assert.equal(normalizeSpecialSalesOrderDraft({ ...common, fulfillmentMethod: "yard_pickup" }).deliveryDate, null);
});

test("case stage is derived from evidence and never hides reconciliation", () => {
  assert.equal(deriveSpecialCaseStage({ submitted: false }), "draft");
  assert.equal(deriveSpecialCaseStage({ submitted: true, hasPendingPurchaseResponse: true }), "awaiting_purchase");
  assert.equal(deriveSpecialCaseStage({ submitted: true, hasPendingSalesDecision: true }), "awaiting_sales");
  assert.equal(deriveSpecialCaseStage({ submitted: true, linesResolved: true, salesOrderId: null }), "awaiting_so");
  assert.equal(deriveSpecialCaseStage({ submitted: true, linesResolved: true, salesOrderId: 10, salesOrderApproved: false }), "awaiting_so_approval");
  assert.equal(deriveSpecialCaseStage({ submitted: true, linesResolved: true, salesOrderId: 10, salesOrderApproved: true }), "awaiting_po");
  assert.equal(deriveSpecialCaseStage({ submitted: true, salesOrderId: 10, salesOrderApproved: true, purchaseOrderId: 20, needsDispatchRoute: true }), "awaiting_route");
  assert.equal(deriveSpecialCaseStage({ submitted: true, purchaseOrderId: 20, operationallyComplete: true, remotelyReconciled: false }), "operationally_complete");
  assert.equal(deriveSpecialCaseStage({ submitted: true, purchaseOrderId: 20, operationallyComplete: true, remotelyReconciled: true }), "completed");
  assert.equal(deriveSpecialCaseStage({ attention: true, operationallyComplete: true }), "attention");
  assert.equal(deriveSpecialCaseStage({ closed: true }), "closed");
  assert.equal(deriveSpecialCaseStage({ purchaseOrderId: 20 }), "in_progress");
});

test("handoff route follows fulfillment constraints", () => {
  assert.deepEqual(normalizeSpecialHandoffRoute({ fulfillmentMethod: "vendor_pickup" }), { required: false, route: "none" });
  assert.deepEqual(normalizeSpecialHandoffRoute({ fulfillmentMethod: "yard_pickup", requestedRoute: "via_yard" }), { required: true, route: "via_yard" });
  errorCode(
    () => normalizeSpecialHandoffRoute({ fulfillmentMethod: "yard_pickup", requestedRoute: "direct" }),
    "SPECIAL_ROUTE_FORBIDDEN"
  );
  assert.equal(normalizeSpecialHandoffRoute({ fulfillmentMethod: "mbt_delivery", requestedRoute: "direct" }).route, "direct");
  assert.equal(normalizeSpecialHandoffRoute({ fulfillmentMethod: "mbt_delivery", requestedRoute: "via_yard" }).route, "via_yard");
  errorCode(() => normalizeSpecialHandoffRoute({ fulfillmentMethod: "courier", requestedRoute: "direct" }), "SPECIAL_ROUTE_FULFILLMENT_INVALID");
  errorCode(() => normalizeSpecialHandoffRoute({ fulfillmentMethod: "mbt_delivery" }), "SPECIAL_ROUTE_REQUIRED");
});

test("manual order coverage is one-to-one and rejects missing or unreviewed lines", () => {
  const expected = [
    { id: 1, itemId: 2055, itemName: "MBBS-Special", description: "Special A", quantity: 10, uom: "PC" },
    { id: 2, itemId: 1987, itemName: "Delivery Charge", description: "Delivery", quantity: 1, uom: "EA" }
  ];
  const canonical = [
    { id: 101, lineId: 9001, itemId: 2055, itemName: "MBBS-Special", description: "MBBS-Special\nSpecial A", quantity: 10, uom: "pc", active: true },
    { id: 102, lineId: 9002, itemId: 1987, itemName: "Delivery Charge", description: "Delivery", quantity: 1, uom: "EA", active: true }
  ];
  assert.deepEqual(matchSpecialOrderCoverage(expected, canonical, { orderKind: "Sales Order" }), [
    { expectedLineId: 1, canonicalLineId: 101, remoteLineId: 9001 },
    { expectedLineId: 2, canonicalLineId: 102, remoteLineId: 9002 }
  ]);
  errorCode(
    () => matchSpecialOrderCoverage(expected, canonical.slice(0, 1), { orderKind: "Sales Order" }),
    "SPECIAL_ORDER_COVERAGE_MISMATCH"
  );
  errorCode(
    () => matchSpecialOrderCoverage(expected.slice(0, 1), canonical, { orderKind: "Sales Order" }),
    "SPECIAL_ORDER_COVERAGE_EXTRA_LINES"
  );
  for (const changed of [
    { quantity: 11 },
    { uom: "EA" },
    { description: "Different reviewed description" }
  ]) {
    errorCode(
      () => matchSpecialOrderCoverage(expected, [{ ...canonical[0], ...changed }, canonical[1]], { orderKind: "Sales Order" }),
      "SPECIAL_ORDER_COVERAGE_MISMATCH"
    );
  }
  errorCode(() => matchSpecialOrderCoverage([], canonical), "SPECIAL_ORDER_DRAFT_REQUIRED");
  const withInactiveExtra = matchSpecialOrderCoverage(expected, [...canonical, {
    id: 103, lineId: 9003, itemId: 9999, quantity: 1, uom: "EA", active: false
  }]);
  assert.equal(withInactiveExtra.length, 2);
  errorCode(
    () => matchSpecialOrderCoverage(expected, [{ ...canonical[0], id: 0 }, canonical[1]]),
    "SPECIAL_ORDER_COVERAGE_MISMATCH"
  );
});

test("Sales vendor-pickup completion requires dated reference evidence", () => {
  assert.deepEqual(normalizeSpecialVendorPickupCompletion({ pickupDate: "2026-08-21", pickupReference: "Customer signature 884" }), {
    pickupDate: "2026-08-21",
    pickupReference: "Customer signature 884"
  });
  errorCode(() => normalizeSpecialVendorPickupCompletion({ pickupDate: "2026-08-21" }), "SPECIAL_VENDOR_PICKUP_REFERENCE_REQUIRED");
});

test("NetSuite markers are stable and type-specific", () => {
  assert.equal(specialSalesOrderMarker(42), "MBBS-SPECIAL-SO:42");
  assert.equal(specialPurchaseOrderMarker(42), "MBBS-SPECIAL-PO:42");
  errorCode(() => specialSalesOrderMarker(0), "SPECIAL_CASE_ID_INVALID");
});
