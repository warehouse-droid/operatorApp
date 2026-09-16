import assert from "node:assert/strict";
import { ESLint } from "eslint";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const directory = "test-artifacts/vrma-confirm-encoding-20260915";
const files = ["src/operator-yard-route.js", "src/operator-yard-authorization.js",
  "test/mbt/unit/vrma-confirm-encoding.test.js", "test/mbt/integration/vrma-confirm-encoding.test.js"];
const lint = new ESLint({ overrideConfigFile: "test/support/operator-yard-eslint.config.mjs" }), findings = [];
for (const file of files) {
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const result = (await lint.lintFiles(file))[0];
  findings.push(...result.messages.map(message => ({ file, line: message.line, rule: message.ruleId, message: message.message })));
}
writeFileSync(`${directory}/static.json`, JSON.stringify({ findings,
  hashes: Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])) }, null, 2) + "\n");
assert.equal(findings.length, 0, JSON.stringify(findings));
console.log(JSON.stringify({ files: files.length, findings }));
