export const existing = [
  "public/operator.html", "public/service-worker.js", "public/mbt-gates.html",
  "src/consolidation-load-domain.js",
  "src/delivery-repository.js",
  "src/netsuite.js",
  "src/operator-yard-access.js",
  "src/operator-yard-authorization.js",
  "src/operator-netsuite-posting-targets.js",
  "src/operator-netsuite-posting-controller.js",
  "src/server.js",
  "src/sales-order-reload-repository.js",
  "src/operator-netsuite-posting-netsuite-adapter.js",
  "src/operator-netsuite-posting-service.js",
  "src/operator-netsuite-posting-finalizer.js",
  "src/operator-netsuite-posting-repository.js",
  "src/sales-order-auto-fulfillment-netsuite-adapter.js",
  "src/sales-order-auto-fulfillment-service.js",
  "src/sales-order-auto-fulfillment-repository.js",
  "src/sales-order-auto-fulfillment-domain.js",
  "public/operator.js",
  "public/mbt-gates.js"
];
export const added = [
  "src/outbound-location-domain.js",
  "src/outbound-location-runtime.js",
  "src/item-fulfillment-parts-domain.js",
  "src/item-fulfillment-parts-service.js",
  "src/item-fulfillment-parts-repository.js",
  "migrations/208_child_location_fulfillment.sql"
];
export const files = [...existing, ...added];
