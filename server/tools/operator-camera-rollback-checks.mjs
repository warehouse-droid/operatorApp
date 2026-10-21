import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import v8ToIstanbul from "v8-to-istanbul";
import coverageLibrary from "istanbul-lib-coverage";

const file = "public/operator.js";
const before = readFileSync(`/release/baseline/${file}`, "utf8");
const after = readFileSync(file, "utf8");
const manifest = JSON.parse(readFileSync("/release/manifest.json", "utf8"));
const difference = (old, current) => {
  const remaining = [...old], added = [];
  for (const item of current) {
    const index = remaining.indexOf(item);
    if (index >= 0) remaining.splice(index, 1); else added.push(item);
  }
  return added;
};
for (const name of [file, "public/service-worker.js"]) {
  const syntax = spawnSync(process.execPath, ["--check", name], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
}
const lint = new ESLint({ overrideConfigFile: "tools/consolidation-load-eslint.config.mjs" });
const messages = rows => rows.flatMap(row => row.messages.map(({ ruleId, message, severity }) => JSON.stringify({ ruleId, message, severity }))).sort();
const oldLint = messages(await lint.lintText(before, { filePath: file }));
const newLint = messages(await lint.lintText(after, { filePath: file }));
const root = mkdtempSync(path.join(tmpdir(), "camera-rollback-types-"));
mkdirSync(`${root}/public`); symlinkSync(path.resolve("node_modules"), `${root}/node_modules`);
writeFileSync(`${root}/package.json`, '{"type":"module"}');
function types(source, label) {
  writeFileSync(`${root}/${file}`, source);
  const run = spawnSync(path.resolve("node_modules/.bin/tsc"), ["--ignoreConfig", "--allowJs", "--checkJs", "--noEmit", "--noResolve", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", file],
    { cwd: root, encoding: "utf8", maxBuffer: 20e6 });
  assert(run.status !== null, run.error?.message);
  const output = run.stdout + run.stderr; writeFileSync(`/release/types-${label}.log`, output);
  return output.split("\n").filter(Boolean).map(line => line.replace(/\(\d+,\d+\)/g, "(LINE,COLUMN)")).sort();
}
const oldTypes = types(before, "baseline"), newTypes = types(after, "candidate");
const coverage = coverageLibrary.createCoverageMap({}); let samples = 0;
for (const name of readdirSync("test-artifacts/operator-camera-rollback")) {
  if (!/^browser-coverage-candidate-.*\.json$/.test(name)) continue;
  for (const entry of JSON.parse(readFileSync(`test-artifacts/operator-camera-rollback/${name}`, "utf8"))) {
    assert.equal(entry.source, after, "Coverage must describe the exact candidate");
    const converter = v8ToIstanbul(`/app/${file}`, 0, { source: after });
    await converter.load(); converter.applyCoverage(entry.rawScriptCoverage?.functions || entry.functions);
    coverage.merge(converter.toIstanbul()); samples++;
  }
}
assert(samples > 0, "Browser coverage is required");
const covered = coverage.fileCoverageFor(`/app/${file}`), lines = covered.getLineCoverage();
const changed = manifest.changedLines[file].filter(line => Object.hasOwn(lines, line));
const missing = changed.filter(line => lines[line] === 0);
const changedBranches = Object.entries(covered.branchMap).filter(([, value]) => manifest.changedLines[file].includes(value.loc.start.line))
  .flatMap(([key, value]) => covered.b[key].map(count => ({ line: value.loc.start.line, count })));
const html = readFileSync("public/operator.html", "utf8"), worker = readFileSync("public/service-worker.js", "utf8");
const script = html.match(/\/operator\.js\?v=([^"\s]+)/)[0];
assert(worker.includes(script), "Installed cache must contain the same Operator asset version");
assert(script.endsWith("20260930-android-camera-rollback-v1"));
const result = { file, syntaxPassed: true,
  lint: { baseline: oldLint.length, candidate: newLint.length, added: difference(oldLint, newLint) },
  types: { noResolve: true, baseline: oldTypes.length, candidate: newTypes.length, added: difference(oldTypes, newTypes) },
  changedLineCoverage: { samples, covered: changed.length - missing.length, total: changed.length, uncovered: missing },
  changedBranchRanges: { covered: changedBranches.filter(row => row.count > 0).length, total: changedBranches.length, uncovered: changedBranches.filter(row => row.count === 0) },
  cacheAssetMatches: true,
  tools: { node: process.version, eslint: ESLint.version, typescript: spawnSync(path.resolve("node_modules/.bin/tsc"), ["--version"], { encoding: "utf8" }).stdout.trim() },
};
writeFileSync("/release/static.json", JSON.stringify(result, null, 2));
writeFileSync("/release/coverage-merged.json", JSON.stringify(coverage.toJSON()));
console.log(JSON.stringify(result, null, 2));
assert.equal(result.lint.added.length, 0, "New lint diagnostics");
assert.equal(result.types.added.length, 0, "New scoped type diagnostics");
assert.equal(missing.length, 0, "Changed lines lack execution coverage");
