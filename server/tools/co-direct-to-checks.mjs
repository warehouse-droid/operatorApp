import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { mutants } from "../test/support/co-direct-to-mutations.mjs";
import { withCoTestDatabase } from "../test/support/co-direct-to-isolation.mjs";

const artifact = "test-artifacts/co-direct-to";
const testFile = "test/dispatch/integration/co-direct-to.test.js";
const sourceFiles = ["src/co-direct-to-cargo.js", "src/dispatch-local-co-cargo.js", "src/dispatch-repository.js",
  "src/delivery-repository.js", "src/scm-dependency-command-service.js"];
const hash = value => createHash("sha256").update(value).digest("hex");
const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, await readFile(file, "utf8")])));
await mkdir(`${artifact}/mutants`, { recursive: true });
const finish = process.argv.includes("--finish");
if (finish) {
  const frozen = await readFile(`${artifact}/final-source.sha256`, "utf8");
  for (const file of sourceFiles) {
    assert.ok(frozen.includes(`${hash(sources[file])}  server/${file}\n`), "Behavioral source changed; run all checks again");
  }
}

async function run(name, args, env = {}, allowFailure = false) {
  if (finish && /^(?:coverage$|final-focused$|reverse-|(?:handoff-)?(?:property-)?mutant-)/u.test(name)) {
    const output = await readFile(`${artifact}/${name}.log`, "utf8");
    const failure = output.match(/^# fail (\d+)$/mu);
    assert.ok(failure, `${name}: no completed TAP result to reuse`);
    const status = Number(failure[1]) > 0 ? 1 : 0;
    if (!allowFailure) {assert.equal(status, 0, `${name} has an unresolved failure`);}
    return { status, output };
  }
  const execute = databaseUrl => spawnSync(process.execPath, args, {
    env: { ...process.env, ...env, DATABASE_URL: databaseUrl }, encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
  const result = args.includes("--test") ? await withCoTestDatabase(name, execute) : execute(process.env.DATABASE_URL);
  const output = result.stdout + result.stderr;
  await writeFile(`${artifact}/${name}.log`, output);
  if (!allowFailure) {assert.equal(result.status, 0, `${name} failed; inspect its log`);}
  return { ...result, output };
}

const adjacent = [testFile,
  "test/dispatch/integration/co-source-packing-handoff.test.js",
  "test/dispatch/integration/scm-to-untouched-lines.test.js",
  "test/dispatch/integration/dispatch-co-cargo-preservation.test.js",
  "test/dispatch/integration/dispatch-co-global-lifecycle.red.test.js",
  "test/dispatch/integration/dispatch-co-driver-completion-lifecycle.red.test.js",
  "test/dispatch/integration/order-dependency-multi-to-extension.red.test.js",
  "test/dispatch/frontend/dispatch-co-cargo-preservation.test.js",
  "test/dispatch/frontend/direct-to-same-yard.test.js"
];
await run("coverage", ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
  ...sourceFiles.map(file => `--include=${file}`), `--report-dir=${artifact}/coverage`,
  `--temp-directory=/tmp/direct-to-c8-${process.pid}`, "--reporter=json", "--reporter=text",
  process.execPath, "--test", "--test-concurrency=1", ...adjacent]);

const kills = [];
const propertyKills = [];
const propertySurvivors = [];
for (const name of Object.keys(mutants)) {
  const env = { CO_DIRECT_TO_MUTANT: name };
  const args = ["--experimental-loader", "./test/support/co-direct-to-mutations.mjs", "--test"];
  const result = await run(`mutant-${name}`, [...args, testFile], env, true);
  assert.notEqual(result.status, 0, `${name} survived`);
  assert.match(result.output, /ERR_ASSERTION|Property failed after/u);
  assert.doesNotMatch(result.output, /Invalid mutation anchor|SyntaxError|ERR_MODULE_NOT_FOUND/u);
  kills.push(name);
  const property = await run(`property-mutant-${name}`, [...args, "--test-name-pattern=generated", testFile], env, true);
  if (property.status) {
    assert.match(property.output, /Property failed after/u);
    propertyKills.push(name);
  } else {propertySurvivors.push(name);}
}

for (const [index, file] of adjacent.toReversed().entries()) {await run(`reverse-${index}`, ["--test", file]);}
await run("final-focused", ["--test", "--test-concurrency=1", ...adjacent]);
for (const file of sourceFiles) {await run(`syntax-${file.split("/").pop()}`, ["--check", file]);}
const browser = JSON.parse(await readFile(`${artifact}/browser.json`, "utf8"));
assert.equal(browser.length, 2);
assert.ok(browser.every(row => row.cardVisible));
assert.equal(browser.find(row => row.mode === "packed").lines.length, 5);
assert.deepEqual(browser.find(row => row.mode === "active").lines, [{ item: 1784, quantity: 6 }]);
await run("lint", ["node_modules/eslint/bin/eslint.js", "--config", "tools/co-direct-to-eslint.config.mjs",
  "--max-warnings=0", ...sourceFiles, testFile, "test/support/co-direct-to-fixture.mjs",
  "test/support/co-direct-to-mutations.mjs", "test/support/co-direct-to-isolation.mjs",
  "tools/co-direct-to-checks.mjs", "tools/co-direct-to-browser.mjs"]);

const coverage = JSON.parse(await readFile(`${artifact}/coverage/coverage-final.json`, "utf8"));
const changedLineCoverage = {};
for (const file of sourceFiles) {
  const beforeFile = file === "src/co-direct-to-cargo.js" ? "/dev/null" : `${artifact}/baseline/${file}`;
  const patch = spawnSync("diff", ["-U0", beforeFile, file], { encoding: "utf8" }).stdout;
  const changed = [];
  for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
    for (let n = 0; n < Number(match[2] ?? 1); n += 1) {changed.push(Number(match[1]) + n);}
  }
  assert.ok(changed.length);
  const c = Object.values(coverage).find(entry => entry.path.endsWith(`/${file}`));
  assert.ok(c, `${file} coverage missing`);
  const executable = changed.filter(line => Object.values(c.statementMap).some(loc => loc.start.line <= line && loc.end.line >= line));
  const missing = executable.filter(line => !Object.entries(c.statementMap).some(([id, loc]) => loc.start.line <= line && loc.end.line >= line && c.s[id] > 0));
  assert.deepEqual(missing, [], `${file}: uncovered changed lines`);
  changedLineCoverage[file] = { executed: executable.length - missing.length, total: executable.length, missing };
  assert.equal(hash(await readFile(file)), hash(sources[file]));
}
const checks = { sourceHashes: Object.fromEntries(sourceFiles.map(file => [file, hash(sources[file])])),
  mutationKills: kills, propertyKills, propertySurvivors, changedLineCoverage };
await writeFile(`${artifact}/checks.json`, JSON.stringify(checks, null, 2) + "\n");
console.log(JSON.stringify(checks));
