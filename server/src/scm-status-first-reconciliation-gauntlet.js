import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = [
  "package.json",
  "test/baseline-harnesses.json",
  "src/scm-reconciliation.js",
  "src/scm-reconciliation-service.js",
  "src/scm-reconciliation-repository.js",
  "src/sales-order-reconciliation.js",
  "src/sales-order-reconciliation-repository.js",
  "src/return-repository.js",
  "src/netsuite-operational-work.js",
  "src/server.js",
  "src/scm-status-first-reconciliation-harness.js",
  "src/netsuite-operational-work-harness.js",
  "src/netsuite-operational-work-wiring-harness.js",
  "src/scm-status-first-reconciliation-mutation-harness.js",
  "src/scm-status-first-reconciliation-gauntlet.js"
];

function run(name, command, args, timeout = 300_000) {
  console.log(`[gauntlet] ${name}`);
  const result = spawnSync(command, args, {
    cwd: serverRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 40 * 1024 * 1024,
    timeout
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${name} failed with exit status ${result.status}.`);
}

for (const file of sourceFiles.filter((file) => file.endsWith(".js"))) {
  run(`syntax: ${file}`, process.execPath, ["--check", file]);
}

run("status-first PO/TO contract", process.execPath, ["--test", "src/scm-status-first-reconciliation-harness.js"]);
run("precise operational-work registry", process.execPath, ["--test", "src/netsuite-operational-work-harness.js"]);
run("operational-work wiring", process.execPath, ["--test", "src/netsuite-operational-work-wiring-harness.js"]);
run("core PO/TO reconciliation regression", process.execPath, ["src/scm-reconciliation-harness.js"]);
run("Sales Order terminal-header regression", process.execPath, ["src/sales-order-reconciliation-harness.js"]);
run("persisted mutation set", process.execPath, ["src/scm-status-first-reconciliation-mutation-harness.js"]);

const digest = createHash("sha256");
for (const relativePath of sourceFiles) {
  digest.update(relativePath);
  digest.update("\0");
  digest.update(await readFile(path.join(serverRoot, relativePath)));
  digest.update("\0");
}
console.log(`[gauntlet] focused source sha256: ${digest.digest("hex")}`);
console.log("Status-first reconciliation gauntlet passed.");
