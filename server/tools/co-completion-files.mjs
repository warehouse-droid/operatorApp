export const production = [
  'src/driver-repository.js',
  'src/server.js',
  'src/dispatch-fulfilled-so-repository.js',
  'src/dispatch-fulfilled-to-repository.js',
  'src/order-dependency-repository.js',
  'src/sales-order-auto-fulfillment-repository.js',
  'migrations/209_driver_co_execution_identity.sql'
];
export const added = ['migrations/209_driver_co_execution_identity.sql'];
export const tests = [
  'test/mbt/unit/co-completion.test.js',
  'test/mbt/property/co-completion.property.test.js',
  'test/mbt/property/co-completion-db.property.test.js',
  'test/mbt/integration/co-completion.test.js',
  'test/mbt/concurrency/co-completion.test.js',
  'test/dispatch/integration/dispatch-co-driver-completion-lifecycle.red.test.js',
  'test/dispatch/integration/dispatch-driver-completion-split-isolation.red.test.js',
  'test/dispatch/unit/dispatch-co-group-identity.red.test.js',
  'test/dispatch/property/dispatch-co-group-identity.property.test.js',
  'test/mbt/unit/driver-consolidated-physical-visit.test.js',
  'test/mbt/integration/dispatch-completion-status.red.test.js',
  'test/mbt/integration/sales-order-auto-fulfillment-admin-http.test.js',
  'test/mbt/integration/sales-order-auto-fulfillment-migration.red.test.js'
];
