const globals = {
  AbortController: "readonly",
  Blob: "readonly",
  Buffer: "readonly",
  console: "readonly",
  createImageBitmap: "readonly",
  crypto: "readonly",
  document: "readonly",
  File: "readonly",
  globalThis: "readonly",
  indexedDB: "readonly",
  location: "readonly",
  process: "readonly",
  Request: "readonly",
  Response: "readonly",
  setTimeout: "readonly",
  structuredClone: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly"
};

export default [{
  files: [
    "test/driver-offline-stress/**/*.js",
    "test/driver-offline-history/**/*.js",
    "test/support/*driver-offline-stress*.mjs",
    "test/support/*driver-offline-soak*.mjs",
    "test/support/*driver-offline-route-history*.mjs",
    "test/mbt/property/driver-offline-stress-contract.test.js",
    "test/mbt/property/driver-offline-route-history.test.js"
  ],
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    globals
  },
  linterOptions: { reportUnusedDisableDirectives: "error" },
  rules: {
    complexity: ["error", 30],
    curly: ["error", "all"],
    eqeqeq: ["error", "always"],
    "max-depth": ["error", 6],
    "no-constant-condition": "error",
    "no-duplicate-imports": "error",
    "no-implicit-coercion": "error",
    "no-shadow": "error",
    "no-undef": "error",
    "no-unreachable": "error",
    "no-unused-vars": ["error", {
      argsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      varsIgnorePattern: "^_"
    }],
    "no-useless-catch": "error",
    "no-var": "error",
    "prefer-const": "error"
  }
}];
