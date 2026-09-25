import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import { mutants } from "../test/support/local-load-performance-mutations.mjs";
import { scanPaths } from "../test/support/scan-diff-secrets.mjs";

const artifact = "test-artifacts/local-load-performance";
const focused = "test/mbt/integration/local-load-performance.test.js";
const sources = ["src/delivery-repository.js"];
const adjacent = ["test/mbt/integration/group-load-identity.test.js", "test/dispatch/integration/co-source-packing-handoff.test.js",
  "test/mbt/integration/group-underpack.test.js", "test/mbt/integration/consolidation-load.test.js"];
const hashes = () => Object.fromEntries(sources.map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
const failures = output => [...output.matchAll(/^not ok \d+ - (.+)$/gmu)].map(match => match[1]).sort();
function run(args, name, env = {}) {
  const result = spawnSync(process.execPath, args, { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
  const output = (result.stdout || "") + (result.stderr || "");
  fs.writeFileSync(`${artifact}/${name}.log`, output);
  assert.ok(!result.error, `${name}: ${result.error}`);
  return { status: result.status, output };
}
function save(name, value) {
  fs.writeFileSync(`${artifact}/${name}.json`, JSON.stringify(value, null, 2) + "\n");
  console.log(JSON.stringify(name === "baseline-static"
    ? { name, lintCount: value.lint.length, typeDiagnostics: value.diagnostics.length }
    : { name, ...value }));
}

async function staticChecks(mode) {
  const files = [...sources, focused, "test/support/local-load-performance-mutations.mjs", "tools/local-load-performance-checks.mjs"];
  for (const file of files) {
    assert.equal(run(["--check", file], `${mode}-syntax-${file.split("/").pop()}`).status, 0);
  }
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{
    files: ["**/*.{js,mjs}"], languageOptions: { ecmaVersion: "latest", sourceType: "module",
      globals: { process: "readonly", console: "readonly", Buffer: "readonly", structuredClone: "readonly" } },
    rules: { "no-undef": "error", "no-unused-vars": "error", "no-unreachable": "error", "eqeqeq": "error" }
  }] });
  const lint = (await eslint.lintFiles(files)).flatMap(row => row.messages.map(message => ({
    file: row.filePath.replace(/^.*\/app\//u, ""), rule: message.ruleId, message: message.message
  })));
  const types = run(["node_modules/typescript/bin/tsc", "--allowJs", "--checkJs", "--noEmit", "--skipLibCheck", "--module", "nodenext", "--target", "ES2022", ...sources], `${mode}-types`);
  const diagnostics = types.output.split("\n").filter(line => /error TS\d+/u.test(line)).map(line => line.replace(/\(\d+,\d+\)/u, "(line,column)")).sort();
  assert.ok(diagnostics.length || types.status === 0, "Type checker did not produce results");
  assert.deepEqual(await scanPaths(files), []);
  if (mode === "baseline") {
    save("baseline-static", { lint, diagnostics });
  } else {
    const before = JSON.parse(fs.readFileSync(`${artifact}/baseline-static.json`, "utf8"));
    assert.deepEqual(lint, before.lint, "New lint findings");
    const counts = values => values.reduce((result, value) => result.set(value, (result.get(value) || 0) + 1), new Map());
    const prior = counts(before.diagnostics), current = counts(diagnostics);
    const changes = [...new Set([...prior.keys(), ...current.keys()])]
      .filter(value => prior.get(value) !== current.get(value))
      .map(value => ({ diagnostic: value, before: prior.get(value) || 0, after: current.get(value) || 0 }));
    assert.deepEqual(changes, [], "Changed type diagnostics");
    save("static", { lintCount: lint.length, existingTypeDiagnostics: diagnostics.length, newFindings: 0, sourceHashes: hashes() });
  }
}

const mode = process.argv[2];
if (mode === "baseline" || mode === "suite") {
  const summary = [];
  for (const reverse of [false, true]) {
    const files = reverse ? [...adjacent].reverse() : adjacent;
    const selected = mode === "suite" ? [focused, ...files] : files;
    const name = `${mode}-${reverse ? "reversed" : "normal"}`;
    const result = run(["--test", "--test-concurrency=1", ...selected], name);
    const failed = failures(result.output);
    const baselinePath = `${artifact}/baseline-${reverse ? "reversed" : "normal"}.json`;
    if (mode === "baseline") {
      fs.writeFileSync(baselinePath, JSON.stringify(failed));
    } else {
      assert.deepEqual(failed, JSON.parse(fs.readFileSync(baselinePath, "utf8")), "New behavioral failures");
    }
    assert.match(result.output, /^# tests \d+$/mu, "Suite did not finish");
    summary.push({ reverse, failures: failed, counts: result.output.split("\n").filter(line => /^# (tests|pass|fail|skipped) /u.test(line)) });
  }
  save(mode, { summary, sourceHashes: hashes() });
  await staticChecks(mode);
} else if (mode === "coverage") {
  const result = run(["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false", "--reporter=json", "--reporter=json-summary",
    `--temp-directory=${artifact}/c8-tmp`, `--report-dir=${artifact}/coverage`, ...sources.map(file => `--include=${file}`),
    "node", "--test", "--test-concurrency=1", focused, ...adjacent], "coverage");
  assert.equal(result.status, 0, result.output);
  const coverage = JSON.parse(fs.readFileSync(`${artifact}/coverage/coverage-final.json`, "utf8"));
  const changed = {};
  for (const file of sources) {
    const patch = spawnSync("diff", ["-U0", `${artifact}/baseline/${file}`, file], { encoding: "utf8" }).stdout;
    const lines = [];
    for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
      for (let index = 0; index < Number(match[2] ?? 1); index += 1) {lines.push(Number(match[1]) + index);}
    }
    assert.ok(lines.length, `No diff for ${file}`);
    const c = Object.values(coverage).find(entry => entry.path.endsWith(`/${file}`));
    assert.ok(c, `No coverage for ${file}`);
    const missing = lines.filter(line => !Object.entries(c.statementMap).some(([id, loc]) => loc.start.line <= line && loc.end.line >= line && c.s[id] > 0));
    assert.deepEqual(missing, [], `${file}: changed lines not executed`);
    changed[file] = { total: lines.length, executed: lines.length, missing };
  }
  save("coverage", { changed, sourceHashes: hashes() });
} else if (mode === "mutations") {
  const results = [];
  for (const name of Object.keys(mutants)) {
    const result = run(["--experimental-loader", "./test/support/local-load-performance-mutations.mjs", "--test", focused], `mutant-${name}`, { LOCAL_LOAD_PERF_MUTANT: name });
    assert.notEqual(result.status, 0, `${name} survived`);
    assert.match(result.output, /ERR_ASSERTION|Property failed/u);
    assert.doesNotMatch(result.output, /Invalid mutation anchor|SyntaxError|ERR_MODULE_NOT_FOUND/u);
    results.push({ name, killed: true, failures: failures(result.output) });
  }
  save("mutations", { results, sourceHashes: hashes() });
} else {
  throw new Error("Expected baseline, suite, coverage, or mutations");
}
