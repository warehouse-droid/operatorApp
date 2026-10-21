import base from "../eslint.mbt.config.js";

export default [{
  files: ["src/smart-scm-line-order*.js", "src/smart-scm-created-po.js", "src/smart-scm-purchase-netsuite.js", "src/transfer-dependency-netsuite.js", "test/mbt/**/smart-scm-line-order*.js", "tools/scm-line-order*.mjs"],
  languageOptions: { ...base[0].languageOptions },
  rules: { "no-undef": "error", "no-unused-vars": ["error", { argsIgnorePattern: "^_" }], "no-unreachable": "error", eqeqeq: "error", "no-var": "error" }
}, {
  files: ["public/scm-smart-line-order*.js"],
  languageOptions: { sourceType: "script", ecmaVersion: "latest", globals: {
    smartCanWrite: "readonly", smartState: "readonly", smartEscape: "readonly", smartApi: "readonly", smartScmApp: "readonly", SmartScmLineOrder: "readonly"
  } },
  rules: { "no-undef": "error", "no-unused-vars": ["error", { varsIgnorePattern: "^smartLineOrder", argsIgnorePattern: "^_" }], "no-unreachable": "error", eqeqeq: "error", complexity: ["error", 18], "max-depth": ["error", 4] }
}, {
  files: ["tools/scm-line-order-browser.mjs"],
  languageOptions: { globals: { window: "readonly", document: "readonly", smartScmApp: "readonly", smartProposalCard: "readonly",
    smartVendorLoadCard: "readonly", smartReceiveLineOrder: "readonly", smartState: "readonly", smartConnectEvents: "readonly",
    record: "readonly", savedOrder: "readonly", apiCalls: "readonly", rejectNext: "writable" } }
}];
