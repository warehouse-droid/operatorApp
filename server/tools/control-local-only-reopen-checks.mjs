import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import v8ToIstanbul from "v8-to-istanbul";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
assert.equal(new URL(process.env.DATABASE_URL).hostname, "db");
const mode = process.argv[2], out = "test-artifacts";
const runtime = ["src/operator-order-reopen-repository.js", "src/local-sales-order-reopen.js", "public/control-order-reopen.js"];
const baseline = file => `${out}/baseline/${file}`;
const original = new Map(runtime.map(file => [file, readFileSync(file, "utf8")]));
const primary = "test/dispatch/integration/control-local-only-reopen.test.js";
const regressions = [
  "test/dispatch/integration/control-order-reopen.test.js",
  "test/dispatch/integration/control-order-reopen-local.test.js",
  "test/dispatch/integration/control-order-reopen-http.test.js",
  "test/dispatch/integration/billed-order-reopen.test.js",
  "test/dispatch/integration/local-reopen-workflows.test.js",
  "test/dispatch/frontend/local-reopen-actions.test.js",
  "test/dispatch/frontend/billed-order-po-link.test.js",
  "test/dispatch/frontend/dispatch-fulfilled-so-ui.test.js",
  "test/dispatch/unit/dispatch-fulfilled-so-policy.test.js",
  "test/dispatch/integration/dispatch-fulfilled-so-planning.test.js",
  "test/dispatch/integration/scm-dependency-preview-blockers.red.test.js",
  "test/mbt/unit/customer-pickup-yard-scope.test.js",
  "test/mbt/integration/customer-pickup-yard-scope.test.js"
];
for (const name of ["local-reopen-20261015", "billed-order-reopen-20261015"]) { mkdirSync(`${out}/${name}`, { recursive: true }); }
function run(label, args, env = {}) {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } });
  const output = result.stdout + result.stderr;
  writeFileSync(`${out}/${label}.log`, output);
  const counts = Object.fromEntries(["tests", "pass", "fail", "skipped"].map(key => [key,
    Number(output.match(new RegExp(`^# ${key} (\\d+)$`, "m"))?.[1] || 0)]));
  const failures = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort();
  console.log(JSON.stringify({ label, exit: result.status, ...counts, failures }));
  if (result.status && !failures.length && !label.endsWith("-types")) { console.log(output.slice(-3000)); }
  return { exit: result.status, ...counts, failures, output };
}
const tests = files => ["--test", "--test-concurrency=1", ...files];
const knownPattern = "real HTTP: billed order reopens|legacy loaded quantities with no load audit|a loaded source CO identifies|stale Open header with loaded lines";
let before;
try {
  if (mode !== "red") {
    for (const file of runtime) { writeFileSync(file, readFileSync(baseline(file))); }
    before = run("baseline-existing", ["--test", "--test-concurrency=1", "--test-name-pattern=" + knownPattern,
      ...regressions.slice(0, 2), regressions[3]]);
    assert.equal(before.fail, 4, "Record the unchanged live PO-link failures explicitly");
  }
} finally { for (const [file, source] of original) { writeFileSync(file, source); } }
const args = tests([primary, ...(mode === "red" ? [] : regressions)]);
const result = run(mode, mode === "final" ? ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false",
  ...runtime.map(file => "--include=" + file), `--temp-directory=${out}/c8`, `--report-dir=${out}/coverage`,
  "--reporter=json", process.execPath, ...args] : args,
{ REOPEN_BROWSER_COVERAGE_PATH: "/app/test-artifacts/reopen-browser.json" });
if (mode === "red") {
  assert.ok(result.failures.some(name => name.includes("old IF does not block")));
  assert.notEqual(result.exit, 0);
} else {
  assert.equal(result.exit, 1, "Only recorded baseline failures are allowed");
  assert.deepEqual(result.failures, before.failures, "No new failures are permitted");
}
if (mode !== "final") { process.exit(0); }

writeFileSync(`${out}/eslint.config.mjs`, `export default [{files:['**/*.js'],languageOptions:{ecmaVersion:'latest',sourceType:'module',globals:{window:'readonly',FormData:'readonly'}},rules:{'no-undef':'error','no-unreachable':'error','no-dupe-args':'error','no-constant-condition':'error'}}];`);
function staticChecks(label) {
  const types = run(`${label}-types`, ["node_modules/typescript/bin/tsc", "--noEmit", "--allowJs", "--checkJs",
    "--skipLibCheck", "--target", "es2022", "--module", "nodenext", "--lib", "ES2022,DOM", ...runtime]);
  const lint = run(`${label}-lint`, ["node_modules/eslint/bin/eslint.js", "--config", `${out}/eslint.config.mjs`, ...runtime]);
  return { types: types.output.split("\n").filter(line => /error TS\d+/u.test(line))
    .map(line => line.replace(/\(\d+,\d+\)/u, "")).sort(), lint: lint.exit };
}
let baseStatic;
try {
  for (const file of runtime) { writeFileSync(file, readFileSync(baseline(file))); }
  baseStatic = staticChecks("baseline");
} finally { for (const [file, source] of original) { writeFileSync(file, source); } }
const currentStatic = staticChecks("candidate");
const newTypes = currentStatic.types.filter(line => !baseStatic.types.includes(line));
assert.deepEqual(newTypes, []);
assert.equal(currentStatic.lint, 0);
for (const file of runtime) { assert.equal(run("syntax-" + file.replaceAll("/", "_"), ["--check", file]).exit, 0); }

