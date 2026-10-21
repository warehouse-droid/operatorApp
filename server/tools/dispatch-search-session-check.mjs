import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import coverage from "istanbul-lib-coverage";
import v8ToIstanbul from "v8-to-istanbul";

const out = "test-artifacts/dispatch-search-session";
mkdirSync(out, { recursive: true });
const phase = process.argv[2] || "current";
const browser = "test/dispatch/frontend/dispatch-search-session.browser.test.mjs";
const property = "test/dispatch/property/dispatch-search-session.property.test.js";
const files = [browser, property, "test/dispatch/frontend/dispatch-pool-session.browser.test.mjs",
  "test/dispatch/frontend/dispatch-planner-performance.contract.test.js",
  "test/dispatch/property/dispatch-edit-lease-session.property.test.js", "test/dispatch/unit/dispatch-history-mode.test.js"];

function run(name, program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60000, ...options });
  writeFileSync(`${out}/${name}.log`, (result.stdout || "") + (result.stderr || ""));
  assert.equal(result.error, undefined, `${name}: ${result.error}`);
  return result;
}
function report(result) {
  return { status: result.status, tests: Number(result.stdout.match(/^# tests (\d+)$/m)?.[1]),
    passed: Number(result.stdout.match(/^# pass (\d+)$/m)?.[1]),
    failures: [...result.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map(match => match[1]),
    skipped: Number(result.stdout.match(/^# skipped (\d+)$/m)?.[1]) };
}
const suites = report(run(`${phase}-suite`, process.execPath, ["--test", "--test-concurrency=1", ...files], {
  env: { ...process.env, DISPATCH_SEARCH_COVERAGE: resolve(`${out}/coverage-${phase}`) }
}));
writeFileSync(`${out}/${phase}-results.json`, JSON.stringify(suites, null, 2));
assert.equal(suites.skipped, 0);
if (phase === "baseline") {
  assert.ok(suites.failures.includes("off: historical searches find TOB01164 and TOB01163 with the leased tab session"));
  assert.match(readFileSync(`${out}/${phase}-suite.log`, "utf8"), /A dispatch browser session is required/);
  console.log(JSON.stringify(suites));
  process.exit(0);
}
const before = JSON.parse(readFileSync(`${out}/baseline-results.json`, "utf8"));
const newFailures = suites.failures.filter(name => !before.failures.includes(name));
assert.deepEqual(newFailures, []);
assert.ok(suites.failures.every(name => name.startsWith("DP-33 frontend:")), JSON.stringify(suites.failures));
const focused = report(run("focused", process.execPath, ["--test", "--test-concurrency=1", browser, property]));
assert.equal(focused.status, 0);

const source = readFileSync("public/dispatch.js", "utf8");
const baseline = readFileSync(`${out}/production-before/public/dispatch.js`, "utf8");
const mutants = [];
for (const [name, oldText, replacement] of [
  ["missing-session", 'params.set("sessionId", dispatchSessionId);', ""],
  ["missing-history-date", 'params.set("historyPlanDate", currentPlanDate);', ""],
  ["missing-lease-token", 'const headers = historyEditMode ? { "x-dispatch-edit-lease": planEditLeaseToken } : {};', "const headers = {};"]
]) {
  assert.equal(source.split(oldText).length, 2, `Ambiguous mutant ${name}`);
  const path = resolve(`${out}/mutant-${name}.js`);
  writeFileSync(path, source.replace(oldText, replacement));
  const result = run(`mutant-${name}`, process.execPath, ["--test", property], {
    env: { ...process.env, DISPATCH_SEARCH_SOURCE: path }
  });
  assert.equal(result.status, 1, `Surviving mutant ${name}`);
  assert.match(result.stdout, /ERR_ASSERTION/);
  mutants.push({ name, killedByProperty: true });
}
assert.equal(run("syntax", process.execPath, ["--check", "public/dispatch.js"]).status, 0);
const lintArgs = ["node_modules/eslint/bin/eslint.js", "--config", "tools/dispatch-fulfilled-so-eslint.config.mjs",
  "--format", "json", "--stdin", "--stdin-filename", "public/dispatch.js"];
const lintMessages = text => JSON.parse(text)[0].messages.map(({ ruleId, message, nodeType }) => ({ ruleId, message, nodeType }));
const baselineLint = lintMessages(run("lint-baseline", process.execPath, lintArgs, { input: baseline }).stdout);
const currentLint = lintMessages(run("lint-current", process.execPath, lintArgs, { input: source }).stdout);
const remainingLint = [...baselineLint];
const newLint = currentLint.filter(message => {
  const index = remainingLint.findIndex(old => JSON.stringify(old) === JSON.stringify(message));
  if (index < 0) return true;
  remainingLint.splice(index, 1);
  return false;
});
assert.deepEqual(newLint, []);
const baselineTypesFile = resolve(`${out}/baseline-types.js`);
writeFileSync(baselineTypesFile, baseline);
function types(label, path) {
  const result = run(`types-${label}`, process.execPath, ["node_modules/typescript/bin/tsc", "--allowJs", "true",
    "--checkJs", "true", "--noEmit", "true", "--skipLibCheck", "true", "--target", "ES2023",
    "--module", "NodeNext", "--pretty", "false", path]);
  assert.ok([0, 1, 2].includes(result.status));
  return (result.stdout + result.stderr).split("\n").filter(line => line.trim())
    .map(line => line.replace(/^.*?\(\d+,\d+\): /, "public/dispatch.js: "));
}
const allowedTypes = types("baseline", baselineTypesFile);
const currentTypes = types("current", "public/dispatch.js");
const newTypes = currentTypes.filter(message => {
  const index = allowedTypes.indexOf(message);
  if (index < 0) return true;
  allowedTypes.splice(index, 1);
  return false;
});
assert.deepEqual(newTypes, []);
const map = coverage.createCoverageMap({});
for (const entry of JSON.parse(readFileSync(`${out}/coverage-current/browser.json`))) {
  if (!entry.url.endsWith("/dispatch.js")) continue;
  assert.equal(entry.source, source);
  const converter = v8ToIstanbul(resolve("public/dispatch.js"), 0, { source });
  await converter.load();
  converter.applyCoverage(entry.functions);
  map.merge(converter.toIstanbul());
}
const lines = map.fileCoverageFor(resolve("public/dispatch.js")).getLineCoverage();
const diff = spawnSync("diff", ["-U0", `${out}/production-before/public/dispatch.js`, "public/dispatch.js"], { encoding: "utf8" }).stdout;
writeFileSync(`${out}/dispatch.diff`, diff);
const changed = { total: 0, covered: 0, uncovered: [] };
for (const match of diff.matchAll(/^@@ .* \+(\d+)(?:,(\d+))? @@/gm)) {
  for (let line = Number(match[1]); line < Number(match[1]) + Number(match[2] ?? 1); line++) {
    if (!Object.hasOwn(lines, line)) continue;
    changed.total++;
    if (lines[line]) changed.covered++;
    else changed.uncovered.push(line);
  }
}
assert.deepEqual(changed.uncovered, []);
const sourceHashes = Object.fromEntries(["public/dispatch.js", "public/dispatch.html"].map(path =>
  [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const result = { passed: true, suites, focused, newFailures, mutants, changedLineCoverage: changed,
  lint: { existing: baselineLint.length, newFindings: newLint },
  types: { existing: currentTypes.length, newDiagnostics: newTypes }, sourceHashes,
  tools: { node: process.version,
    playwright: JSON.parse(readFileSync("node_modules/@playwright/test/package.json")).version,
    typescript: JSON.parse(readFileSync("node_modules/typescript/package.json")).version } };
writeFileSync(`${out}/validation.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
