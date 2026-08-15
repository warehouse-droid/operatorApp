const sharedGlobals = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Blob: "readonly",
  Buffer: "readonly",
  console: "readonly",
  crypto: "readonly",
  fetch: "readonly",
  FormData: "readonly",
  process: "readonly",
  structuredClone: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  performance: "readonly"
};

export default [
  {
    files: ["src/mbt/**/*.js", "src/operator-customer-pickup-photo-policy.js", "test/mbt/**/*.{js,mjs}", "test/support/**/*.mjs", "tools/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: sharedGlobals
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error"
    },
    rules: {
      complexity: ["error", 12],
      curly: ["error", "all"],
      eqeqeq: ["error", "always"],
      "max-depth": ["error", 4],
      "no-constant-condition": "error",
      "no-duplicate-imports": "error",
      "no-implicit-coercion": "error",
      "no-shadow": "error",
      "no-undef": "error",
      "no-unreachable": "error",
      "no-unused-vars": ["error", {
        "argsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_",
        "varsIgnorePattern": "^_"
      }],
      "no-useless-catch": "error",
      "no-var": "error",
      "prefer-const": "error"
    }
  },
  {
    files: ["src/dispatch-planner-*.js", "test/dispatch/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: sharedGlobals
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error"
    },
    rules: {
      curly: ["error", "all"],
      eqeqeq: ["error", "always"],
      "no-constant-condition": "error",
      "no-duplicate-imports": "error",
      "no-implicit-coercion": "error",
      "no-shadow": "error",
      "no-undef": "error",
      "no-unreachable": "error",
      "no-unused-vars": ["error", {
        "argsIgnorePattern": "^_",
        "caughtErrorsIgnorePattern": "^_",
        "varsIgnorePattern": "^_"
      }],
      "no-useless-catch": "error",
      "no-var": "error",
      "prefer-const": "error"
    }
  }
];
