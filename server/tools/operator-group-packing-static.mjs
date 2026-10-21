import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import v8ToIstanbul from "v8-to-istanbul";
import coverageLibrary from "istanbul-lib-coverage";

const file = "src/delivery-repository.js";
const before = readFileSync(`/release/baseline/${file}`, "utf8");
const after = readFileSync(file, "utf8");
const manifest = JSON.parse(readFileSync("/release/manifest.json", "utf8"));
const addedDiagnostics = (old, current) => {
  const remaining = [...old], added = [];
  for (const item of current) {
    const index = remaining.indexOf(item);
    if (index >= 0) remaining.splice(index, 1);
    else added.push(item);
  }
  return added;
};
const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
assert.equal(syntax.status, 0, syntax.stderr);
const lint = new ESLint({ overrideConfigFile: "tools/consolidation-load-eslint.config.mjs" });
const diagnostics = rows => rows.flatMap(row => row.messages.map(({ ruleId, message, severity }) =>
  JSON.stringify({ ruleId, message, severity }))).sort();
const oldLint = diagnostics(await lint.lintText(before, { filePath: file }));
const newLint = diagnostics(await lint.lintText(after, { filePath: file }));

const root = mkdtempSync(path.join(tmpdir(), "group-packing-types-"));
mkdirSync(`${root}/src`);
symlinkSync(path.resolve("node_modules"), `${root}/node_modules`);
writeFileSync(`${root}/package.json`, '{"type":"module"}');
function types(source, label) {
  writeFileSync(`${root}/${file}`, source);
  const run = spawnSync(path.resolve("node_modules/.bin/tsc"), ["--ignoreConfig", "--allowJs", "--checkJs",
    "--noEmit", "--noResolve", "--skipLibCheck", "--target", "ES2022", "--module", "NodeNext", file],
  { cwd: root, encoding: "utf8", maxBuffer: 20e6 });
  assert(run.status !== null, run.error?.message);
  const output = run.stdout + run.stderr;
  writeFileSync(`/release/types-${label}.log`, output);
  return output.split("\n").filter(Boolean).map(line => line.replace(/\(\d+,\d+\)/g, "(LINE,COLUMN)")).sort();
}
const oldTypes = types(before, "baseline"), newTypes = types(after, "candidate");
const coverage = coverageLibrary.createCoverageMap({});
let samples = 0;
for (const name of readdirSync("/release/coverage")) {
  if (!name.endsWith(".json")) continue;
  const raw = JSON.parse(readFileSync(`/release/coverage/${name}`, "utf8"));
  for (const entry of raw.result || []) {
    if (entry.url !== `file:///app/${file}`) continue;
    const converter = v8ToIstanbul(`/app/${file}`, 0, { source: after });
    await converter.load();
    converter.applyCoverage(entry.functions);
    coverage.merge(converter.toIstanbul());
    samples += 1;
  }
}
assert(samples > 0, "Candidate coverage is required");
const lines = coverage.fileCoverageFor(`/app/${file}`).getLineCoverage();
const changed = manifest.changedLines.filter(line => Object.hasOwn(lines, line));
const uncovered = changed.filter(line => lines[line] === 0);
const result = {
  file, syntaxPassed: true,
  lint: { baseline: oldLint.length, candidate: newLint.length, added: addedDiagnostics(oldLint, newLint) },
  types: { noResolve: true, baseline: oldTypes.length, candidate: newTypes.length, added: addedDiagnostics(oldTypes, newTypes) },
  changedLineCoverage: { samples, covered: changed.length - uncovered.length, total: changed.length, uncovered },
};
writeFileSync("/release/static.json", JSON.stringify(result, null, 2));
writeFileSync("/release/coverage-merged.json", JSON.stringify(coverage.toJSON()));
console.log(JSON.stringify(result, null, 2));
assert.equal(result.lint.added.length, 0, "New lint diagnostics");
assert.equal(result.types.added.length, 0, "New scoped type diagnostics");
