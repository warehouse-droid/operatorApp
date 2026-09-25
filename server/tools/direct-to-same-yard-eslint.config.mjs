import base from "../eslint.mbt.config.js";

export default [...base, {
  files: ["src/dispatch-load-assignment.js", "public/dispatch.js", "src/delivery-repository.js", "src/dispatch-repository.js"],
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
  rules: {
    "no-constant-condition": "error", "no-duplicate-imports": "error",
    "no-unreachable": "error", "no-dupe-args": "error", "no-dupe-keys": "error",
    "no-unexpected-multiline": "error", "valid-typeof": "error"
  }
}, { ...base[0], files: ["src/co-source-packing-handoff.js"] }];
