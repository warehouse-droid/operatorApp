// @ts-check

/**
 * The explicit Phase 3 mutation inventory. The extended runner also scans the
 * support directory and fails when a dedicated runner is present on disk but
 * absent here, so new mutation packets cannot silently escape the gauntlet.
 */
export const P3_DEDICATED_MUTATION_RUNNERS = Object.freeze([
  Object.freeze({
    runner: "run-dispatch-active-load-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "src/dispatch-load-assignment.js",
      "public/dispatch.js"
    ])
  }),
  Object.freeze({
    runner: "run-dispatch-performance-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze(["src/dispatch-planner-performance.js"])
  }),
  Object.freeze({
    runner: "run-frontdesk-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze(["src/mbt/frontdesk-service.js"])
  }),
  Object.freeze({
    runner: "run-p310-adversarial-mutations.mjs",
    adminUrlEnvironment: "MBT_P310_MUTATION_ADMIN_URL",
    sourcePaths: Object.freeze([
      "src/mbt/local-billing-calculator.js",
      "src/mbt/shadow-billing-service.js"
    ])
  }),
  Object.freeze({
    runner: "run-p310-reconciliation-mutations.mjs",
    adminUrlEnvironment: "MBT_P310_MUTATION_ADMIN_URL",
    sourcePaths: Object.freeze(["src/mbt/pilot-reconciliation-service.js"])
  }),
  Object.freeze({
    runner: "run-p311-mutations.mjs",
    adminUrlEnvironment: "MBT_P311_MUTATION_ADMIN_URL",
    sourcePaths: Object.freeze([
      "src/dispatch-plan-repository.js",
      "src/driver-repository.js",
      "src/mbt/bin-dispatch-service.js",
      "src/mbt/shadow-billing-service.js",
      "src/server.js"
    ])
  }),
  Object.freeze({
    runner: "run-p35a-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "src/mbt/asset-csv-import-service.js",
      "src/mbt/asset-csv-import.js",
      "src/mbt/router.js"
    ])
  }),
  Object.freeze({
    runner: "run-p35a-ui-mutation.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze(["public/mbt-assets.js"])
  }),
  Object.freeze({
    runner: "run-p38-mutations.mjs",
    adminUrlEnvironment: "MBT_P38_MUTATION_ADMIN_URL",
    sourcePaths: Object.freeze(["src/mbt/bin-dispatch-service.js"])
  }),
  Object.freeze({
    runner: "run-p39-client-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "public/driver-bin-ui.js",
      "public/driver.js"
    ])
  }),
  Object.freeze({
    runner: "run-p39-mutations.mjs",
    adminUrlEnvironment: "MBT_P39_MUTATION_ADMIN_URL",
    sourcePaths: Object.freeze([
      "migrations/120_mbt_p3_driver_clock_evidence.sql",
      "src/mbt/driver-bin-contract.js",
      "src/mbt/driver-bin-execution-service.js"
    ])
  }),
  Object.freeze({
    runner: "run-p39-reservation-mutations.mjs",
    adminUrlEnvironment: "MBT_P39_MUTATION_ADMIN_URL",
    sourcePaths: Object.freeze([
      "src/mbt/asset-service.js",
      "src/mbt/bin-dispatch-service.js"
    ])
  }),
  Object.freeze({
    runner: "run-test-database-isolation-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze(["test/support/test-database-isolation.mjs"])
  })
]);
