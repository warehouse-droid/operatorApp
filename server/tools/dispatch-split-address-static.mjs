import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import { cargoFunctions } from "../test/support/sales-order-cargo-fixture.mjs";

const files = ["src/dispatch-delivery-group-repository.js", "src/dispatch-repository.js", "src/delivery-repository.js",
  "src/dispatch-planner-optimization.js", "public/dispatch.js", "public/dispatch.html"];
for (const file of files.filter(candidate => candidate.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(result.status, 0, `${file}: ${result.stderr}`);
}
const safety = new ESLint({ overrideConfigFile: true, overrideConfig: [{
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
  rules: { "no-cond-assign": "error", "no-unreachable": "error", "no-constant-condition": "error",
    "no-dupe-keys": "error", eqeqeq: "error", "valid-typeof": "error" }
}] });
const lint = await safety.lintFiles(files.filter(file => file.endsWith(".js")));
let baselineLintIssues = 0;
for (const file of lint) {
  const relative = file.filePath.slice(process.cwd().length + 1);
  const before = readFileSync(`test-artifacts/split-address/baseline/${relative}`, "utf8");
  const previous = (await safety.lintText(before))[0];
  const keys = (messages, source) => messages.map(message => `${message.ruleId}:${message.message}:${source.split("\n")[message.line - 1]?.trim()}`).sort();
  assert.deepEqual(keys(file.messages, readFileSync(relative, "utf8")), keys(previous.messages, before), relative);
  baselineLintIssues += previous.messages.length;
}
const helperNames = ["applySplitDispatchDetails", "updateDispatchSalesSplitDetails"];
const helpers = cargoFunctions("../../src/dispatch-delivery-group-repository.js", helperNames);
const helperLint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ languageOptions: {
  ecmaVersion: "latest", sourceType: "module", globals: Object.fromEntries([
    "text", "query", "withTransaction", "DISPATCH_FLEET_PLANNING_LOCK", "compactDispatchOrderCard",
    "dispatchOrderSearchText", "reconcileDispatchGlobalOrderSources"
  ].map(name => [name, "readonly"])) }, rules: { "no-undef": "error", "no-unused-vars": "error", complexity: ["error", 12] }
}] });
const helperResult = await helperLint.lintText(helperNames.map(name => `export ${helpers[name].toString()}`).join("\n"));
assert.equal(helperResult[0].errorCount + helperResult[0].warningCount, 0, JSON.stringify(helperResult[0].messages));
const diff = readFileSync("test/dispatch-split-address.changes.patch", "utf8");
assert.doesNotMatch(diff, /(?:AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/u);
const hashes = Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
writeFileSync("test-artifacts/split-address/static.json", JSON.stringify({ syntaxFiles: 5, newLintIssues: 0, baselineLintIssues,
  helperComplexityBudget: 12, dependenciesAdded: 0, node: process.version, hashes }, null, 2));
console.log(JSON.stringify({ syntaxFiles: 5, newLintIssues: 0, baselineLintIssues, helperComplexityBudget: 12 }));
