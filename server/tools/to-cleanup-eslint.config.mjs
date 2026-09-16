import base from "./dispatch-fulfilled-so-eslint.config.mjs";
export default [...base, {
  files: ["src/dispatch-fulfilled-to-*.js", "src/receiving-repository.js", "tools/to-cleanup-*.mjs"],
  languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: { process: "readonly", console: "readonly", URL: "readonly", structuredClone: "readonly" } },
  rules: { "no-undef": "error", "no-unused-vars": ["error", { argsIgnorePattern: "^_" }], "no-unreachable": "error", eqeqeq: "error", "no-var": "error" }
}];
