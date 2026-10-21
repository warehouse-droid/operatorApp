import assert from "node:assert/strict";
import fs from "node:fs";
import { Linter } from "eslint";
import config from "../eslint.mbt.config.js";

const files = ["src/delivery-repository.js", "src/operator-load-state.js", "public/operator.js"];
const linter = new Linter();
const baseline = "/workspace/server/test-artifacts/local-vrma-final-qty-20261019/baseline";
const options = { languageOptions: { ...config[0].languageOptions, globals: { ...config[0].languageOptions.globals,
  document: "readonly", window: "readonly", navigator: "readonly", localStorage: "readonly", sessionStorage: "readonly",
  location: "readonly", Image: "readonly", File: "readonly", FileReader: "readonly", requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly", HTMLElement: "readonly", atob: "readonly", btoa: "readonly", indexedDB: "readonly" } },
  rules: { "no-undef": "error", "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    "no-unreachable": "error", "no-constant-condition": "error", complexity: ["error", 12] } };
const diagnostics = source => linter.verify(source, options).map(error => ({
  key: `${error.ruleId}:${error.message}:${source.split("\n")[error.line - 1]?.trim()}`, line: error.line
}));
const report = [];
for (const file of files) {
  const before = diagnostics(fs.readFileSync(`${baseline}/${file}`, "utf8"));
  const after = diagnostics(fs.readFileSync(file, "utf8"));
  const existing = new Set(before.map(row => row.key));
  const added = after.filter(row => !existing.has(row.key));
  report.push({ file, baselineDiagnostics: before.length, currentDiagnostics: after.length, added });
}
fs.writeFileSync("test-artifacts/static-delta.json", JSON.stringify(report, null, 2));
assert.equal(report.flatMap(row => row.added).length, 0, JSON.stringify(report, null, 2));
console.log("No new lint or complexity diagnostics in changed runtime files.");
