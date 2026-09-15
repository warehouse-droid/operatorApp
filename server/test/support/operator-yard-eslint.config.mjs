import base from "../../eslint.mbt.config.js";

export default [...base, {
  files: ["src/operator-yard-*.js", "src/auth-repository.js", "src/history-repository.js", "src/inventory-repository.js", "src/server.js", "src/return-repository.js", "src/photo-upload.js", "src/delivery-repository.js", "src/delivery-consolidation-repository.js"],
  languageOptions: base[0].languageOptions,
  rules: { "no-undef": "error", "no-unused-vars": "error", "no-unreachable": "error", "eqeqeq": "error", "no-var": "error" }
}, {
  files: ["src/operator-yard-*.js"],
  rules: { complexity: ["error", 12], "max-depth": ["error", 4] }
}];
