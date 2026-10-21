import base from "../eslint.mbt.config.js";
export default [...base, {
  files: ["test/dispatch/frontend/dispatch-source-decision.browser.test.mjs"],
  languageOptions: { ...base[1].languageOptions, globals: { ...base[1].languageOptions.globals,
    orders: "writable", orderCatalog: "writable", trucks: "writable", fleet: "writable",
    currentPlanDate: "writable", currentPlan: "writable", dispatchConfig: "writable",
    dispatchSetupLoaded: "writable", dispatchPlannerSnapshotState: "writable", planEditMode: "writable",
    planEditLeaseToken: "writable", planEditLease: "writable", localPlanDirty: "writable",
    normalizeOrder: "readonly", todayLocalDate: "readonly", dispatchSessionId: "readonly",
    render: "readonly", loadExecutedOrderReviews: "readonly", renderDispatchNoticePatch: "readonly",
    saveCurrentPlanNow: "readonly" } },
  rules: base[1].rules
}, {
  files: ["src/dispatch-executed-order-review*.js", "src/server.js"],
  languageOptions: base[0].languageOptions,
  rules: { "no-duplicate-imports": "error", "no-undef": "error", "no-unreachable": "error",
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "no-var": "error", "prefer-const": "error" }
}];
