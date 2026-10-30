import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

assert.equal(process.env.MBT_TEST_ISOLATED, "1", "Run only in the disposable test environment");
const output = "/app/test-artifacts/mbt-aggregate";
mkdirSync(output, { recursive: true });
const source = ["src/mbt/aggregate-density.js", "src/mbt/customer-charge-calculator.js",
  "src/mbt/customer-charge-request-service.js", "src/mbt/local-master-data-service.js",
  "src/mbt/local-item-settings-repository.js", "public/mbt-config.html", "public/mbt-shell.js"];
const summary = { toolchain: { node: process.version, ...Object.fromEntries(["typescript", "eslint", "c8", "fast-check", "@playwright/test"].map((name) =>
  [name, JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version])) },
  sourceHashes: Object.fromEntries(source.map((file) => [file,
  createHash("sha256").update(readFileSync(file)).digest("hex")])), stages: {} };

function run(name, command, args, extra = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 180000,
    maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...extra } });
  const log = `${result.stdout || ""}${result.stderr || ""}`;
  writeFileSync(`${output}/${name}.log`, log);
  summary.stages[name] = { status: result.status, summary: log.split("\n").filter((line) =>
    /^(# (tests|pass|fail|skipped)|.*(?:passed|failed) \(|.*coverage|Statements|Branches|Functions|Lines)/u.test(line)) };
  console.log(JSON.stringify({ stage: name, ...summary.stages[name] }));
  return { ...result, log };
}

function pass(result) {
  if (result.status !== 0) {
    console.error(result.log.split("\n").flatMap((line, index, lines) =>
      line.startsWith("not ok") ? lines.slice(index, index + 30) : []).join("\n"));
    console.error(result.log.slice(-16000));
    throw new Error(`Check failed: ${result.status}`);
  }
}

const suites = ["unit", "property", "integration"];
const files = suites.flatMap((suite) => readdirSync(`test/mbt/${suite}`).filter((file) =>
  /^(aggregate-standard|customer-charge|item-charge|local-item|local-master).*\.test\.js$/u.test(file))
  .sort().map((file) => `test/mbt/${suite}/${file}`));
const coverage = ["--all=false", "--check-coverage=false", `--reports-dir=${output}/coverage`,
  `--temp-directory=${output}/v8`, "--reporter=json", "--reporter=json-summary", "--reporter=text-summary"];
pass(run("tests", "node", ["--test", "--test-concurrency=1", ...files]));
// Static UI contract tests only read source text. V8 coverage can stall on
// shutdown for those tests; collect execution coverage from the runtime suites.
const runtimeTests = files.filter((file) => !/ui|page-contract/u.test(file));
pass(run("coverage", "node_modules/.bin/c8", [...coverage, "node", "--test", "--test-concurrency=1", ...runtimeTests]));
for (const file of source.filter((entry) => entry.endsWith(".js"))) {
  pass(run(`syntax-${file.replaceAll("/", "-")}`, "node", ["--check", file]));
}
pass(run("lint", "node_modules/.bin/eslint", ["--config", "eslint.mbt.config.js", "--max-warnings=0",
  ...source.filter((file) => file.startsWith("src/")), "test/mbt/unit/aggregate-standard.test.js",
  "test/support/mbt-aggregate-mutation-loader.mjs", "tools/mbt-aggregate-checks.mjs"]));
pass(run("types", "node_modules/.bin/tsc", ["--allowJs", "--noEmit", "--target", "ES2023", "--module", "NodeNext",
  "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", ...source.filter((file) => file.startsWith("src/"))]));
for (const name of ["density", "prefix", "length", "duplicate", "historical"]) {
  const result = run(`mutation-${name}`, "node", ["--loader", "./test/support/mbt-aggregate-mutation-loader.mjs",
    "--test", "test/mbt/unit/aggregate-standard.test.js"], { MBT_AGGREGATE_MUTANT: name });
  assert.equal(result.status, 1, `${name} must be rejected`);
  assert.match(result.log, /failureType: 'testCodeFailure'/u, "Mutation must fail on a test assertion");
  assert.doesNotMatch(result.log, /Mutation must match|ERR_MODULE_NOT_FOUND/u);
  const property = run(`property-mutation-${name}`, "node", ["--loader", "./test/support/mbt-aggregate-mutation-loader.mjs",
    "--test", "--test-name-pattern=fractional quantities", "test/mbt/unit/aggregate-standard.test.js"],
  { MBT_AGGREGATE_MUTANT: name });
  assert.ok(property.status === 0 || property.status === 1, "Property mutation completed");
  assert.doesNotMatch(property.log, /Mutation must match|ERR_MODULE_NOT_FOUND/u);
}
pass(run("suite-health", "node", ["--test", "--test-concurrency=1",
  ...files.filter((file) => !file.includes("/integration/")).reverse()]));

assert.ok(existsSync("/ms-playwright"), "Browser layer requires the repository test-e2e image");
const web = spawn("node", ["--input-type=module", "-e",
  "import express from 'express'; const app=express(); app.get('/mbt/config',(_q,r)=>r.sendFile('/app/public/mbt-config.html')); app.use(express.static('/app/public')); app.listen(3107,'127.0.0.1');"],
{ stdio: "ignore" });
try {
  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
    ready = await fetch("http://127.0.0.1:3107/mbt/config").then((response) => response.ok).catch(() => false);
    if (!ready) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.ok(ready, "Browser fixture server started");
  pass(run("browser", "node_modules/.bin/playwright", ["test", "--config", "test/playwright.config.mjs",
    "p3-config-friendly-editor.spec.js", "--project=chromium-desktop", "--grep", "item-owned setup"],
  { MBT_TEST_BASE_URL: "http://127.0.0.1:3107", MBT_TEST_TRUSTED_PROXY_TARGET: "", PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright" }));
} finally {
  web.kill("SIGTERM");
}
const changes = JSON.parse(readFileSync("/app/test-artifacts/changed-lines.json", "utf8"));
const coverageReport = JSON.parse(readFileSync(`${output}/coverage/coverage-final.json`, "utf8"));
summary.changedLineCoverage = {};
for (const file of source.filter((entry) => entry.startsWith("src/"))) {
  const instrumented = coverageReport[`/app/${file}`];
  assert.ok(instrumented, `Coverage is present for ${file}`);
  const hits = new Map();
  for (const [key, location] of Object.entries(instrumented.statementMap)) {
    for (let line = location.start.line; line <= location.end.line; line += 1) {
      hits.set(line, Math.max(hits.get(line) || 0, instrumented.s[key]));
    }
  }
  const measured = changes[file].filter((line) => hits.has(line));
  const missed = measured.filter((line) => hits.get(line) === 0);
  summary.changedLineCoverage[file] = { covered: measured.length - missed.length, measured: measured.length, missed,
    uninstrumented: changes[file].filter((line) => !hits.has(line)) };
  assert.deepEqual(missed, [], `Changed lines must execute in ${file}`);
}
writeFileSync(`${output}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
