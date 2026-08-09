import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = [
  "package.json",
  "migrations/138_smart_scm_authoritative_on_order.sql",
  "public/scm-smart-proposals.css",
  "public/scm-smart-proposals.js",
  "src/netsuite.js",
  "src/inventory-repository.js",
  "src/netsuite-mirror-repository.js",
  "src/smart-scm-item-repository.js",
  "src/smart-scm-harness.js",
  "src/smart-scm-sync-service.js",
  "src/smart-scm-planning-repository.js",
  "src/smart-scm-purchase-conservation-harness.js",
  "src/smart-scm-run-validator.js",
  "src/smart-scm-run-validator-harness.js",
  "src/smart-scm-calculation-ui-harness.js",
  "src/smart-scm-proposal-editor.js",
  "src/smart-scm-vendor-repository.js",
  "src/smart-scm-authoritative-inbound-harness.js",
  "src/smart-scm-authoritative-inbound-integration-harness.js",
  "src/smart-scm-authoritative-inbound-mutation-harness.js",
  "src/smart-scm-authoritative-inbound-gauntlet.js",
  "src/refresh-smart-scm-authoritative-inputs.js",
  "src/repair-smart-scm-authoritative-urgency.js"
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

function run(name, args, timeout = 300_000) {
  console.log(`[gauntlet] ${name}`);
  const result = spawnSync(process.execPath, args, {
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
  run(`syntax: ${file}`, ["--check", file]);
}
run("authoritative inventory formula", ["src/smart-scm-authoritative-inbound-harness.js"]);
run("purchase proposal conservation", ["src/smart-scm-purchase-conservation-harness.js"]);
run("planning-run validation", ["src/smart-scm-run-validator-harness.js"]);
run("grouped allocation UI", ["src/smart-scm-calculation-ui-harness.js"]);
run("broad Smart SCM integration", ["src/smart-scm-harness.js"]);
run("rollback-only authoritative inventory integration", ["src/smart-scm-authoritative-inbound-integration-harness.js"]);
run("urgency classification", ["src/smart-scm-urgency-harness.js"]);
run("policy calculation", ["src/smart-scm-policy-calculation-harness.js"]);
run("planning exclusions", ["src/smart-scm-planning-exclusion-harness.js"]);
run("vendor alternative inventory evidence", ["src/smart-scm-vendor-alternative-harness.js"]);
run("blanket workflow", ["src/smart-scm-blanket-workflow-harness.js"]);
run("vendor workflow", ["src/smart-scm-vendor-workflow-harness.js"]);
run("live execution", ["src/smart-scm-live-execution-harness.js"]);
run("mutation tests", ["src/smart-scm-authoritative-inbound-mutation-harness.js"], 600_000);

console.log(`[gauntlet] focused source sha256: ${await focusedSourceHash()}`);
console.log("Smart SCM authoritative inventory gauntlet passed.");
