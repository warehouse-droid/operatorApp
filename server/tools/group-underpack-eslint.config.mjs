import base from "../test/support/operator-yard-eslint.config.mjs";
export default [...base, {
  files: ["src/delivery-packing-progress.js", "test/dispatch/property/group-underpack-boundary.property.test.js"], languageOptions: base[0].languageOptions,
  rules: { ...base[0].rules, complexity: ["error", 12], "max-depth": ["error", 4] }
}, {
  files: ["public/operator.js", "public/service-worker.js"],
  rules: { "no-unreachable": "error", "no-var": "error", eqeqeq: "error" }
}];
