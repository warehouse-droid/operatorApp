// @ts-check

/**
 * The explicit Phase 3 mutation inventory. The extended runner also scans the
 * support directory and fails when a dedicated runner is present on disk but
 * absent here, so new mutation packets cannot silently escape the gauntlet.
 */
export const P3_DEDICATED_MUTATION_RUNNERS = Object.freeze([
  Object.freeze({
    runner: "run-auto-transfer-auto-approval-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "public/scm-transfer-dependencies.js",
      "src/auto-transfer-approval-policy.js",
      "src/order-dependency-repository.js",
      "src/server.js",
      "src/transfer-dependency-netsuite.js"
    ])
  }),
  Object.freeze({
    runner: "run-customer-charge-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "src/mbt/customer-charge-calculator.js",
      "src/mbt/customer-charge-request-service.js"
    ])
  }),
  Object.freeze({
    runner: "run-delivery-instruction-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "public/driver-offline-db.js",
      "public/driver.js",
      "src/delivery-instruction-domain.js",
      "src/delivery-instruction-repository.js",
      "src/driver-offline-repository.js"
    ])
  }),
  Object.freeze({
    runner: "run-dispatch-active-load-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "src/dispatch-load-assignment.js",
      "public/dispatch.js"
    ])
  }),
  Object.freeze({
    runner: "run-dispatch-co-lifecycle-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "public/dispatch.js",
      "src/dispatch-co-lifecycle.js",
      "src/dispatch-co-recovery.js",
      "src/dispatch-plan-repository.js",
      "src/dispatch-repository.js"
    ])
  }),
  Object.freeze({
    runner: "run-dispatch-driver-completion-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze(["src/dispatch-history-mode.js"])
  }),
  Object.freeze({
    runner: "run-dispatch-load-reorder-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze(["public/dispatch.js"])
  }),
  Object.freeze({
    runner: "run-dispatch-order-completion-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "migrations/159_dispatch_order_completion_status.sql",
      "public/dispatch.js",
      "src/dispatch-completion-repository.js",
      "src/mbt/mbbs-billing-candidate-service.js",
      "src/server.js"
    ])
  }),
  Object.freeze({
    runner: "run-dispatch-performance-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze(["src/dispatch-planner-performance.js"])
  }),
  Object.freeze({
    runner: "run-dispatch-planner-optimization-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "src/dispatch-planner-optimization.js",
      "src/dispatch-planner-replay.js"
    ])
  }),
  Object.freeze({
    runner: "run-dispatch-po-route-residual-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "src/dispatch-load-assignment.js",
      "src/dispatch-po-route-projection.js",
      "src/driver-repository.js",
      "src/scm-dependency-plan-reconciler.js"
    ])
  }),
  Object.freeze({
    runner: "run-dispatch-runtime-resilience-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "public/dispatch.js",
      "public/service-worker.js"
    ])
  }),
  Object.freeze({
    runner: "run-dispatch-save-recovery-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "public/dispatch.js",
      "src/dispatch-plan-repository.js",
      "src/dispatch-planner-v2-repository.js",
      "src/server.js"
    ])
  }),
  Object.freeze({
    runner: "run-dispatch-v2-summary-marker-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "src/dispatch-plan-repository.js",
      "src/dispatch-planner-v2-repository.js"
    ])
  }),
  Object.freeze({
    runner: "run-driver-offline-stress-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze(["test/support/driver-offline-stress-model.mjs"])
  }),
  Object.freeze({
    runner: "run-driver-plan-date-execution-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "public/driver.js",
      "src/driver-plan-date-policy.js",
      "src/driver-repository.js",
      "src/server.js"
    ])
  }),
  Object.freeze({
    runner: "run-driver-pwa-historical-assist-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "src/driver-historical-assist-evidence.js",
      "src/driver-historical-assist-policy.js"
    ])
  }),
  Object.freeze({
    runner: "run-driver-pwa-site-reset-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "public/driver-reset.html",
      "public/driver.js",
      "src/server.js"
    ])
  }),
  Object.freeze({
    runner: "run-frontdesk-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze(["src/mbt/frontdesk-service.js"])
  }),
  Object.freeze({
    runner: "run-mbbs-cross-charge-v4-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "src/mbt/distance-band-pricing.js",
      "src/mbt/local-billing-calculator.js",
      "src/mbt/mbbs-billing-candidate-service.js",
      "src/mbt/mbbs-driver-billing-planner.js",
      "src/mbt/mbbs-rate-card-policy.js"
    ])
  }),
  Object.freeze({
    runner: "run-mbbs-vendor-route-rate-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "public/mbt-billing.js",
      "src/mbt/mbbs-billing-candidate-service.js",
      "src/mbt/mbbs-vendor-route-rates.js",
      "src/mbt/shadow-billing-service.js"
    ])
  }),
  Object.freeze({
    runner: "run-netsuite-delayed-status-refresh-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "src/netsuite-delayed-status-refresh-policy.js",
      "src/netsuite-delayed-status-refresh-service.js"
    ])
  }),
  Object.freeze({
    runner: "run-netsuite-m2m-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "src/netsuite-m2m-auth.js",
      "src/netsuite-m2m-settings.js",
      "src/pending-approval-reconciliation-repository.js",
      "src/pending-approval-reconciliation.js"
    ])
  }),
  Object.freeze({
    runner: "run-operator-customer-pickup-photo-gate-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "migrations/165_operator_customer_pickup_photo_gate.sql",
      "public/operator.js",
      "src/delivery-repository.js",
      "src/operator-customer-pickup-photo-policy.js",
      "src/server.js"
    ])
  }),
  Object.freeze({
    runner: "run-operator-linked-fulfillment-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "migrations/180_sales_order_completion_fulfillment.sql",
      "src/delivery-repository.js",
      "src/operator-linked-quantity-domain.js",
      "src/operator-netsuite-posting-admission.js",
      "src/operator-netsuite-posting-targets.js",
      "src/sales-order-auto-fulfillment-domain.js",
      "src/sales-order-auto-fulfillment-netsuite-adapter.js",
      "src/sales-order-auto-fulfillment-repository.js",
      "src/sales-order-auto-fulfillment-service.js"
    ])
  }),
  Object.freeze({
    runner: "run-operator-netsuite-posting-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "migrations/178_operator_netsuite_posting_gates.sql",
      "src/operator-netsuite-posting-adapter.js",
      "src/operator-netsuite-posting-admission.js",
      "src/operator-netsuite-posting-domain.js",
      "src/operator-netsuite-posting-finalizer.js",
      "src/operator-netsuite-posting-policy.js",
      "src/operator-netsuite-posting-repository.js",
      "src/operator-netsuite-posting-runtime.js",
      "src/operator-netsuite-posting-service.js",
      "src/operator-netsuite-posting-targets.js",
      "src/server.js"
    ])
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
    runner: "run-scm-dependency-management-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "src/driver-offline-repository.js",
      "src/driver-offline-service.js",
      "src/scm-dependency-command-service.js",
      "src/scm-dependency-management-policy.js",
      "src/scm-dependency-plan-reconciler.js"
    ])
  }),
  Object.freeze({
    runner: "run-scm-po-split-ref-reuse-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze(["src/dispatch-repository.js"])
  }),
  Object.freeze({
    runner: "run-scm-po-split-ui-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "public/dispatch-scm.html",
      "public/dispatch-scm.js"
    ])
  }),
  Object.freeze({
    runner: "run-scm-schedule-status-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "public/dispatch-scm.js",
      "public/scm-schedule.js",
      "src/dispatch-repository.js",
      "src/server.js"
    ])
  }),
  Object.freeze({
    runner: "run-smart-scm-blanket-merge-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze(["src/smart-scm-blanket-repository.js"])
  }),
  Object.freeze({
    runner: "run-smart-scm-manual-controls-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "public/scm-smart.js",
      "public/scm-smart-proposals.js",
      "public/scm-smart-blanket.js",
      "public/scm-smart-vendor.js",
      "src/smart-scm-planning-repository.js",
      "src/smart-scm-blanket-repository.js"
    ])
  }),
  Object.freeze({
    runner: "run-smart-scm-po-oauth-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "migrations/148_scm_po_history_line_financial_backfill.sql",
      "public/scm-netsuite-po.js",
      "public/scm-smart-blanket.js",
      "public/scm-smart-vendor.js",
      "src/order-sync-repository.js",
      "src/scm-netsuite-po-history-repository.js",
      "src/scm-po-vendor-reference.js",
      "src/smart-scm-purchase-netsuite.js",
      "src/smart-scm-vendor-financials.js"
    ])
  }),
  Object.freeze({
    runner: "run-smart-scm-vendor-unit-price-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "public/scm-smart-vendor.js",
      "src/smart-scm-blanket-repository.js",
      "src/smart-scm-vendor-repository.js",
      "src/smart-scm-vendor-unit-price-repository.js",
      "src/smart-scm-vendor-unit-price.js"
    ])
  }),
  Object.freeze({
    runner: "run-special-stock-request-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "src/special-stock-request-domain.js",
      "src/special-stock-request-netsuite.js",
      "src/special-stock-request-policy.js",
      "src/special-stock-request-repository.js"
    ])
  }),
  Object.freeze({
    runner: "run-stock-request-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "public/sales-stock-requests.js",
      "src/mbt/feature-gate-catalog.js",
      "src/stock-request-domain.js",
      "src/stock-request-policy.js",
      "src/stock-request-repository.js",
      "src/stock-request-service.js"
    ])
  }),
  Object.freeze({
    runner: "run-test-database-isolation-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze(["test/support/test-database-isolation.mjs"])
  }),
  Object.freeze({
    runner: "run-transfer-dependency-source-backorder-mutations.mjs",
    adminUrlEnvironment: null,
    sourcePaths: Object.freeze([
      "migrations/170_transfer_dependency_source_backorder.sql",
      "public/scm-transfer-dependencies.js",
      "src/order-dependency-repository.js",
      "src/transfer-dependency-source-backorder.js"
    ])
  })
]);
