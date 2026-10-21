import assert from "node:assert/strict";
import path from "node:path";
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";

const artifact = path.resolve("test-artifacts/dispatch-weight-notices");
const production = ["src/dispatch-executed-order-review.js", "src/dispatch-executed-order-review-repository.js"];
const regression = "test/dispatch/integration/dispatch-weight-source-review.test.js";
const files = [regression, "test/dispatch/integration/dispatch-executed-review-active-lines.test.js",
  "test/dispatch/integration/dispatch-executed-order-review.test.js",
  "test/dispatch/property/dispatch-planned-source-review.test.js",
  "test/dispatch/frontend/dispatch-source-replan-notice.test.js",
  "test/dispatch/frontend/dispatch-executed-order-review.browser.test.mjs"];
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
mkdirSync(artifact, { recursive: true });

function command(args, options = {}) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 40 * 1024 * 1024, ...options });
  if (result.error) { throw result.error; }
  return result;
}

function sourceCopy() {
  const target = mkdtempSync(path.join(tmpdir(), "dispatch-weight-review-"));
  for (const name of ["src", "public", "test", "tools", "contracts", "migrations"]) {
    cpSync(name, path.join(target, name), { recursive: true });
  }
  for (const name of ["package.json", "tsconfig.mbt.json", "eslint.mbt.config.js"]) { cpSync(name, path.join(target, name)); }
  symlinkSync(path.resolve("node_modules"), path.join(target, "node_modules"));
  mkdirSync(path.join(target, "test-artifacts"));
  return target;
}

async function mutations() {
  const mutants = [
    [production[0], 'return changes.filter(change => change.field !== "weight");', 'return changes.filter(() => true);'],
    [production[1], 'if (!reviewableSourceChanges(row.changes).length) {return false;}', 'if (false) {return false;}'],
    [production[1], 'if (stored.some(row => matchesSourceNotice(row, review))) {continue;}', 'if (false) {continue;}'],
    [production[1], 'sourceReviewChangesDigest(row.changes) === sourceReviewChangesDigest(notice.changes)', 'true']
  ];
  for (const [index, [file, from, to]] of mutants.entries()) {
    const target = sourceCopy();
    try {
      const original = readFileSync(path.join(target, file), "utf8");
      assert.equal(original.split(from).length, 2);
      writeFileSync(path.join(target, file), original.replace(from, to));
      assert.equal(command(["--check", path.join(target, file)]).status, 0);
      assert.equal(await runNodeTestFilesIsolated([path.join(target, regression)], {
        environment, label: `Weight review mutant ${index + 1}`
      }), 1);
    } finally { rmSync(target, { recursive: true, force: true }); }
  }
  console.log("Weight review mutations killed: 4/4");
}

function staticChecks() {
  const target = sourceCopy();
  try {
    for (const file of production) { cpSync(path.join("/workspace/server/test-artifacts/dispatch-weight-notices/baseline", path.basename(file)), path.join(target, file)); }
    const lintFiles = [...production, regression, "tools/dispatch-weight-review-check.mjs"];
    const config = `import base from './tools/executed-order-review-eslint.config.mjs'; export default [{...base[0],files:${JSON.stringify(lintFiles)}}];`;
    const currentConfig = path.join(artifact, "eslint.config.mjs");
    writeFileSync(currentConfig, config.replace("'./tools/executed-order-review-eslint.config.mjs'", JSON.stringify(path.resolve("tools/executed-order-review-eslint.config.mjs"))));
    const baselineConfig = path.join(target, "eslint.config.mjs");
    writeFileSync(baselineConfig, config);
    const summaries = [];
    for (const [label, cwd, eslintConfig] of [["baseline", target, baselineConfig], ["current", process.cwd(), currentConfig]]) {
      const lint = command(["node_modules/eslint/bin/eslint.js", "--config", eslintConfig, "--format", "json", ...lintFiles], { cwd });
      assert.equal(lint.stderr, "");
      const messages = JSON.parse(lint.stdout).flatMap(file => file.messages.map(message => ({
        file: path.relative(cwd, file.filePath), rule: message.ruleId,
        message: message.message.replace(/on line \d+ column \d+/gu, "on line,column"), severity: message.severity
      })));
      const types = command(["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"], { cwd });
      assert.equal(types.stderr, "");
      writeFileSync(path.join(artifact, `${label}-lint.json`), lint.stdout);
      writeFileSync(path.join(artifact, `${label}-types.log`), types.stdout);
      const diagnostics = types.stdout.replace(/^(?:\.\.\/)+app\//gmu, "").trim().split(/\n(?=\S)/u);
      summaries.push({ lint: messages, types: [...new Set(diagnostics)].sort() });
    }
    assert.deepEqual(summaries[1], summaries[0], "no new static diagnostics");
    assert.equal(summaries[1].lint.filter(message => [regression, "tools/dispatch-weight-review-check.mjs"].includes(message.file)).length, 0);
    for (const file of lintFiles) { assert.equal(command(["--check", file]).status, 0); }
    console.log(JSON.stringify({ static: "no new diagnostics", existingLint: summaries[1].lint.length,
      existingTypeDiagnostics: summaries[1].types.filter(line => /error TS/u.test(line)).length }));
  } finally { rmSync(target, { recursive: true, force: true }); }
}

const phase = process.argv[2] || "all";
if (["all", "coverage"].includes(phase)) {
  assert.equal(await runNodeTestFilesIsolated(files.map(file => path.resolve(file)), { environment, label: "Weight notices" }), 0);
}
if (["all", "mutations"].includes(phase)) { await mutations(); }
if (["all", "static"].includes(phase)) { staticChecks(); }
writeFileSync(path.join(artifact, "source-hashes.json"), JSON.stringify(Object.fromEntries([...production, regression,
  "tools/dispatch-weight-review-check.mjs"].map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])), null, 2));
