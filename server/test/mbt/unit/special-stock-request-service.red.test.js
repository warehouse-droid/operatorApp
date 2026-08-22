import assert from "node:assert/strict";
import test from "node:test";

import { createSpecialStockRequestService } from "../../../src/special-stock-request-service.js";

function caseDetail(overrides = {}) {
  return {
    id: 42,
    revision: 7,
    customerId: 800833,
    vendorId: 3243,
    vendorName: "Techo-Bloc",
    operationalYardLocationId: 15,
    storeName: "12441",
    fulfillmentMethod: "yard_pickup",
    estimateId: null,
    deliveryAddress: "",
    deliveryDate: null,
    windowStart: null,
    windowEnd: null,
    deliveryInstructions: "",
    salesOrderLines: [{ caseLineId: 1, itemId: 2055, quantity: 10, uom: "PC", rate: 4.25, description: "Special" }],
    purchaseOrderLines: [{ caseLineId: 1, itemId: 2055, quantity: 10, uom: "PC", unitPurchaseCost: 2.1, description: "Special" }],
    ...overrides
  };
}

function harness({ markerRows = [], createResult = { id: 91 }, detail = caseDetail() } = {}) {
  const calls = [];
  let current = detail;
  const service = createSpecialStockRequestService({
    getCase: async () => current,
    claimOperation: async (_id, input) => {
      calls.push(["claim", input]);
      current = { ...current, revision: current.revision + 1, [`${input.orderKind === "sales_order" ? "salesOrder" : "purchaseOrder"}OperationId`]: input.operationId };
      return current;
    },
    linkSalesOrder: async (_id, input) => {
      calls.push(["link-so", input]);
      current = { ...current, revision: current.revision + 1, salesOrderId: input.salesOrderId, salesOrderRef: input.salesOrderRef };
      return current;
    },
    linkPurchaseOrder: async (_id, input) => {
      calls.push(["link-po", input]);
      current = { ...current, revision: current.revision + 1, purchaseOrderId: input.purchaseOrderId, purchaseOrderRef: input.purchaseOrderRef };
      return current;
    },
    failOperation: async (_id, input) => calls.push(["fail", input]),
    resolveLocations: async () => [{ localLocationId: 15, netsuiteLocationId: 10, subsidiaryId: 2 }],
    findMarkerOrders: async () => markerRows,
    createSalesOrder: async (payload) => {
      calls.push(["create-so", payload]);
      return createResult;
    },
    transformEstimate: async (_id, payload) => {
      calls.push(["transform-so", payload]);
      return createResult;
    },
    createPurchaseOrder: async (payload) => {
      calls.push(["create-po", payload]);
      return createResult;
    },
    fetchSalesOrderReference: async (id) => ({ id, tranid: `SO${id}`, status_text: "Pending Fulfillment" }),
    fetchPurchaseOrderReference: async (id) => ({ id, tranid: `PO${id}`, status_text: "Pending Receipt" }),
    recordPurchaseOrderCreation: async (input, operatorId) => calls.push(["record-po-history", input, operatorId]),
    config: { subsidiaryId: "2", deliveryMethodId: "2", pickupMethodId: "1" },
    sleep: async () => {}
  });
  return { service, calls };
}

test("SO execution recovers marker before create and never submits a duplicate", async () => {
  const { service, calls } = harness({ markerRows: [{ id: 88, tranid: "SO88", entity_id: 800833, location_id: 10 }] });
  const result = await service.createSalesOrder(42, { expectedRevision: 7, operationId: "01911111-1111-7111-8111-111111111111", source: "standalone" }, { operatorId: "sales" });
  assert.equal(result.salesOrderId, 88);
  assert.equal(calls.some(([name]) => name === "create-so"), false);
  assert.equal(calls.filter(([name]) => name === "link-so").length, 1);
});

test("standalone and estimate SO paths share exact payload but use different remote operations", async () => {
  const standalone = harness();
  await standalone.service.createSalesOrder(42, { expectedRevision: 7, operationId: "01911111-1111-7111-8111-111111111112", source: "standalone" }, { operatorId: "sales" });
  assert.equal(standalone.calls.filter(([name]) => name === "create-so").length, 1);

  const transformed = harness({ detail: caseDetail({ estimateId: 777 }) });
  await transformed.service.createSalesOrder(42, { expectedRevision: 7, operationId: "01911111-1111-7111-8111-111111111113", source: "estimate_transform" }, { operatorId: "sales" });
  assert.equal(transformed.calls.filter(([name]) => name === "transform-so").length, 1);
  assert.equal(transformed.calls.filter(([name]) => name === "create-so").length, 0);
});

test("PO executes only after approved SO and uses purchase costs", async () => {
  const { service, calls } = harness({ detail: caseDetail({ salesOrderId: 80, salesOrderApproved: true }) });
  const result = await service.createPurchaseOrder(42, { expectedRevision: 7, operationId: "01911111-1111-7111-8111-111111111114" }, { operatorId: "scm" });
  assert.equal(result.purchaseOrderId, 91);
  const payload = calls.find(([name]) => name === "create-po")[1];
  assert.equal(payload.item.items[0].rate, 2.1);
  const history = calls.find(([name]) => name === "record-po-history");
  assert.equal(history[1].creationSnapshot.requestId, 42);
  assert.equal(history[2], "scm");
});

test("uncertain remote result is marked attention and is never blindly resubmitted in the same call", async () => {
  const { service, calls } = harness({ createResult: {} });
  await assert.rejects(
    () => service.createSalesOrder(42, { expectedRevision: 7, operationId: "01911111-1111-7111-8111-111111111115", source: "standalone" }, { operatorId: "sales" }),
    (error) => error?.code === "SPECIAL_REMOTE_OUTCOME_UNCERTAIN"
  );
  assert.equal(calls.filter(([name]) => name === "create-so").length, 1);
  assert.equal(calls.filter(([name]) => name === "fail").length, 1);
});
