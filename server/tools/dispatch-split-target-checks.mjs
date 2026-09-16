import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import { splitTargetBrowser } from "../test/support/dispatch-split-target-fixture.mjs";

const artifact = "test-artifacts/split-target";
const commands = [
  ["frontend-final", process.execPath, ["--test", "--test-concurrency=1", ...readdirSync("test/dispatch/frontend")
    .filter(file => file.endsWith(".js")).map(file => `test/dispatch/frontend/${file}`)]],
  ["focused-final", process.execPath, ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
    "--include=public/dispatch.js", `--temp-directory=${artifact}/coverage-tmp`, `--reports-dir=${artifact}/coverage`,
    "--reporter=json", "--reporter=text", process.execPath, "--test", "test/dispatch/frontend/dispatch-split-target.test.js"]],
  ...["dispatch-stop-visit", "dispatch-save-coordination", "yard-dependency-structure"]
    .map(name => [name, process.execPath, [`src/${name}-harness.js`]]),
  ["syntax", process.execPath, ["--check", "public/dispatch.js"]],
  ["lint-tests", process.execPath, ["node_modules/eslint/bin/eslint.js", "--config", "eslint.mbt.config.js", "--max-warnings=0",
    "test/dispatch/frontend/dispatch-split-target.test.js", "test/support/dispatch-split-target-fixture.mjs",
    "tools/dispatch-split-target-mutations.mjs", "tools/dispatch-split-target-checks.mjs"]],
  ["mutations-final", process.execPath, ["tools/dispatch-split-target-mutations.mjs"]]
];
const results = [];
results.push({ name: "dispatch-po-multi-drop", skipped: "Database integration harness; no database/server behavior changed. Its initial run passed tooltip assertions before ECONNREFUSED in the database stage." });
for (const [name, command, args] of commands) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  writeFileSync(`${artifact}/${name}.log`, `${result.stdout}${result.stderr}`);
  console.log(JSON.stringify({ name, exitCode: result.status }));
  assert.equal(result.status, 0, `${name} failed; see ${artifact}/${name}.log`);
  results.push({ name, exitCode: result.status });
}
const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
  languageOptions: { ecmaVersion: "latest", sourceType: "module" },
  rules: { "no-cond-assign": "error", "no-unreachable": "error", "no-constant-condition": "error", eqeqeq: "error" }
}] });
const lint = await eslint.lintText(`export ${splitTargetBrowser().showOrderTooltip.toString()}`);
assert.equal(lint[0].errorCount + lint[0].warningCount, 0);
results.push({ name: "tooltip-lint", errors: 0, warnings: 0 });
const hashes = Object.fromEntries(["public/dispatch.js", "public/dispatch.html", "test/dispatch/frontend/dispatch-split-target.test.js"]
  .map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
writeFileSync(`${artifact}/checks.json`, JSON.stringify({ results, hashes, node: process.version }, null, 2));
