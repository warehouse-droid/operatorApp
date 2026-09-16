import base from "../eslint.mbt.config.js";

export default [{
  ...base[0],
  files: ["src/operator-yard-authorization.js", "src/receiving-repository.js",
    "src/operator-netsuite-posting-targets.js", "public/operator.js", "public/service-worker.js",
    "test/mbt/integration/operator-receiving-*.test.js", "test/mbt/unit/operator-receiving-*.test.js",
    "test/mbt/unit/operator-yard-assets.test.js", "test/mbt/unit/operations-navigation-enhancements.test.js",
    "test/mbt/unit/operator-*-ui.contract.test.js", "tools/operator-receiving-*.mjs"]
}];
