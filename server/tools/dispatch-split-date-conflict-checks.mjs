import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const artifact = "test-artifacts/split-date-conflict";
const source = await fs.readFile("src/server.js", "utf8");
const hash = value => createHash("sha256").update(value).digest("hex");
await fs.mkdir(artifact, { recursive: true });
const run = (name, args, { env = {}, expectFailure = false } = {}) => {
  const result = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 30 * 1024 * 1024 });
  assert.equal(result.error, undefined, `${name} failed to execute`);
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  return fs.writeFile(`${artifact}/${name}.log`, output).then(() => {
    if (expectFailure) { assert.notEqual(result.status, 0, `${name} survived`); }
    else { assert.equal(result.status, 0, `${name}: ${output.slice(-8000)}`); }
    return output;
  });
};

const focused = ["test/dispatch/unit/dispatch-split-date-conflict.test.js", "test/dispatch/integration/dispatch-split-date-conflict.test.js"];
await run("final-focused", ["node_modules/c8/bin/c8.js", "--all=false", "--check-coverage=false", "--include=src/server.js",
  `--report-dir=${artifact}/coverage`, "--temp-directory=/tmp/split-date-c8", "--reporter=json", "--reporter=text", "--reporter=json-summary",
  "node", "--test", "--test-concurrency=1", ...focused]);
await run("final-unit-reordered", ["--test", focused[0]]);
// The HTTP tests persist inside their isolated database; use disjoint process
// runs in the outer gauntlet rather than rerunning their fixed date fixtures here.

const mutations = [
  ["sibling-overblock", 'row.assignmentKind !== "split_parent_alias"', "true"],
  ["missing-parent-protection", 'row.assignmentKind !== "split_parent_alias"', "false"],
  ["grouped-parent-bypass", 'row.assignmentKind !== "split_parent_alias"', 'row.assignmentKind === "direct"'],
  ["exact-split-bypass", "!otherPlan.refs.has(key)", "true"],
  ["case-regression", "wholeOrderRefs.add(row.orderRef.toLowerCase())", "wholeOrderRefs.add(row.orderRef)"]
];
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "split-date-mutations-"));
let kills = 0, propertyKills = 0;
try {
  for (const [name, before, after] of mutations) {
    assert.equal(source.split(before).length, 2, `Mutation marker must be unique: ${name}`);
    const file = path.join(directory, `${name}.js`);
    await fs.writeFile(file, source.replace(before, after));
    const env = { SPLIT_DATE_MUTANT: file };
    await run(`mutant-${name}`, ["--test", focused[0]], { env, expectFailure: true });
    kills += 1;
    await run(`property-mutant-${name}`, ["--test", "--test-name-pattern=properties:", focused[0]], { env, expectFailure: true });
    propertyKills += 1;
  }
} finally { await fs.rm(directory, { recursive: true, force: true }); }
assert.equal(await fs.readFile("src/server.js", "utf8"), source);

const coverage = JSON.parse(await fs.readFile(`${artifact}/coverage/coverage-final.json`, "utf8"));
const entry = Object.values(coverage).find(value => value.path.endsWith("/src/server.js"));
assert.ok(entry, "Actual server execution must be covered");
const changedMarkers = ["wholeOrderRefs: new Set()", 'if (row.assignmentKind !== "split_parent_alias")',
  "byPlan.get(row.planId).wholeOrderRefs.add(row.orderRef.toLowerCase());", "if (!key || (!otherPlan.refs.has(key) && (!parent || !otherPlan.wholeOrderRefs.has(parent)))) continue;"];
const lines = source.split("\n");
const changedLines = changedMarkers.map(marker => {
  const line = lines.findIndex(value => value.includes(marker)) + 1;
  assert.ok(line > 0, marker);
  const hit = Object.entries(entry.statementMap).some(([id, span]) => span.start.line <= line && span.end.line >= line && entry.s[id] > 0);
  assert.ok(hit, `Changed executable line ${line} lacks coverage`);
  return line;
});
const report = { sourceSha256: hash(source), mutationKills: kills, propertyMutationKills: propertyKills,
  changedExecutableLines: changedLines, changedLineCoverage: 1, propertyCases: 150,
  versions: { node: process.version } };
await fs.writeFile(`${artifact}/checks.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
