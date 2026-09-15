import base from "../../eslint.mbt.config.js";
export default [...base, {
  files: ["src/dispatch-allocation-item-identity.js"],
  languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: { structuredClone: "readonly" } },
  rules: { "no-undef": "error", "no-unused-vars": "error", "no-unreachable": "error", "eqeqeq": "error", "no-var": "error" }
}];
