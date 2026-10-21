import existing from "../eslint.mbt.config.js";
export default [...existing, {
  files: ["public/mbt-planning.js"],
  languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: {
    window: "readonly", document: "readonly", location: "readonly", localStorage: "readonly", sessionStorage: "readonly",
    crypto: "readonly", fetch: "readonly", URLSearchParams: "readonly", FormData: "readonly", EventSource: "readonly",
    setInterval: "readonly", setTimeout: "readonly", clearTimeout: "readonly"
  } },
  rules: { "no-undef": "error", "no-unused-vars": "error", "no-unreachable": "error", "no-duplicate-imports": "error",
    curly: ["error", "all"], eqeqeq: ["error", "always"], "prefer-const": "error" }
}];
