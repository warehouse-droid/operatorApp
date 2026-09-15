import base from "../../eslint.mbt.config.js";
export default [...base, {
  files: ["src/dispatch-sales-order-locations.js", "src/sov-dispatch-repair.js", "test/dispatch/**/sov-dispatch.test.js"],
  languageOptions: base[0].languageOptions,
  rules: { "no-undef": "error", "no-unused-vars": "error", "no-unreachable": "error", "eqeqeq": "error", "no-var": "error" }
}, {
  files: ["src/dispatch-load-assignment.js", "src/driver-repository.js", "src/dispatch-repository.js",
    "src/scm-dependency-plan-reconciler.js", "src/dispatch-plan-order-projection.js", "src/dispatch-pickup-visits.js",
    "src/dispatch-plan-repository.js", "src/server.js"],
  languageOptions: base[0].languageOptions,
  rules: { "no-undef": "error", "no-unused-vars": "error", "no-unreachable": "error" }
}];
