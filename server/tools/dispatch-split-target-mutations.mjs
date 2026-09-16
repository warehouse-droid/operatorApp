import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const source = readFileSync("public/dispatch.js", "utf8");
const marker = 'function showOrderTooltip(event) {';
const start = source.indexOf(marker);
assert.ok(start >= 0);
const insertion = source.indexOf('  const tooltip = document.getElementById("orderTooltip");', start);
assert.ok(insertion > start);
const results = [];
for (const [name, statement] of [
  ["hover_changes_primary", "selectedOrderId = order.id;"],
  ["hover_changes_multi_selection", "selectedOrderIds = new Set([order.id]);"],
  ["hover_clears_primary", 'selectedOrderId = "";']
]) {
  const root = mkdtempSync(path.join(tmpdir(), "split-target-mutant-"));
  try {
    for (const file of [
      "test/dispatch/frontend/dispatch-split-target.test.js",
      "test/support/dispatch-split-target-fixture.mjs",
      "test/support/sales-order-cargo-fixture.mjs",
      "test/support/retired-confirm-fixture.mjs"
    ]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      cpSync(file, path.join(root, file));
    }
    mkdirSync(path.join(root, "public"));
    writeFileSync(path.join(root, "public/dispatch.js"), source.slice(0, insertion) + `  ${statement}\n` + source.slice(insertion));
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"));
    const result = spawnSync(process.execPath, ["--test", "test/dispatch/frontend/dispatch-split-target.test.js"], {
      cwd: root, encoding: "utf8"
    });
    const output = `${result.stdout}${result.stderr}`;
    writeFileSync(`test-artifacts/split-target/mutation-${name}.log`, output);
    assert.doesNotMatch(output, /SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/u);
    assert.notEqual(result.status, 0, `${name} survived`);
    assert.match(output, /ERR_ASSERTION|Property failed/u);
    results.push({ name, killed: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
writeFileSync("test-artifacts/split-target/mutations.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
