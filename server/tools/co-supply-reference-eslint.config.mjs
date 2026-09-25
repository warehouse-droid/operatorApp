import base from "../eslint.mbt.config.js";
export default [...base,
  { ...base[0], files: ["src/co-operator-linked-supply.js", "test/dispatch/{unit,integration}/co-supply-reference.test.js"] },
  { files: ["src/delivery-repository.js"], rules: {
    "no-constant-condition": "error", "no-duplicate-imports": "error", "no-unreachable": "error",
    "no-dupe-args": "error", "no-dupe-keys": "error", "no-unexpected-multiline": "error", "valid-typeof": "error"
  } }
];
