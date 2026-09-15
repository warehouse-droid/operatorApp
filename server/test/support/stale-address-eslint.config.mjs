import base from "../../eslint.mbt.config.js";
export default [...base, {
  files: ["src/dispatch-delivery-group-repository.js"],
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
  rules: { "no-undef": "error", "no-unused-vars": "error", "no-unreachable": "error", eqeqeq: "error", "no-var": "error" }
}];
