import assert from "node:assert/strict";
import { ESLint } from "eslint";
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const directory = "test-artifacts/to-conflict-cleanup-20260915";
const files = readdirSync("tools").filter(name => /^to-conflict-.*\.mjs$/.test(name)).map(name => `tools/${name}`);
const fix = process.argv.includes("--fix-output"), lint = new ESLint({ overrideConfigFile: "eslint.mbt.config.js", fix });
const findings = [];
for (const file of files) {
  const source = readFileSync(file, "utf8"), result = (await lint.lintText(source, { filePath: file }))[0];
  if (fix && result.output) {
    mkdirSync(`${directory}/style/tools`, { recursive: true });
    writeFileSync(`${directory}/style/${file}`, result.output);
  }
  findings.push(...result.messages.map(message => ({ file, line: message.line, rule: message.ruleId, message: message.message })));
  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
}
writeFileSync(`${directory}/lint.json`, JSON.stringify(findings, null, 2) + "\n");
console.log(JSON.stringify({ syntaxChecked: files.length, findings }, null, 2));
if (!fix) {assert.equal(findings.length, 0, "New maintenance code must lint cleanly");}
