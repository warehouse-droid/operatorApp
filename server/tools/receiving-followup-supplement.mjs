import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { ESLint } from "eslint";
import { scanPaths } from "../test/support/scan-diff-secrets.mjs";

const artifact = "test-artifacts/receiving-followup";
const frontend = ["public/operator.js", "public/service-worker.js"];
const eslint = new ESLint({ overrideConfigFile: "tools/operator-direct-orderline-eslint.config.mjs" });
const messages = async (file, source) => (await eslint.lintText(source, { filePath: file }))
  .flatMap(result => result.messages.map(row => `${row.ruleId}:${row.message.replace(/on line \d+ column \d+/gu, "on line N column N")}`)).sort();
const lint = [];
for (const file of frontend) {
  const baseline = await messages(file, fs.readFileSync(`${artifact}/baseline/${file}`, "utf8"));
  const candidate = await messages(file, fs.readFileSync(file, "utf8"));
  assert.deepEqual(candidate, baseline, `${file}: new browser lint findings`);
  lint.push({ file, existingFindings: candidate.length, newFindings: 0 });
}
const paths = ["src/receiving-repository.js", "src/operator-netsuite-posting-targets.js", "src/receiving-receipt-progress.js",
  ...frontend, "public/operator.html", "public/operator-receiving-confirmation.css",
  ...["operations-navigation-enhancements.test.js", "operator-customer-pickup-photo-gate-ui.contract.test.js", "operator-page-confirm-ui.contract.test.js", "operator-yard-assets.test.js"].map(file => `test/mbt/unit/${file}`),
  ...["tools", "test/support", "test/mbt/unit", "test/mbt/integration", "test/mbt/concurrency"].flatMap(directory =>
    fs.readdirSync(directory).filter(file => file.startsWith("receiving-followup")).map(file => `${directory}/${file}`))];
assert.deepEqual(await scanPaths(paths), []);
const versions = Object.fromEntries(["typescript", "eslint", "fast-check", "c8", "@playwright/test"]
  .map(name => [name, JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, "utf8")).version]));
const sourceHashes = Object.fromEntries(paths.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
const result = { node: process.version, versions, lint, secretFindings: 0, scannedFiles: paths.length, sourceHashes };
fs.writeFileSync(`${artifact}/supplement.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