const coverage = JSON.parse(readFileSync(`${out}/coverage/coverage-final.json`, "utf8"));
const browser = JSON.parse(readFileSync(`${out}/reopen-browser.json`, "utf8"));
const entry = browser.find(row => row.url.includes("/control-order-reopen.js"));
assert.ok(entry);
const converter = v8ToIstanbul("/app/public/control-order-reopen.js", 0, { source: entry.source });
await converter.load(); converter.applyCoverage(entry.functions);
Object.assign(coverage, converter.toIstanbul());
let changed = 0, covered = 0;
const missing = [];
for (const file of runtime) {
  const diff = spawnSync("diff", ["-U0", baseline(file), file], { encoding: "utf8" });
  assert.ok([0, 1].includes(diff.status));
  const map = coverage["/app/" + file];
  assert.ok(map, file);
  let line = 0;
  for (const text of diff.stdout.split("\n")) {
    const hunk = text.match(/^@@ .* \+(\d+)(?:,\d+)? @@/u);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("-")) { continue; }
    if (text.startsWith("+")) {
      const statements = Object.entries(map.statementMap).filter(([, range]) => range.start.line <= line && range.end.line >= line);
      if (statements.length && !/^\+\s*(\/\/|$|[{});]+$)/u.test(text)) {
        changed++;
        if (statements.some(([id]) => map.s[id] > 0)) { covered++; } else { missing.push(`${file}:${line}`); }
      }
    }
    if (/^[ +]/u.test(text)) { line++; }
  }
}
console.log(JSON.stringify({ changed, covered, missing }));
assert.deepEqual(missing, []);

const repository = runtime[0], authority = runtime[1], ui = runtime[2];
const mutations = [
  { name: "retain-old-fulfilled-quantities", file: repository,
    change: source => source.replace('"fulfilled_pallet_qty=0", "fulfilled_layer_qty=0", "fulfilled_piece_qty=0", "fulfilled_section_qty=0"', '"fulfilled_pallet_qty=fulfilled_pallet_qty"') },
  { name: "lose-history-snapshot", file: repository, change: source => source.replace("header, lines, fulfillments }", "header, lines, fulfillments: [] }") },
  { name: "ignore-new-fulfillment", file: authority,
    change: source => source.replace(/       AND NOT EXISTS \(SELECT 1 FROM delivery_fulfillment_records fulfillment[\s\S]*?\n  \)/u, "\n  )") },
  { name: "restore-remote-directory-lookup", file: repository,
    change: source => 'import { ensureOutboundLocationDirectory } from "./outbound-location-runtime.js";\n' + source.replace("const term = text(search);", "await ensureOutboundLocationDirectory(); const term = text(search);") },
  { name: "hide-confirmation", file: ui, change: source => source.replace("${preview.allowed ?", "${!preview.allowed ?") },
  { name: "ignore-active-posting", file: repository, change: source => source.replace("AND claim.active`", "AND false`"),
    args: ["--test", "--test-name-pattern=pending posting claim", regressions[1]] }
];
const kills = [];
for (const mutation of mutations) {
  try {
    const source = original.get(mutation.file), modified = mutation.change(source);
    assert.notEqual(modified, source, mutation.name);
    writeFileSync(mutation.file, modified);
    const trial = run("mutation-" + mutation.name, mutation.args || tests([primary]));
    assert.equal(trial.exit, 1, "Mutant must fail assertions: " + mutation.name);
    assert.ok(trial.failures.length); kills.push(mutation.name);
    if (mutation.name === "retain-old-fulfilled-quantities") {
      const property = run("property-mutation", ["--test", "--test-name-pattern=property:", primary]);
      assert.equal(property.exit, 1); assert.equal(property.fail, 1);
    }
  } finally { writeFileSync(mutation.file, original.get(mutation.file)); }
}
const health = run("restored-suite-health", tests([primary]));
assert.equal(health.exit, 0);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const hashes = Object.fromEntries([...runtime, "public/control.html"].map(file => [file, hash(file)]));
const summary = { tests: result.tests, pass: result.pass, baselineFailures: result.failures, newFailures: [],
  changedLines: { changed, covered, missing }, manualMutantsKilled: kills, propertyMutantKilled: true,
  restoredPrimary: { tests: health.tests, pass: health.pass },
  types: { baseline: baseStatic.types.length, candidate: currentStatic.types.length, newTypes }, lint: currentStatic.lint,
  sourceHashes: hashes, baselineHashes: Object.fromEntries(Object.keys(hashes).map(file => [file, hash(baseline(file))])),
  tools: Object.fromEntries(["playwright", "c8", "fast-check", "typescript", "eslint"].map(name => [name,
    JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version])), node: process.version };
writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
