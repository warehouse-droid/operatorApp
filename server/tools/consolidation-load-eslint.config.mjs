import base from "../eslint.mbt.config.js";
export default [...base, {
  files: ["src/consolidation-load-*.js", "src/operator-yard-authorization.js", "src/server.js", "src/photo-upload.js", "src/delivery-repository.js"],
  languageOptions: base[0].languageOptions,
  rules: { "no-undef": "error", "no-unused-vars": ["error", { argsIgnorePattern: "^_" }], "no-unreachable": "error", eqeqeq: "error", "no-var": "error" }
}, {
  files: ["public/operator.js", "public/operator-load-summary.js"],
  languageOptions: { sourceType: "script", globals: { window: "readonly", document: "readonly", navigator: "readonly", localStorage: "readonly", sessionStorage: "readonly", URL: "readonly", Blob: "readonly", File: "readonly", FormData: "readonly", fetch: "readonly", AbortController: "readonly", requestAnimationFrame: "readonly", Image: "readonly", Intl: "readonly", console: "readonly", atob: "readonly", crypto: "readonly", location: "readonly" } },
  rules: { "no-undef": "error", "no-unused-vars": "error", "no-unreachable": "error", eqeqeq: "error", "no-var": "error" }
}, {
  files: ["src/consolidation-load-*.js", "public/operator-load-summary.js"], rules: { complexity: ["error", 12], "max-depth": ["error", 4] }
}];
