import assert from "node:assert/strict";
import path from "node:path";
import { cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { buildIsolatedTestEnvironment } from "../test/support/test-foundation.mjs";
import { runNodeTestFilesIsolated } from "../test/support/test-database-isolation.mjs";

const artifact = path.resolve("test-artifacts/executed-review-active-lines");
const baseline = "/workspace/server/test-artifacts/executed-review-active-lines/baseline";
const production = ["src/dispatch-repository.js", "src/dispatch-executed-order-review-repository.js",
  "src/dispatch-executed-order-review.js", "public/dispatch.js"];
const regression = "test/dispatch/integration/dispatch-executed-review-active-lines.test.js";
const property = "test/dispatch/property/dispatch-planned-source-review.test.js";
const frontend = "test/dispatch/frontend/dispatch-source-replan-notice.test.js";
const regressions = [regression, property, frontend];
const environment = buildIsolatedTestEnvironment(process.env, { databaseUrl: process.env.DATABASE_URL });
mkdirSync(artifact, { recursive: true });

function command(args, options = {}) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 40 * 1024 * 1024, ...options });
  if (result.error) { throw result.error; }
  return result;
}

function sourceCopy() {
  const target = mkdtempSync(path.join(tmpdir(), "executed-active-lines-"));
  for (const name of ["src", "public", "test", "tools", "contracts", "migrations"]) {
    cpSync(name, path.join(target, name), { recursive: true });
  }
  for (const name of ["package.json", "tsconfig.mbt.json", "eslint.mbt.config.js"]) {
    cpSync(name, path.join(target, name));
  }
  symlinkSync(path.resolve("node_modules"), path.join(target, "node_modules"));
  mkdirSync(path.join(target, "test-artifacts"));
  return target;
}

