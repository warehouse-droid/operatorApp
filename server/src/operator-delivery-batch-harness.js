import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [operator, deliveryRepository] = await Promise.all([
  readFile(new URL("../public/operator.js", import.meta.url), "utf8"),
  readFile(new URL("delivery-repository.js", import.meta.url), "utf8")
]);

const classifierStart = operator.indexOf("function deliveryBatchForOrder");
const classifierEnd = operator.indexOf("function filteredDeliveryOrders", classifierStart);
assert.ok(classifierStart >= 0 && classifierEnd > classifierStart,
  "Operator delivery batch helpers must remain available for focused regression testing.");

const classifierSource = operator.slice(classifierStart, classifierEnd);
const createClassifier = Function("isVrmaOrder", "isBatchAOrder", `
  let deliveryPrepMode = "standard";
  let viewMode = "active";
  let deliveryBatchFilter = "batch_a";
  ${classifierSource}
  return { deliveryBatchForOrder, deliveryBatchForNotification, orderMatchesDeliveryBatch };
`);
const classifier = createClassifier(
  (order) => order?.order_type === "vrma_order",
  (order) => order?.testBatchA === true
);

const filters = ["planned", "batch_a", "batch_b", "transfer"];
const matchingFilters = (order) => filters.filter((filter) => classifier.orderMatchesDeliveryBatch(order, filter));

const plannedSalesOrder = { order_type: "sales_order", dispatch_planned: true, testBatchA: true };
assert.equal(classifier.deliveryBatchForOrder(plannedSalesOrder), "planned");
assert.deepEqual(matchingFilters(plannedSalesOrder), ["planned"],
  "A planned Sales Order must appear only in Planned.");

const plannedTransferOrder = { order_type: "transfer_order", dispatch_planned: true };
assert.equal(classifier.deliveryBatchForOrder(plannedTransferOrder), "planned");
assert.deepEqual(matchingFilters(plannedTransferOrder), ["planned"],
  "A planned Transfer Order must move to Planned and leave the unplanned TO batch.");

const unplannedTransferOrder = { order_type: "transfer_order", dispatch_planned: false };
assert.equal(classifier.deliveryBatchForOrder(unplannedTransferOrder), "transfer");
assert.deepEqual(matchingFilters(unplannedTransferOrder), ["transfer"],
  "An unplanned Transfer Order must remain in TO.");

const dependentBackorderSalesOrder = {
  order_type: "sales_order",
  dispatch_planned: false,
  testBatchA: true,
  direct_pickup_only: true,
  netsuite_backordered_qty: 10,
  has_remaining_qty: false
};
assert.equal(classifier.deliveryBatchForOrder(dependentBackorderSalesOrder), "batch_a");
assert.deepEqual(matchingFilters(dependentBackorderSalesOrder), ["batch_a"],
  "A backordered/dependency Sales Order must remain eligible for one Delivery Prep batch.");

assert.equal(classifier.deliveryBatchForNotification({ type: "transfer_order", dispatchPlanned: true }), "planned",
  "Opening a planned TO alert must route to Planned.");
assert.equal(classifier.deliveryBatchForNotification({ type: "transfer_order", dispatchPlanned: false }), "transfer",
  "Opening an unplanned TO alert must route to TO.");
assert.equal(classifier.deliveryBatchForNotification({ type: "sales_order", dispatchPlanned: true }), "planned",
  "Opening a planned SO alert must route to Planned.");
assert.ok(operator.includes("const batch = deliveryBatchForNotification(first);"),
  "Urgent delivery alerts must compute their shared batch-routing rule first.");
const alertStart = operator.indexOf("async function openUrgentDeliveryAlert");
const alertEnd = operator.indexOf("async function loadReceivingOptions", alertStart);
const alertSource = operator.slice(alertStart, alertEnd);
assert.ok(alertSource.includes('deliveryOrderType = batch === "transfer" ? "transfer_order" : "sales_order";')
  && alertSource.includes("deliveryBatchFilter = batch;"),
"A planned TO alert must open the mixed Planned batch without leaving transfer-only UI state.");

assert.ok(operator.includes('if (deliveryPrepMode === "standard" && viewMode === "active" && deliveryBatchFilter === "planned")'),
  "The mixed Planned list must use planned-order sorting independent of the legacy order-type state.");
const subtitleStart = operator.indexOf("function deliveryScreenSubtitle");
const subtitleEnd = operator.indexOf("function deliveryScreenActions", subtitleStart);
const subtitleSource = operator.slice(subtitleStart, subtitleEnd);
assert.ok(subtitleSource.includes('deliveryBatchFilter === "planned"')
  && subtitleSource.includes('t("operator.salesTransferOrders", "Sales Order + Transfer Order")'),
"The Planned subtitle must describe its mixed Sales Order and Transfer Order contents.");


assert.ok(deliveryRepository.includes("direct_dependency_orders AS ("),
  "Delivery Prep must retain the active direct-dependency order set.");
assert.ok(deliveryRepository.includes("AND (${hasRemainingQty} OR ${hasPackedQty} OR ${hasProgressQty} OR ${hasDirectDependency})"),
  "A fully allocated backordered SO must remain eligible through its active dependency.");

console.log("Operator Delivery Prep batch classification harness passed.");
