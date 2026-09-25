export const production = [
  "public/operator.js", "public/operator-delivery-refresh.js", "public/operator.html", "public/service-worker.js",
  "src/operator-linked-quantity-domain.js", "src/delivery-repository.js"
];
export const unit = [
  "test/mbt/unit/operator-delivery-reference.test.js", "test/mbt/unit/operator-delivery-refresh.test.js",
  "test/mbt/unit/operator-linked-fulfillment.red.test.js", "test/mbt/property/operator-linked-fulfillment.property.test.js",
  "test/mbt/unit/operator-ui-enhancements.test.js", "test/mbt/unit/operator-performance-regressions.test.js"
];
export const database = [
  "test/mbt/integration/operator-delivery-reference.test.js", "test/mbt/integration/operator-linked-quantity-repository.red.test.js",
  "test/mbt/integration/operator-ui-enhancements.test.js", "test/mbt/integration/group-load-identity.test.js"
];
export const browser = "test/mbt/e2e/operator-delivery-refresh.test.js";
