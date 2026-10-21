import base from "./dispatch-fulfilled-so-eslint.config.mjs";
export default [...base, {
  files: ["test/dispatch/frontend/dispatch-registered-split-planning.browser.test.mjs"],
  languageOptions: { sourceType: "module", globals: { fetch: "readonly", URL: "readonly", window: "readonly", document: "readonly" } },
  rules: { "no-unused-vars": "error", "no-unreachable": "error", eqeqeq: "error", "no-var": "error" }
}];
