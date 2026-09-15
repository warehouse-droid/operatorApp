import base from "../../eslint.mbt.config.js";
export default [...base, {
  files: ["src/server.js", "src/dispatch-plan-repository.js", "src/dispatch-delivery-group-repository.js",
    "src/dispatch-recorded-po-projection.js", "src/dispatch-plan-order-projection.js", "src/scm-dependency-plan-reconciler.js"],
  languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: {
    Buffer: "readonly", URL: "readonly", URLSearchParams: "readonly", console: "readonly", process: "readonly",
    fetch: "readonly", structuredClone: "readonly", AbortSignal: "readonly", setTimeout: "readonly", setInterval: "readonly", clearTimeout: "readonly", clearInterval: "readonly"
  } },
  rules: { "no-undef": "error", "no-unreachable": "error", "no-var": "error", eqeqeq: "error" }
}];
