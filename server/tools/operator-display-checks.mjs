import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { production, unit, database, browser } from "./operator-display-files.mjs";
import { mutants } from "../test/support/operator-display-mutation-loader.mjs";

const output = "test-artifacts/operator-display-fix/final";
mkdirSync(output, { recursive: true });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const read = (file) => readFileSync(file, "utf8");
const json = (file) => JSON.parse(read(file));
const save = (name, value) => writeFileSync(`${output}/${name}.json`, JSON.stringify(value, null, 2));

function source() {
  const files = [...production, ...unit, ...database, browser,
    "test/support/operator-display-refresh-fixture.mjs", "test/support/operator-display-mutation-loader.mjs",
    "test/operator-display-refresh-spec.md", "test/support/operator-display-changes.json",
    "test/support/operator-display-baseline-failures.json", "test/support/operator-display-static-baseline.json",
    ...readdirSync("tools").filter((name) => name.startsWith("operator-display-")).map((name) => `tools/${name}`)];
  return Object.fromEntries(files.map((file) => [file, hash(read(file))]));
}

function focused() {
  const args = ["--all=false", "--check-coverage=false", ...production.filter((file) => file.endsWith(".js")).map((file) => `--include=${file}`),
    `--temp-directory=${output}/c8`, `--report-dir=${output}/coverage`, "--reporter=text", "--reporter=json-summary", "--reporter=json",
    "node", "--test", "--test-concurrency=1", ...unit, ...database];
  const result = spawnSync("node_modules/.bin/c8", args, { stdio: "inherit" });
  assert.equal(result.status, 0, "Focused suite failed");
}

function fullComparison() {
  const baseline = json("test/support/operator-display-baseline-failures.json");
  const log = read(`${output}/full.log`);
  const failedTests = [...new Set(log.split("\n").filter((line) => line.startsWith("✖ ") && line !== "✖ failing tests:")
    .map((line) => line.slice(2).replace(/ \([0-9.]+ms\)$/u, "")))].sort();
  const unexpected = failedTests.filter((name) => !baseline.failedTests.includes(name));
  assert.match(log, /Isolated MBT main run (?:passed|failed)/u, "Full suite did not finish");
  const counts = [...log.matchAll(/ℹ (tests|pass|fail|skipped) (\d+)/gu)].reduce((totals, match) => {
    totals[match[1]] = (totals[match[1]] || 0) + Number(match[2]); return totals;
  }, {});
  save("full-comparison", { counts, baselineFailedFiles: baseline.failedFiles, failedTests, unexpected });
  assert.deepEqual(unexpected, [], "New full-suite failures");
  console.log(JSON.stringify({ ...counts, newFailures: unexpected.length, existingFailureNames: failedTests.length }));
}

function mutation() {
  const before = source();
  const results = [];
  for (const name of Object.keys(mutants)) {
    const args = ["--experimental-loader", "./test/support/operator-display-mutation-loader.mjs", "--test", "--test-concurrency=1",
      "--test-name-pattern=random|sales residual", "test/mbt/unit/operator-delivery-reference.test.js", "test/mbt/unit/operator-delivery-refresh.test.js"];
    const result = spawnSync(process.execPath, args, { env: { ...process.env, DISPLAY_FIX_MUTANT: name }, encoding: "utf8" });
    const log = result.stdout + result.stderr;
    writeFileSync(`${output}/mutant-${name}.log`, log);
    const killed = result.status === 1 && log.includes("not ok") && log.includes("Counterexample:");
    results.push({ name, killed, propertySuiteOnly: true });
  }
  save("mutations", results);
  assert.ok(results.every((result) => result.killed), JSON.stringify(results));
  assert.deepEqual(source(), before, "Mutation altered on-disk source");
  console.log(JSON.stringify(results));
}

function coverageEntries() {
  const entries = [];
  for (const file of readdirSync(`${output}/browser`).filter((name) => name.endsWith(".coverage.json"))) {
    entries.push(...json(`${output}/browser/${file}`).map((entry) => ({ ...entry, browser: true })));
  }
  for (const file of readdirSync(`${output}/c8`).filter((name) => name.endsWith(".json"))) {
    entries.push(...(json(`${output}/c8/${file}`).result || []));
  }
  return entries;
}

function coveredOffset(entry, offset) {
  if (entry.browser && entry.ranges) { return entry.ranges.some((range) => range.start <= offset && offset < range.end); }
  const ranges = entry.functions.flatMap((fn) => fn.ranges)
    .filter((range) => range.startOffset <= offset && offset < range.endOffset)
    .sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));
  return ranges[0]?.count > 0;
}

function coverage() {
  const changes = json("test/support/operator-display-changes.json");
  const entries = coverageEntries();
  const report = [];
  for (const file of changes.filter((item) => item.file.endsWith(".js"))) {
    const text = read(file.file);
    assert.equal(hash(text), file.sha256, "Changed-line manifest is stale");
    const matching = entries.filter((entry) => {
      try { return new URL(entry.url).pathname.endsWith(`/${file.file}`) || new URL(entry.url).pathname === `/${file.file.replace(/^public\//u, "")}`; }
      catch { return false; }
    });
    let position = 0;
    const offsets = text.split("\n").map((line) => { const offset = position + Math.max(0, line.search(/\S/u)); position += line.length + 1; return offset; });
    const missing = file.lines.filter((line) => !matching.some((entry) => coveredOffset(entry, offsets[line - 1])));
    report.push({ file: file.file, total: file.lines.length, covered: file.lines.length - missing.length, missing });
  }
  save("changed-coverage", report);
  console.log(JSON.stringify(report));
  assert.ok(report.every((file) => file.missing.length === 0), "Changed executable lines need coverage");
}

const commands = {
  focused, mutation, coverage, compare: fullComparison,
  source: () => save("source", source()),
  verify: () => assert.deepEqual(source(), json(`${output}/source.json`), "Source changed during verification"),
  health: () => {
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...[...unit].reverse()], { stdio: "inherit" });
    assert.equal(result.status, 0);
  }
};
assert.ok(commands[process.argv[2]], "Unknown display check");
commands[process.argv[2]]();
