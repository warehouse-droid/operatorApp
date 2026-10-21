import base from "../../eslint.mbt.config.js";

export default [...base, {
  files: ["src/dispatch-order-target-repository.js", "src/dispatch-delivery-group-repository.js", "public/dispatch.js"],
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    globals: Object.fromEntries(["process", "Buffer", "console", "structuredClone", "setTimeout", "clearTimeout",
      "setInterval", "clearInterval", "window", "document", "localStorage", "sessionStorage", "location", "navigator",
      "URL", "URLSearchParams", "CSS", "fetch", "confirm", "alert", "prompt", "Blob", "FormData", "Headers",
      "AbortController", "AbortSignal", "Worker", "Image", "File", "requestAnimationFrame", "cancelAnimationFrame",
      "MutationObserver", "Node", "performance", "Event", "CustomEvent", "ResizeObserver", "dispatchAuthToken",
      "requireDispatchLogin"].map(name => [name, "readonly"]))
  },
  rules: {
    "eqeqeq": ["error", "always"],
    "no-undef": "error",
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "no-unreachable": "error",
    "no-duplicate-imports": "error"
  }
}];
