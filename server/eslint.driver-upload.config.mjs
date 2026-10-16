export default [{
  files: ["public/driver-upload.js", "src/driver-upload-failure*.js", "test/mbt/unit/driver-upload-*.test.js", "test/mbt/property/driver-upload-progress.test.js", "test/mbt/integration/driver-upload-failure-http.test.js", "test/support/driver-upload-*.mjs", "test/driver-upload/*.js", "test/driver-upload.playwright.config.mjs", "tools/driver-upload-*.mjs"],
  languageOptions: {ecmaVersion: "latest", sourceType: "module", globals: Object.fromEntries([
    "AbortController", "Blob", "Buffer", "File", "FormData", "URL", "clearTimeout", "console", "crypto", "fetch", "globalThis", "navigator", "process", "queueMicrotask", "setTimeout", "structuredClone"
  ].map(name => [name, "readonly"]))},
  rules: {"no-undef": "error", "no-unused-vars": ["error", {argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_"}], "no-shadow": "error", "no-unreachable": "error", "no-constant-condition": "error", "no-duplicate-imports": "error", "eqeqeq": ["error", "always"], "no-var": "error", "prefer-const": "error", "complexity": ["error", 20], "max-depth": ["error", 4]}
}];
