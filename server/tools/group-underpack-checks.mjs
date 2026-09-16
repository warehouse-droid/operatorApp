import assert from "node:assert/strict";
import { ESLint } from "eslint";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const directory = "test-artifacts/group-underpack-20260915";
const baseline = process.argv.includes("--baseline");
const files = baseline ? ["src/delivery-repository.js", "public/operator.js", "public/service-worker.js"] : ["src/delivery-packing-progress.js", "src/delivery-repository.js",
  "public/operator.js", "public/service-worker.js", "test/mbt/unit/operator-yard-assets.test.js",
  "test/dispatch/property/group-underpack-boundary.property.test.js",
  "test/mbt/integration/group-underpack.test.js", "test/mbt/unit/group-underpack-ui.test.js", "test/support/group-underpack-fixture.mjs"];
const lint = new ESLint({ overrideConfigFile: "tools/group-underpack-eslint.config.mjs" }), findings = [];
for (const file of files) {
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const result = (await lint.lintFiles(file))[0];
  const lines = readFileSync(file, "utf8").split("\n");
  findings.push(...result.messages.map(message => ({ file, line: message.line, rule: message.ruleId, message: message.message, source: lines[message.line - 1]?.trim() })));
}
const known = baseline ? [] : JSON.parse(readFileSync(`${directory}/static-baseline.json`, "utf8")).findings;
const key = ({ file, rule, message, source }) => JSON.stringify({ file, rule, message, source });
const newFindings = findings.filter(row => !known.some(item => key(item) === key(row)));
const hashFiles = [...files, "public/operator.html"];
writeFileSync(`${directory}/static${baseline ? "-baseline" : ""}.json`, JSON.stringify({ findings, newFindings,
  hashes: Object.fromEntries(hashFiles.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])) }, null, 2) + "\n");
if (!baseline) {assert.equal(newFindings.length, 0, JSON.stringify(newFindings));}
console.log(JSON.stringify({ files: files.length, baseline, findings: findings.length, newFindings: newFindings.length }));
