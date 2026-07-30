import assert from "node:assert/strict";
import {
  verifyMissingScmPurchaseOrderInNetSuite
} from "./scm-reconciliation-service.js";

const source = {
  id: 987654,
  kind: "PO",
  tranid: "POB-VERIFY-987654"
};

const calls = [];
const absent = await verifyMissingScmPurchaseOrderInNetSuite(source, {
  async fetchOrders(options) {
    calls.push({ method: "lines", options });
    return [];
  },
  async fetchHeader(orderId, recordType) {
    calls.push({ method: "header", orderId, recordType });
    return null;
  },
  async fetchReference(orderRef, recordType) {
    calls.push({ method: "reference", orderRef, recordType });
    return null;
  }
});
assert.equal(absent.orderKind, "PO");
assert.equal(absent.sourceOrderId, source.id);
assert.equal(absent.sourceOrderRef, source.tranid);
assert.equal(absent.lineQueryFound, false);
assert.equal(absent.headerQueryFound, false);
assert.equal(absent.referenceQueryFound, false);
assert.deepEqual(calls.map((call) => call.method), ["lines", "header", "reference"]);
assert.deepEqual(calls[0].options.orderIds, [source.id]);
assert.equal(calls[0].options.targetOnly, true);
assert.equal(calls[1].recordType, "PurchOrd");
assert.equal(calls[2].orderRef, source.tranid);

await assert.rejects(
  verifyMissingScmPurchaseOrderInNetSuite(source, {
    async fetchOrders() {
      return [{
        id: source.id,
        kind: "PO",
        tranid: source.tranid,
        status: "B",
        statusText: "Purchase Order : Pending Receipt",
        lines: []
      }];
    },
    async fetchHeader() {
      return null;
    },
    async fetchReference() {
      return null;
    }
  }),
  (error) =>
    error?.code === "SCM_RECONCILIATION_SOURCE_VISIBLE"
    && error?.verification?.lineQueryFound === true
);

await assert.rejects(
  verifyMissingScmPurchaseOrderInNetSuite(source, {
    async fetchOrders() {
      return [];
    },
    async fetchHeader() {
      return {
        id: source.id,
        tranid: source.tranid,
        status: "H",
        status_text: "Closed"
      };
    },
    async fetchReference() {
      return null;
    }
  }),
  (error) =>
    error?.code === "SCM_RECONCILIATION_SOURCE_VISIBLE"
    && error?.verification?.headerQueryFound === true
);

await assert.rejects(
  verifyMissingScmPurchaseOrderInNetSuite(source, {
    async fetchOrders() {
      return [];
    },
    async fetchHeader() {
      return null;
    },
    async fetchReference() {
      return {
        id: source.id + 1,
        tranid: source.tranid,
        status: "B",
        status_text: "Purchase Order : Pending Receipt"
      };
    }
  }),
  (error) =>
    error?.code === "SCM_RECONCILIATION_SOURCE_VISIBLE"
    && error?.verification?.referenceQueryFound === true
);

console.log("SCM source-missing cancellation service harness passed.");
