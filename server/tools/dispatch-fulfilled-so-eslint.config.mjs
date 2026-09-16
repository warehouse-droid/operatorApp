import base from "../eslint.mbt.config.js";
export default [...base, {
  files: ["src/dispatch-*.js", "src/sales-order-reconciliation.js", "src/server.js"],
  languageOptions: base[0].languageOptions,
  rules: { "no-undef": "error", "no-unused-vars": ["error", { argsIgnorePattern: "^_" }], "no-unreachable": "error", eqeqeq: "error", "no-var": "error" }
}, {
  files: ["public/dispatch.js"],
  languageOptions: { sourceType: "script", globals: { window: "readonly", document: "readonly", navigator: "readonly", localStorage: "readonly", sessionStorage: "readonly", URL: "readonly", Blob: "readonly", File: "readonly", FormData: "readonly", fetch: "readonly", AbortController: "readonly", requestAnimationFrame: "readonly", Image: "readonly", Intl: "readonly", console: "readonly", atob: "readonly", crypto: "readonly", location: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", structuredClone: "readonly", performance: "readonly", CustomEvent: "readonly", ResizeObserver: "readonly", HTMLInputElement: "readonly", Event: "readonly", confirm: "readonly", alert: "readonly", prompt: "readonly" } },
  rules: { "no-undef": "error", "no-unused-vars": "error", "no-unreachable": "error", eqeqeq: "error", "no-var": "error" }
}, {
  files: ["src/dispatch-fulfilled-so-*.js"], rules: { complexity: ["error", 12], "max-depth": ["error", 4] }
}];
