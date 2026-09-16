import base from "../eslint.mbt.config.js";
export default [...base, {
  ...base[0],
  files: ["src/netsuite*.js", "src/order-sync-repository.js", "src/sales-order-reconciliation.js",
    "src/scm-reconciliation-service.js", "src/scm-netsuite-po-history-service.js", "src/server.js", "netsuite-order-webhook-*.js"],
  languageOptions: { ...base[0].languageOptions,
    globals: { ...base[0].languageOptions.globals, define: "readonly", TextDecoder: "readonly", TextEncoder: "readonly" } }
}];
