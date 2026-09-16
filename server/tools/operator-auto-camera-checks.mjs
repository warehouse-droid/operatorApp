import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";

const manifest = JSON.parse(readFileSync("test/operator-auto-camera-changes.json", "utf8"));
const eslint = new ESLint({ overrideConfigFile: "tools/consolidation-load-eslint.config.mjs" });
const hash = value => createHash("sha256").update(value).digest("hex");
const diagnostics = result => result.flatMap(file => file.messages.map(({ ruleId, message, severity }) =>
  JSON.stringify({ ruleId, message, severity }))).sort();
const results = [];
for (const row of manifest) {
  const current = readFileSync(row.file, "utf8");
  assert.equal(hash(current), row.afterSha256);
  if (!/\.m?js$/.test(row.file)) continue;
  const syntax = spawnSync(process.execPath, ["--check", row.file], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  if (row.file !== "public/operator.js" && !row.file.startsWith("test/mbt/")) continue;
  const lines = current.match(/[^\n]*\n|[^\n]+$/g) || [];
  for (const edit of [...row.edits].reverse()) lines.splice(edit.start, edit.end - edit.start, ...edit.before);
  const before = lines.join("");
  assert.equal(hash(before), row.beforeSha256);
  const previous = diagnostics(await eslint.lintText(before, { filePath: row.file }));
  const after = diagnostics(await eslint.lintText(current, { filePath: row.file }));
  assert.deepEqual(after, previous, row.file);
  results.push({ file: row.file, baselineDiagnostics: previous.length, newDiagnostics: 0 });
}
writeFileSync("test-artifacts/operator-auto-camera/static.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify({ syntaxFiles: manifest.filter(row => /\.m?js$/.test(row.file)).length, results }, null, 2));
