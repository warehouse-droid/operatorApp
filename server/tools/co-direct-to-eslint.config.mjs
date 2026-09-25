import base from "../eslint.mbt.config.js";
export default [...base, { ...base[0], files: ["src/co-direct-to-cargo.js", "test/dispatch/integration/co-direct-to.test.js"] }, {
  files: ["src/dispatch-repository.js", "src/delivery-repository.js", "src/dispatch-local-co-cargo.js"],
  rules: { "no-constant-condition": "error", "no-duplicate-imports": "error", "no-unreachable": "error",
    "no-dupe-args": "error", "no-dupe-keys": "error", "no-unexpected-multiline": "error", "valid-typeof": "error" }
}];
