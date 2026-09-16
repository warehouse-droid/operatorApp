import base from "../eslint.mbt.config.js";

export default [{
  files: ["src/smart-scm-created-po.js", "src/scm-netsuite-po-version.js", "src/smart-scm-vendor-workflow-repository.js", "src/scm-netsuite-po-history-*.js", "src/netsuite.js", "test/mbt/unit/smart-scm-created-po*.js", "test/mbt/unit/scm-netsuite-po-version.test.js", "test/mbt/integration/smart-scm-vendor-unit-price.test.js", "tools/smart-scm-created-po-sync-*.mjs"],
  languageOptions: base[0].languageOptions,
  rules: { "no-undef": "error", "no-unused-vars": ["error", {argsIgnorePattern:"^_"}], "no-unreachable": "error", "eqeqeq": "error", "no-var": "error" }
}, {
  files: ["src/smart-scm-created-po.js", "src/scm-netsuite-po-version.js"],
  rules: {complexity:["error",20],"max-depth":["error",4]}
}];
