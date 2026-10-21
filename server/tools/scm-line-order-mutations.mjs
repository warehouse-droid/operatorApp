import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const file = "public/scm-smart-line-order-core.js";
const original = fs.readFileSync(file, "utf8");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "scm-line-order-mutations-"));
fs.cpSync("src", path.join(sandbox, "src"), { recursive: true });
fs.mkdirSync(path.join(sandbox, "public"));
fs.mkdirSync(path.join(sandbox, "test/mbt/unit"), { recursive: true });
fs.copyFileSync("test/mbt/unit/smart-scm-line-order.test.js", path.join(sandbox, "test/mbt/unit/smart-scm-line-order.test.js"));
fs.copyFileSync("package.json", path.join(sandbox, "package.json"));
fs.symlinkSync(path.resolve("node_modules"), path.join(sandbox, "node_modules"), "dir");
const mutants = [
  ["ignore requested order", "return [...lines].sort", "return [...lines]; /* mutant */ return [...lines].sort"],
  ["accept duplicate keys", "|| new Set(order).size !== order.length", ""],
  ["accept omitted lines", "|| order.length !== lines.length", ""],
  ["leave outgoing payload unordered", "return ordered(items.map", "return [...items]; /* mutant */ return ordered(items.map"],
  ["ignore persisted NetSuite sequence", "?? row.raw?.line_sequence_number ?? row.raw?.lineSequenceNumber", ""]
];
const results = [];
try {
  for (const [name, before, after] of mutants) {
    assert.equal(original.split(before).length, 2, `unique mutation: ${name}`);
    fs.writeFileSync(path.join(sandbox, file), original.replace(before, after));
    const run = spawnSync(process.execPath, ["--test", "test/mbt/unit/smart-scm-line-order.test.js"], { encoding: "utf8", cwd: sandbox });
    const output = `${run.stdout}${run.stderr}`;
    assert.match(output, /not ok/, "a behavior assertion must fail, not just test collection");
    results.push({ name, killed: run.status !== 0 });
    fs.writeFileSync(`test-artifacts/scm-line-order/mutation-${results.length}.log`, output);
  }
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
assert.deepEqual(fs.readFileSync(file, "utf8"), original);
assert.ok(results.every((result) => result.killed));
console.log(JSON.stringify({ killed: results.length, total: mutants.length, results }));
