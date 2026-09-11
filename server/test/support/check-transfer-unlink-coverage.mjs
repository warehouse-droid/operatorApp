import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const [reportPath, baseline] = process.argv.slice(2);
const coverage = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const files = ["src/dispatch-plan-repository.js", "src/order-dependency-repository.js", "src/scm-dependency-management-policy.js",
  "src/scm-dependency-preview-service.js", "src/scm-dependency-command-service.js"];
const results = [];
for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const diff = spawnSync("diff", ["-U0", `${baseline}/${file}`, file], { encoding: "utf8" });
  assert.ok(diff.status === 0 || diff.status === 1);
  const added = new Set();
  for (const match of diff.stdout.matchAll(/^@@ .* \+(\d+)(?:,(\d+))? @@/gm)) {
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let n = 0; n < count; n += 1) { added.add(Number(match[1]) + n); }
  }
  const data = coverage[`/app/${file}`];
  assert.ok(data, `Missing coverage: ${file}`);
  const executable = [...added].filter((line) => lines[line - 1]?.trim() && !/^\s*(\/\*|\*|\/\/)/u.test(lines[line - 1]));
  const missed = executable.filter((line) => !Object.entries(data.statementMap).some(([id, span]) => span.start.line <= line && span.end.line >= line && data.s[id] > 0));
  results.push({ file, changedLines: executable.length, covered: executable.length - missed.length, missed });
}
console.log(JSON.stringify({ results, total: results.reduce((sum, row) => sum + row.changedLines, 0) }));
assert.ok(results.every((row) => row.missed.length === 0), "Unexecuted changed lines");
