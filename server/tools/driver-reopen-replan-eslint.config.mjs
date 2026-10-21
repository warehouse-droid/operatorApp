import base from "../eslint.mbt.config.js";
export default [...base, {
  files: ["src/driver-pwa-repository.js", "src/server.js"],
  languageOptions: base[0].languageOptions,
  rules: {
    "no-duplicate-imports": "error",
    "no-undef": "error",
    "no-unreachable": "error",
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "no-var": "error",
    "prefer-const": "error"
  }
}];
