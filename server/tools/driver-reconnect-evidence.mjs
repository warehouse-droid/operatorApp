import fs from "node:fs";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const root = "test-artifacts";
const read = name => JSON.parse(fs.readFileSync(`${root}/${name}`));
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const runtimeHashes = read("final/runtime-hashes.json");
for (const [file, hash] of Object.entries(runtimeHashes)) assert.equal(sha(fs.readFileSync(file)), hash, `Changed after testing: ${file}`);
const layers = read("final/layers.json");
assert.ok(layers.every(layer => layer.passed));
const coverage = read("final/changed-line-coverage.json");
assert.ok(coverage.length && coverage.every(row => row.covered), "Uncovered changed lines");
const mutations = read("final/mutations.json");
assert.ok(mutations.restored && mutations.results.length === 4 && mutations.results.every(row => row.properties));
const dispatch = read("final/dispatch-regressions.json");
assert.equal(dispatch.newFailures.length, 0);
const browserPhase = process.env.RECOVERY_COVERAGE_PHASE || fs.readFileSync(`${root}/final/browser-phase.txt`, "utf8").trim();
const browser = read(`${browserPhase}/results/browser-report.json`);
assert.equal(browser.stats.expected, 10);
for (const name of ["unexpected", "flaky", "skipped"]) assert.equal(browser.stats[name], 0);
const integration = fs.readFileSync(`${root}/${browserPhase}/gps-radius.log`, "utf8");
assert.match(integration, /^# tests 24$/mu);
assert.match(integration, /^# pass 24$/mu);
assert.match(integration, /^# fail 0$/mu);
const timing = [];
function walk(value) {
  if (Array.isArray(value)) {value.forEach(walk); return;}
  if (!value || typeof value !== "object") return;
  if (value.name === "completion-timing") timing.push(JSON.parse(Buffer.from(value.body, "base64").toString()));
  Object.values(value).forEach(walk);
}
walk(browser);
assert.equal(timing.length, 2);
assert.ok(timing.every(value => value.elapsedMs < 5000 && value.nextStatus === "in_progress"));
const objects = read("r2/objects.json");
const replay = read("r2/replay.json");
assert.deepEqual(replay.map(value => value.engine).sort(), ["chromium", "webkit"]);
for (const result of replay) {
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.failures.map(value => value.stage), ["uploading", "confirming"]);
  assert.ok(Math.max(result.width, result.height) <= 2048);
  const object = objects.find(value => `r2://${value.key}` === result.reference);
  assert.ok(object?.readBackVerified && object.nativeTransfer);
}
assert.ok(objects.every(value => value.manualDeletionRequested));
assert.ok(objects.every(value => value.readBackVerified || value.supersededHarnessRun));
const expectedProduction = ["mbbs-operator-app-app-1", "mbbs-operator-app-db-1", "mbbs-operator-app-ollama-1", "mbbs-operator-app-webhook-worker-1"].sort();
const otherActiveContainers = new Set();
for (const name of ["docker-ps.txt", "docker-ps-a.txt"]) {
  const containers = fs.readFileSync(`${root}/r2/${name}`, "utf8").trim().split("\n").map(row => row.split(" ")[0]);
  assert.ok(expectedProduction.every(value => containers.includes(value)));
  assert.ok(containers.every(value => !/^mbbs-(?:driver-reconnect|reconnect-r2)-/u.test(value)), "A task test container remains");
  containers.filter(value => !expectedProduction.includes(value)).forEach(value => otherActiveContainers.add(value));
}
const spec = JSON.parse(fs.readFileSync("test/driver-reconnect-spec.json"));
const evidence = {
  validated: true, deployed: false,
  reportedAtToronto: new Intl.DateTimeFormat("en-CA", {timeZone: "America/Toronto", dateStyle: "full", timeStyle: "long"}).format(new Date()),
  "spec approval": spec["spec approval"], sourceTreeHash: sha(JSON.stringify(runtimeHashes)), runtimeHashes,
  entrypoint: "bash server/tools/driver-reconnect-verify.sh", toolVersions: read("final/tool-versions.json"),
  focused: layers.find(row => row.name === "focused").counts,
  driverRegressions: layers.find(row => row.name === "driver-regressions"), dispatchRegressions: dispatch,
  integration: {tests: 24, pass: 24, failures: 0}, browser: browser.stats, completionTimingMs: timing,
  changedLineCoverage: {covered: coverage.length, total: coverage.length, details: "final/changed-line-coverage.json",
    method: "Changed JavaScript line positions in V8 ranges from real helper execution, PostgreSQL HTTP integration and Chromium; cache/HTML/CSS behavior is checked by the asset and mobile UI tests. Migration runs against the disposable database."},
  mutations, layers,
  replay: {scenarios: ["connection fails before upload", "R2 stores photo but PWA confirmation is suppressed", "job commits but completion response is lost", "recovery history response is lost", "two simultaneous completion requests"],
    realR2: replay, folder: "driver-reconnect-test/", objectsRetained: objects.length,
    verifiedNonemptyObjects: objects.filter(value => value.readBackVerified).length,
    failedHarnessObjects: objects.filter(value => value.supersededHarnessRun).length,
    cleanup: "Retained for user manual deletion. Automatic approval review rejected deletion after that preference was given. Exact keys and verification results are in r2/objects.json."},
  findings: [
    "Historical audit records show saved completions and later response failures, but cannot identify the exact transport interruption. completed_at uses PostgreSQL transaction time, not a commit timestamp.",
    "The original server awaited billing cleanup inside and after operational completion. A controlled six-second maintenance delay produced a 6492 ms completion response. That confirms a blocking dependency, not the sole cause of every historical incident.",
    "Billing cleanup and billed-order availability filtering have been removed from Driver completion and Dispatch planning. Closed/cancelled restrictions remain.",
    "Server step and request correlation distinguishes received, validated, location verified, evidence committed, next job started, response ready, response finished and connection closed. Response finish is not proof of client acknowledgement.",
    "The existing production photo archive module is off, idle, has no previous run timestamps and zero tracked objects. Its deletion transport uses the same DELETE /object endpoint that returned 404 for the synthetic test object."
  ],
  behaviorMapping: [
    {behaviors: spec.behaviors.slice(0, 6), tests: ["unit/driver-reconnect.test.js", "property/driver-reconnect.test.js", "driver-reconnect/reconnect.spec.js"], status: "pass; four-second standard-save deadline supersedes the earlier fifteen-second value"},
    {behaviors: [spec.behaviors[6]], tests: ["unit/driver-completion-trace.test.js", "integration/driver-upload-failure-http.test.js", "driver-reconnect/reconnect.spec.js"], status: "pass"},
    {behaviors: [spec.behaviors[7]], tests: ["tools/driver-reconnect-r2.mjs"], status: "upload/read-back pass; deletion superseded by user-authorized manual deletion"},
    {behaviors: [spec.behaviors[8]], tests: ["unit/driver-pwa-recovery-assets.test.js", "unit/driver-gps-radius.test.js", "driver-reconnect/reconnect.spec.js"], status: "pass"},
    {behaviors: ["Billing does not remove saved or available deliveries; closed-order removal preserves its history"], tests: ["integration/driver-billing-independent.test.js"], status: "pass"}
  ],
  limitations: [
    "Historical root cause remains unproven; injected response loss validates recovery, not an attribution to mobile signal, TCP/TLS handshake, proxy or browser.",
    "Five seconds is verified for completion response plus automatic next-job start after photo upload in the isolated fixture. It is not a guarantee during an outage or for every production route/external service dependency.",
    "PWA recovery cannot run while its operating system suspends or terminates it. It resumes on return; DVIR/BIN uncertain external writes use read-only confirmation.",
    "Tests run Chromium and WebKit browser engines, not physical phones. The native WebKit R2 replay required the host's public trusted CA bundle; TLS verification was not disabled.",
    "The first WebKit route.fetch test interception omitted file bytes. Two empty test objects are retained in the manifest as failed-harness evidence; final native-XHR objects pass exact hash read-back.",
    "Seven Driver and twenty-two Dispatch unit failures reproduce unchanged on the captured baseline. No new failures in those suites. Whole-repository tests were not run.",
    "A supplemental attempt to reuse the old billing-maintenance fixtures with closed orders hit existing closed-order save safeguards and unrelated Dispatch UI fixture errors. That fixture conversion was reverted; its failed exploratory output remains in browser-maintenance/maintenance.log. Legacy tests that explicitly demand billing cleanup are superseded by the user policy, not claimed to pass. Final policy validation is the eight real-database billing-independence, closed-order, edit-lease and group-review tests.",
    "A lost R2 acknowledgement can leave an additional storage object when retrying because the existing Worker issues a new key. The completion is protected from duplication; exactly-once object creation is not claimed.",
    "Changed-line execution is measured; full branch coverage is not claimed. Types cover the existing diagnostic contracts; monolithic JavaScript is covered by syntax, focused lint and runtime checks.",
    "No dependencies added. Dependency/license audits are not applicable to this change. No deployment or production migration was performed."
  ],
  cleanup: {taskTestContainersRemoved: true, productionContainers: expectedProduction, otherActiveContainers: [...otherActiveContainers], logs: `${browserPhase}/teardown.log`}
};
fs.writeFileSync(`${root}/evidence.json`, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({validated: true, deployed: false, focused: evidence.focused, browser: evidence.browser,
  changedLinesCovered: coverage.length, propertyMutantsKilled: 4, r2Folder: evidence.replay.folder, r2ObjectsRetained: objects.length}));
