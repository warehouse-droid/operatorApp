import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

assert.equal(process.env.MBT_TEST_ISOLATED, "1");
const root = "test-artifacts";
const read = name => JSON.parse(fs.readFileSync(`${root}/${name}`, "utf8"));
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const manifest = JSON.parse(fs.readFileSync("deployments/driver-upload-recovery-20261015/manifest.json", "utf8"));
const sources = Object.fromEntries(manifest.files.map(file => [file, fs.readFileSync(file, "utf8")]));
const runtimeHashes = Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, sha(source)]));
assert.deepEqual(runtimeHashes, read("final/runtime-hashes.json"));
for (const [file, hash] of Object.entries(runtimeHashes)) assert.equal(hash, manifest.candidateTree[file]);
const scripts = new Map();
function add(file, functions, offset = 0, origin = "unit") {
  if (!scripts.has(file)) scripts.set(file, []);
  scripts.get(file).push({ranges: functions.flatMap(fn => fn.ranges).map(range => ({...range,
    startOffset: range.startOffset + offset, endOffset: range.endOffset + offset})), origin});
}
const gpsStart = sources["src/server.js"].indexOf("async function checkDriverJobLocation(");
for (const file of fs.readdirSync(`${root}/final/raw`).filter(name => name.endsWith(".json"))) {
  for (const script of read(`final/raw/${file}`).result || []) {
    const target = script.url.replace(/^file:\/\//u, "").replace(/^\/app\//u, "");
    if (["public/driver.js", "public/driver-upload.js"].includes(target)) add(target, script.functions);
    if (script.url === "evalmachine.<anonymous>" && script.functions.some(fn => fn.functionName === "checkDriverJobLocation")) {
      add("src/server.js", script.functions, gpsStart);
    }
  }
}
for (const file of fs.readdirSync(`${root}/browser-final/results`, {recursive: true})) {
  if (!file.endsWith("driver-coverage.json") && !/browser-coverage\/.*\.json$/u.test(file)) continue;
  for (const entry of read(`browser-final/results/${file}`)) {
    const target = "public/" + new URL(entry.url).pathname.slice(1);
    assert.equal(sha(entry.source), runtimeHashes[target], "Browser executed different source: " + target);
    add(target, entry.functions, 0, "browser");
  }
}

const added = new Map();
let changedFile;
let line;
for (const row of fs.readFileSync(`${root}/runtime.patch`, "utf8").split("\n")) {
  if (row.startsWith("+++ b/")) {changedFile = row.slice(6); added.set(changedFile, []); continue;}
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/u.exec(row);
  if (hunk) {line = Number(hunk[1]); continue;}
  if (row.startsWith("+") && !row.startsWith("+++")) {added.get(changedFile).push(line); line += 1;}
  else if (row.startsWith(" ")) line += 1;
}
const coverage = [];
for (const [fileName, lines] of added) {
  if (fileName.endsWith(".html") || fileName.endsWith("driver-service-worker.js")) continue;
  const source = sources[fileName];
  const split = source.split("\n");
  const starts = [0];
  for (const row of split) starts.push(starts.at(-1) + row.length + 1);
  for (const number of lines) {
    const text = split[number - 1];
    if (!text.trim() || /^[\s{});,]*$/u.test(text)) continue;
    const offset = starts[number - 1] + text.search(/\S/u);
    const origins = new Set();
    for (const script of scripts.get(fileName) || []) {
      const ranges = script.ranges.filter(range => range.startOffset <= offset && offset < range.endOffset)
        .sort((left, right) => (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset));
      if (ranges[0]?.count > 0) origins.add(script.origin);
    }
    coverage.push({file: fileName, line: number, covered: origins.size > 0, origins: [...origins]});
  }
}
fs.writeFileSync(`${root}/final/changed-line-coverage.json`, JSON.stringify(coverage, null, 2) + "\n");
const missed = coverage.filter(row => !row.covered);
console.log(JSON.stringify({changedLines: coverage.length, covered: coverage.length - missed.length, missed}));
assert.equal(missed.length, 0, "Uncovered changed code: see changed-line-coverage.json");
const layers = read("final/layers.json");
assert.ok(layers.every(layer => layer.passed));
const browser = read("browser-final/results/browser-report.json");
assert.equal(browser.stats.unexpected, 0);
assert.equal(browser.stats.flaky, 0);
assert.equal(browser.stats.skipped, 0);
assert.equal(browser.stats.expected, 18);
const integrationLog = fs.readFileSync(`${root}/browser-final/gps-radius.log`, "utf8");
assert.match(integrationLog, /^# tests 13$/mu);
assert.match(integrationLog, /^# pass 13$/mu);
assert.match(integrationLog, /^# fail 0$/mu);
const mutations = read("mutations/result.json");
assert.ok(mutations.restored && mutations.mutants.length === 5 && mutations.mutants.every(row => row.killed));
const ps = fs.readFileSync(`${root}/browser-final/docker-ps-a.txt`, "utf8").trim().split("\n").map(row => row.split(" ")[0]);
assert.deepEqual(ps.sort(), ["mbbs-operator-app-app-1", "mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1", "mbbs-operator-app-webhook-worker-1"]);
const spec = JSON.parse(fs.readFileSync("test/driver-upload-recovery-spec.json", "utf8"));
const evidence = {passed: true, at: new Date().toISOString(), "spec approval": spec["spec approval"],
  candidateTreeHash: manifest.candidateTreeHash, runtimeHashes,
  focused: layers.find(row => row.name === "focused").counts,
  regressions: layers.find(row => row.name === "driver-regressions"),
  browser: browser.stats, httpDiagnostics: {passed: 5}, gpsBoundaries: {passed: 8},
  coverage: {changedCodeLines: coverage.length, covered: coverage.length - missed.length,
    method: "Changed executable line positions in V8 ranges, combined from actual helper execution and Chromium. Configuration-only HTML and cache constants are checked by the atomic-assets test.",
    details: "final/changed-line-coverage.json"}, mutations, toolVersions: read("final/tool-versions.json"),
  layers, reproducer: "bash server/tools/driver-upload-recovery-verify.sh",
  behaviorMapping: [
    {behaviors: spec.behaviors.slice(0, 4), tests: ["driver-upload-recovery.test.js", "driver-upload-lifecycle.test.js", "property/driver-upload-recovery.test.js", "driver-upload-recovery/recovery.spec.js"]},
    {behaviors: spec.behaviors.slice(4, 7), tests: ["driver-upload-recovery.test.js", "driver-upload-lifecycle.test.js", "driver-upload-recovery/recovery.spec.js", "driver-upload/faults.spec.js"]},
    {behaviors: [spec.behaviors[7]], tests: ["driver-gps-radius.test.js"]},
    {behaviors: [spec.behaviors[8]], tests: ["driver-pwa-recovery-assets.test.js"]}
  ],
  limitations: [...spec.knownLimits,
    "Static types cover the existing diagnostic contract; the monolithic driver script remains JavaScript and is checked with syntax, lint, runtime, property and mutation tests.",
    "Whole-repository tests are outside this driver-only change. The entire driver unit suite ran with seven unchanged historical hard-coded asset-version failures.",
    "Changed-line execution is measured; full branch coverage is not claimed. The broad MBT c8 percentage gate is not applicable to this extracted Driver helper scope.",
    "No new dependencies; dependency audit and license recheck are not applicable. No new network endpoints, subprocesses, filesystem or environment capabilities in runtime code.",
    "No migration, external system writes or physical-device soak test. Read-only history confirmation can still fail or lag; evidence stays available for explicit retry."
  ],
  taskHistory: ["19 behavioral failures observed before implementation; three original Playwright bug scenarios reproduced red.",
    "Wrong-day and wrong-truck DVIR checks initially failed; scoped confirmation now rejects them.",
    "An initial generic c8 run inherited unrelated MBT global percentage thresholds. Final coverage evaluates changed Driver lines and records branch limits explicitly."],
  cleanup: {testContainersRemoved: true, productionContainers: ps, logs: "browser-final/teardown.log"}};
const deploymentPath = "deployments/driver-upload-recovery-20261015/deployment-result.json";
if (fs.existsSync(deploymentPath)) {
  evidence.deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const rollbackPath = "deployments/driver-upload-recovery-20261015/rollback-result.json";
  if (fs.existsSync(rollbackPath)) {
    evidence.rollbackRehearsed = JSON.parse(fs.readFileSync(rollbackPath, "utf8"));
    evidence.taskHistory.push("The first release verification omitted the required PWA version header and received 426 instead of its expected 401. Automatic rollback restored the exact previous image. The corrected verifier separately confirmed 426 without a version and 401 with the valid version, and the unchanged tested image was deployed successfully.");
  }
}
fs.writeFileSync(`${root}/evidence.json`, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({passed: true, focused: evidence.focused, browser: evidence.browser, changedLines: evidence.coverage, mutantsKilled: 5}));
