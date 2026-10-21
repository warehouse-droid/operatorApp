import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const root = process.cwd();
const artifact = path.join(root, "test-artifacts");
function run(label, args, options = {}) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: "utf8", timeout: 240000, ...options });
  fs.writeFileSync(path.join(artifact, `${label}.log`), `${result.stdout || ""}${result.stderr || ""}`);
  assert.equal(result.status, 0, `${label} failed: ${result.stderr || result.stdout}`);
  console.log(`${label}: passed`);
  return result;
}
const files = [
  "test/mbt/integration/local-vrma-final-qty.test.js",
  "test/mbt/unit/local-vrma-final-qty-ui.test.js",
  "test/mbt/unit/load-followup.test.js",
  "test/mbt/integration/load-followup.test.js",
  "test/mbt/unit/vrma-confirm-encoding.test.js",
  "test/mbt/integration/vrma-confirm-encoding.test.js",
  "test/mbt/integration/consolidation-load.test.js",
  "src/scm-vrma-harness.js",
  "src/scm-vrma-remove-harness.js"
];
fs.rmSync(path.join(artifact, "coverage"), { recursive: true, force: true });
run("regression", ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
  "--include=src/delivery-repository.js", "--include=src/operator-load-state.js",
  `--temp-directory=${artifact}/coverage/tmp`, `--report-dir=${artifact}/coverage`, "--reporter=json", "--reporter=text",
  "node", "--test", "--test-concurrency=1", ...files]);
run("browser", ["--test", "test/dispatch/frontend/local-vrma-final-qty.browser.test.mjs"]);
const baselineRoot = "/workspace/server/deployments/local-vrma-final-qty-20261019/before";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "local-vrma-baseline-"));
try {
  for (const dir of ["src", "public", "migrations"]) { fs.cpSync(path.join(baselineRoot, dir), path.join(scratch, dir), { recursive: true }); }
  fs.cpSync("test", path.join(scratch, "test"), { recursive: true });
  fs.copyFileSync("package.json", path.join(scratch, "package.json"));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(scratch, "node_modules"));
  const failures = [];
  for (const [label, cwd] of [["reopen-baseline", scratch], ["reopen-candidate", root]]) {
    const result = spawnSync(process.execPath, ["--test", "test/dispatch/integration/control-order-reopen-local.test.js"],
      { cwd, env: process.env, encoding: "utf8", timeout: 60000 });
    assert.equal(result.signal, null);
    fs.writeFileSync(path.join(artifact, `${label}.log`), `${result.stdout || ""}${result.stderr || ""}`);
    failures.push([...result.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map(match => match[1]));
    if (result.status !== 0) { assert.ok(failures.at(-1).length, `${label} failed outside test assertions`); }
  }
  assert.deepEqual(failures[1], failures[0], "No new failures permitted in the pre-existing reopen suite");
  fs.writeFileSync(path.join(artifact, "baseline-failures.json"), JSON.stringify({ baseline: failures[0], candidate: failures[1] }, null, 2));
  console.log(`Reopen regression: ${failures[0].length} unchanged baseline failures; zero new failures.`);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
for (const file of ["src/delivery-repository.js", "src/operator-load-state.js", "public/operator.js"]) {
  run(`syntax-${path.basename(file)}`, ["--check", file]);
}
run("types", ["node_modules/typescript/bin/tsc", "--allowJs", "--checkJs", "--noEmit", "--skipLibCheck",
  "--target", "ES2022", "--module", "nodenext", "src/operator-load-state.js"]);
run("lint-tests", ["node_modules/eslint/bin/eslint.js", "--config", "eslint.mbt.config.js", "--max-warnings=0",
  "test/mbt/integration/local-vrma-final-qty.test.js", "test/mbt/unit/local-vrma-final-qty-ui.test.js"]);
run("static-delta", ["tools/local-vrma-final-qty-static.mjs"]);
run("mutations", ["tools/local-vrma-final-qty-mutations.mjs"]);
run("changed-line-coverage", ["tools/local-vrma-final-qty-coverage.mjs"]);
const changed = ["src/delivery-repository.js", "src/operator-load-state.js", "public/operator.js"];
const hashes = Object.fromEntries(changed.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
fs.writeFileSync(path.join(artifact, "source-hashes.json"), JSON.stringify({ node: process.version, hashes }, null, 2));
console.log("Scoped VRMA suite passed.");
