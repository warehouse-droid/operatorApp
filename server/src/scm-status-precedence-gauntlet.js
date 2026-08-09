import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = [
  "package.json",
  "src/scm-reconciliation-repository.js",
  "src/server.js",
  "src/scm-reconciliation-repository-harness.js",
  "src/scm-order-visibility-harness.js",
  "src/scm-order-visibility-integration-harness.js",
  "src/scm-status-precedence-mutation-harness.js",
  "src/scm-status-precedence-gauntlet.js"
];

async function focusedSourceHash() {
  const digest = createHash("sha256");
  for (const relativePath of sourceFiles) {
    digest.update(relativePath);
    digest.update("\0");
    digest.update(await readFile(path.join(serverRoot, relativePath)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function run(name, args) {
  console.log(`[gauntlet] ${name}`);
  const result = spawnSync(process.execPath, args, {
    cwd: serverRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 30 * 1024 * 1024,
    timeout: 300_000
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${name} failed with exit status ${result.status}.`);
}

for (const file of sourceFiles.filter((file) => file.endsWith(".js"))) {
  run(`syntax: ${file}`, ["--check", file]);
}
run("repository status-precedence contract", ["src/scm-reconciliation-repository-harness.js"]);
run("restricted-order source contract", ["src/scm-order-visibility-harness.js"]);
run("DB/API visibility and terminal-status contract", ["src/scm-order-visibility-integration-harness.js"]);
run("manual mutation", ["src/scm-status-precedence-mutation-harness.js"]);

console.log(`[gauntlet] focused source sha256: ${await focusedSourceHash()}`);
console.log("SCM status precedence gauntlet passed.");
