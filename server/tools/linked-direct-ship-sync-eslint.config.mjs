import standard from "../eslint.mbt.config.js";
export default [...standard, {
  files: ["src/linked-direct-ship-sync-*.js"],
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
  rules: { complexity: ["error", 12], curly: ["error", "all"], eqeqeq: ["error", "always"],
    "no-unused-vars": "error", "no-undef": "error", "no-unreachable": "error", "prefer-const": "error" }
}];
