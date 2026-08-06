const globals = {
  Buffer: "readonly",
  console: "readonly",
  process: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  URL: "readonly"
};

export default [{
  files: [
    "src/sales-order-reconciliation*.js",
    "src/scm-reconciliation-service.js",
    "src/scm-reconciliation-so-type-harness.js"
  ],
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    globals
  },
  linterOptions: {
    reportUnusedDisableDirectives: "error"
  },
  rules: {
    "no-constant-condition": "error",
    "no-duplicate-imports": "error",
    "no-undef": "error",
    "no-unreachable": "error"
  }
}];
