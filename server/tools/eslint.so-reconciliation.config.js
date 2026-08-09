const globals = {
  Buffer: "readonly",
  console: "readonly",
  process: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  structuredClone: "readonly",
  URL: "readonly"
};

export default [{
  files: [
    "src/sales-order-reconciliation*.js",
    "src/grouped-po-reconciliation*.js",
    "src/grouped-sales-order-reconciliation*.js",
    "src/dispatch-group-reconciliation-ui-harness.js",
    "src/dispatch-plan-repository.js",
    "src/scm-reconciliation.js",
    "src/scm-reconciliation-harness.js",
    "src/scm-reconciliation-repository.js",
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