async function suites() {
  const files = [...regressions,
    "test/dispatch/integration/dispatch-fulfilled-so-planning.test.js",
    "test/dispatch/integration/dispatch-fulfilled-so-http.test.js",
    "test/dispatch/concurrency/dispatch-fulfilled-so-planning.test.js",
    "test/dispatch/unit/dispatch-fulfilled-so-policy.test.js"
  ];
  const reviewSuite = readFileSync("tools/executed-order-review-suites.mjs", "utf8");
  files.push(...[...reviewSuite.matchAll(/"(test\/[^"]+\.(?:js|mjs))"/gu)].map(match => match[1]));
  let seed = 28092026;
  for (let index = files.length - 1; index > 0; index--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const other = seed % (index + 1);
    [files[index], files[other]] = [files[other], files[index]];
  }
  const current = await capturedSuite(files, process.cwd(), "Current source lines and adjacent Dispatch behavior");
  let before = { failures: [] };
  if (current.failures.length) {
    const target = sourceCopy();
    try {
      for (const file of production) { cpSync(path.join(baseline, path.basename(file)), path.join(target, file)); }
      before = await capturedSuite(files.filter(file => !regressions.includes(file)), target, "Pre-change Dispatch baseline");
    } finally { rmSync(target, { recursive: true, force: true }); }
    assert.deepEqual(current.failures, before.failures, "no new regression failures");
  }
  writeFileSync(path.join(artifact, "suites.json"), JSON.stringify({ current, baseline: before }, null, 2));
  console.log(JSON.stringify({ suites: "no new failures", ...current }));
}

async function capturedSuite(files, root, label) {
  let output = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => { output += String(chunk); return write(chunk, ...args); };
  let status;
  try { status = await runNodeTestFilesIsolated(files.map(file => path.join(root, file)), { environment, label }); }
  finally { process.stdout.write = write; }
  const failures = [...new Set([...output.matchAll(/^✖ (.+) \([\d.]+ms\)$/gmu)].map(match => match[1]))].sort();
  assert.equal(status === 0, failures.length === 0, "all failed processes must report test failures");
  const sum = key => [...output.matchAll(new RegExp(`^ℹ ${key} (\\d+)$`, "gmu"))].reduce((total, match) => total + Number(match[1]), 0);
  return { tests: sum("tests"), passed: sum("pass"), failed: sum("fail"), failures };
}

async function mutations() {
  const mutants = [
    [production[1], "includeInactiveSalesOrderLines: false", "includeInactiveSalesOrderLines: true"],
    [production[0], "$11::boolean AND $12::boolean AND o.order_type", "$11::boolean AND o.order_type"],
    [production[0], "WHEN $12::boolean AND (($2::boolean", "WHEN (($2::boolean"],
    [production[0], "includeInactiveSalesOrderLines = true", "includeInactiveSalesOrderLines = false"],
    [production[1], "const contexts = plannedOrderContexts(plan);", "const contexts = [];"],
    [production[1], "const reviews = buildExecutedOrderReviews(", "const reviews = buildPlannedOrderReviews("],
    [production[2], "replanRequested: review.contexts.some", "replanRequested: false && review.contexts.some"],
    [production[3], "review.replanRequested ? \"re-plan requested\"", "false ? \"re-plan requested\""]
  ];
  for (const [index, [file, from, to]] of mutants.entries()) {
    const target = sourceCopy();
    try {
      const original = readFileSync(path.join(target, file), "utf8");
      assert.equal(original.split(from).length, 2, `unique mutation target ${index}`);
      writeFileSync(path.join(target, file), original.replace(from, to));
      assert.equal(command(["--check", path.join(target, file)]).status, 0);
      const test = index === 6 ? property : index === 7 ? frontend : regression;
      const result = await runNodeTestFilesIsolated([path.join(target, test)], {
        environment, label: `Active lines mutant ${index + 1}`
      });
      assert.equal(result, 1, `mutant ${index + 1} must fail behavioral assertions`);
    } finally { rmSync(target, { recursive: true, force: true }); }
  }
  console.log("Active lines and re-plan mutations killed: 8/8");
}

function staticChecks() {
  const target = sourceCopy();
  try {
    for (const file of production) { cpSync(path.join(baseline, path.basename(file)), path.join(target, file)); }
    const lintFiles = [...production, ...regressions, "tools/executed-review-active-lines-check.mjs"];
    const config = `import base from './tools/executed-order-review-eslint.config.mjs'; export default [{...base[0],files:${JSON.stringify(lintFiles)}}];`;
    const currentConfig = path.join(artifact, "eslint.config.mjs");
    writeFileSync(currentConfig, config.replace("'./tools/executed-order-review-eslint.config.mjs'", JSON.stringify(path.resolve("tools/executed-order-review-eslint.config.mjs"))));
    const baselineConfig = path.join(target, "eslint.config.mjs");
    writeFileSync(baselineConfig, config);
    const summaries = [];
    for (const [label, cwd, eslintConfig] of [["baseline", target, baselineConfig], ["current", process.cwd(), currentConfig]]) {
      const lint = command(["node_modules/eslint/bin/eslint.js", "--config", eslintConfig, "--format", "json", ...lintFiles], { cwd });
      assert.equal(lint.stderr, "");
      const lintMessages = JSON.parse(lint.stdout).flatMap(file => file.messages.map(message => ({
        file: path.relative(cwd, file.filePath), rule: message.ruleId,
        message: message.message.replace(/on line \d+ column \d+/gu, "on line,column"), severity: message.severity
      })));
      const types = command(["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"], { cwd });
      assert.equal(types.stderr, "");
      writeFileSync(path.join(artifact, `${label}-lint.json`), lint.stdout);
      writeFileSync(path.join(artifact, `${label}-types.log`), types.stdout);
      const diagnostics = types.stdout.replace(/^(?:\.\.\/)+app\//gmu, "").trim().split(/\n(?=\S)/u);
      summaries.push({ lint: lintMessages, types: [...new Set(diagnostics)].sort() });
    }
    assert.deepEqual(summaries[1], summaries[0], "no new static diagnostics");
    assert.equal(summaries[1].lint.filter(message => [...regressions, "tools/executed-review-active-lines-check.mjs"].includes(message.file)).length, 0);
    for (const file of lintFiles) {
      assert.equal(command(["--check", file]).status, 0, file);
    }
    console.log(JSON.stringify({ static: "no new diagnostics", existingLint: summaries[1].lint.length,
      existingTypeDiagnostics: summaries[1].types.filter(line => /error TS/u.test(line)).length }));
  } finally { rmSync(target, { recursive: true, force: true }); }
}

const phase = process.argv[2] || "all";
if (["all", "suites"].includes(phase)) { await suites(); }
if (["all", "mutations"].includes(phase)) { await mutations(); }
if (["all", "static"].includes(phase)) { staticChecks(); }
if (phase === "coverage") {
  assert.equal(await runNodeTestFilesIsolated([...regressions,
    "test/dispatch/integration/dispatch-executed-order-review.test.js",
    "test/dispatch/frontend/dispatch-executed-order-review.browser.test.mjs"
  ].map(file => path.resolve(file)), { environment, label: "Source notices coverage" }), 0);
}
writeFileSync(path.join(artifact, "source-hashes.json"), JSON.stringify(Object.fromEntries([...production, ...regressions,
  "tools/executed-review-active-lines-check.mjs"].map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])), null, 2));
