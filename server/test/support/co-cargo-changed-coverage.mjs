import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const [reportPath, baseline] = process.argv.slice(2);
const coverage = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const files = ["src/dispatch-local-co-cargo.js", "src/dispatch-co-cargo-repair.js", "src/dispatch-co-lifecycle.js",
  "src/dispatch-delivery-group-repository.js", "src/dispatch-order-catalog-repository.js", "public/dispatch.js"];
const frontendFunctions = ["canonicalDispatchOrderType", "isAggregateDispatchCoGroup", "flattenDispatchGroupMembers",
  "preserveDispatchPlanningFields", "specialOrderPalletItemQuantity", "effectiveOrderPalletQuantity", "applyDispatchOrderFeed", "applySavedPlan"];
const results = [];
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const lines = source.split("\n");
  const old = `${baseline}/${file}`;
  const diff = spawnSync("diff", ["-U0", fs.existsSync(old) ? old : "/dev/null", file], { encoding: "utf8" });
  assert.ok(diff.status === 0 || diff.status === 1, diff.stderr || "diff tool failed");
  const added = new Set();
  for (const match of diff.stdout.matchAll(/^@@ .* \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let offset = 0; offset < count; offset += 1) { added.add(start + offset); }
  }
  const data = coverage[`/app/${file}`];
  assert.ok(data, `Missing coverage: ${file}`);
  const spans = file === "public/dispatch.js" ? frontendFunctions.map((name) => {
    const match = new RegExp(`^function ${name}\\(`, "m").exec(source);
    assert.ok(match);
    const start = source.slice(0, match.index).split("\n").length;
    const end = /^}/m.exec(source.slice(match.index));
    assert.ok(end);
    return [start, start + source.slice(match.index, match.index + end.index).split("\n").length - 1];
  }) : [[1, lines.length]];
  const executable = [...added].filter((line) => {
    const content = lines[line - 1]?.trim();
    return content && !/^(\/\*|\*|\/\/)/.test(content);
  });
  const missed = executable.filter((line) => !spans.some(([start, end]) => line >= start && line <= end)
    || !Object.entries(data.statementMap).some(([id, span]) => span.start.line <= line && span.end.line >= line && data.s[id] > 0));
  results.push({ file, changedLines: executable.length, covered: executable.length - missed.length, missed });
}
console.log(JSON.stringify({ results, total: results.reduce((sum, row) => sum + row.changedLines, 0), missed: results.flatMap((row) => row.missed) }));
assert.ok(results.every((row) => row.missed.length === 0), "Unexecuted changed CO lines; see report above");
