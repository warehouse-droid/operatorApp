import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertMbtCiWorkflow } from "../../support/ci-workflow-contract.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDirectory, "../../..");
const repoRoot = path.resolve(process.env.MBBS_REPO_ROOT || path.resolve(serverRoot, ".."));
const CHECKOUT_SHA = "11d5960a326750d5838078e36cf38b85af677262";
const UPLOAD_ARTIFACT_SHA = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const P3_DEDICATED_MUTATION_RUNNERS = Object.freeze([
  "run-customer-charge-mutations.mjs",
  "run-delivery-instruction-mutations.mjs",
  "run-dispatch-active-load-mutations.mjs",
  "run-dispatch-co-lifecycle-mutations.mjs",
  "run-dispatch-driver-completion-mutations.mjs",
  "run-dispatch-load-reorder-mutations.mjs",
  "run-dispatch-order-completion-mutations.mjs",
  "run-dispatch-performance-mutations.mjs",
  "run-dispatch-planner-optimization-mutations.mjs",
  "run-dispatch-runtime-resilience-mutations.mjs",
  "run-dispatch-save-recovery-mutations.mjs",
  "run-dispatch-v2-summary-marker-mutations.mjs",
  "run-driver-offline-stress-mutations.mjs",
  "run-driver-plan-date-execution-mutations.mjs",
  "run-driver-pwa-historical-assist-mutations.mjs",
  "run-driver-pwa-site-reset-mutations.mjs",
  "run-frontdesk-mutations.mjs",
  "run-mbbs-cross-charge-v4-mutations.mjs",
  "run-mbbs-vendor-route-rate-mutations.mjs",
  "run-netsuite-delayed-status-refresh-mutations.mjs",
  "run-netsuite-m2m-mutations.mjs",
  "run-operator-customer-pickup-photo-gate-mutations.mjs",
  "run-p310-adversarial-mutations.mjs",
  "run-p310-reconciliation-mutations.mjs",
  "run-p311-mutations.mjs",
  "run-p35a-mutations.mjs",
  "run-p35a-ui-mutation.mjs",
  "run-p38-mutations.mjs",
  "run-p39-client-mutations.mjs",
  "run-p39-mutations.mjs",
  "run-p39-reservation-mutations.mjs",
  "run-scm-dependency-management-mutations.mjs",
  "run-scm-po-split-ref-reuse-mutations.mjs",
  "run-scm-po-split-ui-mutations.mjs",
  "run-scm-schedule-status-mutations.mjs",
  "run-smart-scm-blanket-merge-mutations.mjs",
  "run-smart-scm-manual-controls-mutations.mjs",
  "run-smart-scm-po-oauth-mutations.mjs",
  "run-smart-scm-vendor-unit-price-mutations.mjs",
  "run-special-stock-request-mutations.mjs",
  "run-stock-request-mutations.mjs",
  "run-test-database-isolation-mutations.mjs",
  "run-transfer-dependency-source-backorder-mutations.mjs"
]);
const P3_BASE_MUTANT_NAMES = Object.freeze([
  "P3 predeploy no longer requires migration 110",
  "P3 predeploy omits the asset-management database gate",
  "P3 production smoke accepts an open asset-management environment gate",
  "P3 production smoke ignores operational state mutation",
  "P3 bounded CSV accepts a direct input beyond the byte limit",
  "P3 customer import accepts duplicate internal IDs",
  "P3 SpreadsheetML accepts executable formulas",
  "P3 SpreadsheetML repairs bare ampersands outside Data nodes",
  "P3 SpreadsheetML rejects the observed benign Company metadata",
  "P3 SpreadsheetML accepts Company metadata outside DocumentProperties",
  "P3 asset registration skips the transactional rollback hook",
  "P3 asset registration no longer maps duplicate identities",
  "P3 asset registration corrupts the sequence-1 ledger event",
  "P3 asset comparison hides an open movement variance",
  "P3 local rates accept an unsafe accumulated subtotal",
  "P3 dump customer charge silently includes actual receipt cost",
  "P3 rate-card configuration accepts non-allowlisted pricing fields",
  "P3 rate-card activation ignores an existing active version",
  "P3 rate-card CSV accepts an extra sixth file",
  "P3 rate-card CSV ignores the aggregate byte ceiling",
  "P3 rate-card CSV apply ignores preview ownership",
  "P3 rate-card CSV apply skips the transactional rollback hook",
  "P3 MBBS PO billing collapses distinct immutable Driver loads",
  "P3 MBBS PO billing charges the first drop twice",
  "P3 MBBS direct TO incorrectly includes a full route charge",
  "P3 MBBS direct TO uses the PO additional-drop price",
  "P3 MBBS PO additional drops use the direct-TO price",
  "P3 MBBS policy accepts a negative unit price",
  "P3 MBBS policy accepts a changed hidden charging rule",
  "P3 MBBS missing policy loses its fail-closed error boundary",
  "P3 MBBS rate-card detail hides an existing version policy",
  "P3 MBBS durable billing evidence drops the selected version policy",
  "P3 MBBS manual final charge no longer has to match calculation plus adjustment",
  "P3 MBBS explicit Sales Order group is charged per child",
  "P3 MBBS explicit Purchase Order group is charged per child",
  "P3 MBBS selected historical candidate falls back to the latest page",
  "P3 MBBS unavailable automatic route rejects manual billing",
  "P3 MBBS conversion ignores unchecked calculation rows",
  "P3 MBBS manual-rate rows are selected without operator consent",
  "P3 MBBS UI labels metres as kilometres without conversion",
  "P3 MBBS candidate list regresses to a 200-order ceiling",
  "P3 MBBS batch accepts a 101st order",
  "P3 MBBS batch starts unbounded distance work",
  "P3 MBBS two-address routes regress to origin-yard-only eligibility",
  "P3 MBBS durable conversion skips immutable candidate snapshots",
  "P3 MBBS durable conversion skips atomic failure hook",
  "P3 MBBS durable conversion excludes explicitly searched Pick-Up",
  "P3 MBBS address override ignores optimistic revision"
]);
const P3_ADVERSARIAL_TESTS = Object.freeze([
  "dispatch-completion-repository-adversarial.test.js",
  "driver-plan-date-execution-adversarial.test.js",
  "driver-pwa-historical-assist-adversarial.test.js",
  "p311-completed-load-snapshot-integrity.test.js",
  "shadow-billing-adversarial.test.js",
  "shadow-billing-snapshot-boundary-adversarial.test.js",
  "stock-request-adversarial.test.js",
  "stock-request-repository-adversarial.test.js"
]);
const P3_BROWSER_SKIP_ALLOWLIST = Object.freeze([]);
const NODE_TEST_GROUPS = Object.freeze([
  "infrastructure",
  "unit",
  "contracts",
  "property",
  "integration",
  "adversarial",
  "concurrency"
]);
const SAFE_P3_WORKFLOW = [
  "name: MBT Phase 3 Gauntlet",
  "",
  "on:",
  "  workflow_dispatch:",
  "  pull_request:",
  "    branches:",
  "      - main",
  "      - dockerVer",
  "  push:",
  "    branches:",
  "      - main",
  "      - dockerVer",
  "",
  "permissions:",
  "  contents: read",
  "",
  "jobs:",
  "  gauntlet:",
  "    runs-on: ubuntu-24.04",
  "    timeout-minutes: 90",
  "    env:",
  "      MBT_GAUNTLET_BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}",
  "    steps:",
  `      - uses: actions/checkout@${CHECKOUT_SHA}`,
  "        with:",
  "          fetch-depth: 0",
  "          persist-credentials: false # secret-scan: allow non-secret GitHub setting",
  "      - run: bash server/tools/mbt-gauntlet.sh P3",
  `      - uses: actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`,
  "        if: ${{ always() }}",
  "        with:",
  "          name: mbt-phase-3-gauntlet",
  "          path: server/test-artifacts/",
  "          if-no-files-found: error",
  "          retention-days: 14",
  ""
].join("\n");

function explicitBashPhaseBranches(source, phase) {
  const escapedPhase = phase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:^|\\n)[ \\t]*${escapedPhase}\\)[ \\t]*([\\s\\S]*?)[ \\t]*;;`,
    "g"
  );
  return [...source.matchAll(pattern)].map((match) => match[1] || "");
}

function frozenArrayBody(source, declarationName) {
  const escapedName = declarationName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `const\\s+${escapedName}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\n\\]\\);`
  ).exec(source)?.[1] || "";
}

function quotedArrayValues(source, declarationName) {
  const escapedName = declarationName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = frozenArrayBody(source, declarationName)
    || new RegExp(`const\\s+${escapedName}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\n\\]\\);`)
      .exec(source)?.[1]
    || "";
  return [...body.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1]);
}

async function containsNodeTest(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && await containsNodeTest(target)) {
      return true;
    }
    if (entry.isFile() && /\.test\.(?:js|mjs)$/u.test(entry.name)) {
      return true;
    }
  }
  return false;
}

async function matchingFiles(directory, pattern) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await matchingFiles(target, pattern));
    } else if (entry.isFile() && pattern.test(entry.name)) {
      files.push(target);
    }
  }
  return files;
}

test("P3.1: Phase 3 has its own least-privilege CI workflow and exact phase contract", () => {
  assert.equal(assertMbtCiWorkflow(SAFE_P3_WORKFLOW, { phase: "P3" }), true);
  assert.match(SAFE_P3_WORKFLOW, /^  workflow_dispatch:\s*$/m);
  assert.equal((SAFE_P3_WORKFLOW.match(/^      - dockerVer$/gm) || []).length, 2);
  assert.match(SAFE_P3_WORKFLOW, /bash server\/tools\/mbt-gauntlet\.sh P3\s*$/m);
  assert.match(SAFE_P3_WORKFLOW, /if: \$\{\{ always\(\) \}\}/);
  assert.match(SAFE_P3_WORKFLOW, new RegExp(`actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`));
  assert.doesNotMatch(SAFE_P3_WORKFLOW, /mbt-gauntlet\.sh P[12]\b/);
  assert.throws(
    () => assertMbtCiWorkflow(SAFE_P3_WORKFLOW, { phase: "P1" }),
    /unsafe MBT Phase 1 CI workflow/i
  );
  assert.throws(
    () => assertMbtCiWorkflow(SAFE_P3_WORKFLOW, { phase: "P2" }),
    /unsafe MBT Phase 2 CI workflow/i
  );
});

test("P3.1: gauntlet phase selection is exhaustive and P3 never enters a P1/P2 fallback", async () => {
  const gauntlet = await readFile(path.join(serverRoot, "tools/mbt-gauntlet.sh"), "utf8");
  const p3Branches = explicitBashPhaseBranches(gauntlet, "P3");

  assert.ok(
    p3Branches.length > 0,
    "P3 must have an explicit case branch; accepting P3 in a combined validation label is insufficient."
  );
  const p3Contract = p3Branches.join("\n");
  assert.match(p3Contract, /mbt_ci_phase=["']P3["']/);
  assert.match(p3Contract, /mbt_ci_workflow=["']mbt-p3\.yml["']/);
  assert.match(p3Contract, /MBT_PREDEPLOY_PHASE=P3/);
  assert.match(p3Contract, /preflight:mbt-p3-deploy/);
  assert.match(p3Contract, /MBT_P3_RUNTIME_SMOKE=1/);
  assert.doesNotMatch(
    p3Contract,
    /mbt-p[12]\.yml|MBT_PREDEPLOY_PHASE=P[12]|preflight:mbt-p[12]-deploy|MBT_P[12]_RUNTIME_SMOKE/i,
    "An explicit P3 branch must not reference P1/P2 phase evidence."
  );

  assert.doesNotMatch(
    gauntlet,
    /if\s+\[\[\s+["']\$mbt_mode["']\s+==\s+["']P2["']\s+\]\];\s*then[\s\S]*?\n\s*else\s*\n[\s\S]*?preflight:mbt-p1-deploy/,
    "A P2-or-else-P1 predeploy branch silently routes P3 through P1."
  );
  assert.match(gauntlet, /MBT_MUTATION_PHASE=["']\$mbt_mode["']/);
});

test("P3.1: predeploy exposes dedicated P3 migration inspection and production closed-gate smoke", async () => {
  const [gauntlet, predeploy, packageSource] = await Promise.all([
    readFile(path.join(serverRoot, "tools/mbt-gauntlet.sh"), "utf8"),
    readFile(path.join(serverRoot, "tools/mbt-predeploy-readiness.mjs"), "utf8"),
    readFile(path.join(serverRoot, "package.json"), "utf8")
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.equal(
    packageJson.scripts?.["preflight:mbt-p3-deploy"],
    "node tools/mbt-predeploy-readiness.mjs"
  );
  for (const exportedContract of [
    "REQUIRED_MBT_P3_MIGRATIONS",
    "evaluateMbtP3DeploymentReadiness",
    "inspectMbtP3DeploymentReadiness",
    "runMbtP3ProductionRuntimeSmoke"
  ]) {
    assert.match(
      predeploy,
      new RegExp(`export\\s+(?:const|function|async\\s+function)\\s+${exportedContract}\\b`),
      `P3 predeploy must export ${exportedContract}.`
    );
  }
  assert.match(
    predeploy,
    /phase\s*===\s*["']P3["'][\s\S]{0,1600}inspectMbtP3DeploymentReadiness/,
    "MBT_PREDEPLOY_PHASE=P3 must select the P3 inspector explicitly."
  );
  assert.match(
    predeploy,
    /MBT_P3_RUNTIME_SMOKE[\s\S]{0,1600}runMbtP3ProductionRuntimeSmoke/,
    "The production-image P3 smoke must have its own explicit selector."
  );
  assert.doesNotMatch(
    predeploy,
    /phase\s*!==\s*["']P1["']\s*&&\s*phase\s*!==\s*["']P2["']\s*\)/,
    "The predeploy phase allowlist must include P3 instead of rejecting it."
  );
  assert.match(gauntlet, /MBT_PREDEPLOY_PHASE=P3/);
  assert.match(gauntlet, /MBT_P3_RUNTIME_SMOKE=1/);
});

test("P3.1: mutation selection contains a distinct nonempty P3 set instead of P1/P2 evidence", async () => {
  const [mutations, packageSource] = await Promise.all([
    readFile(path.join(serverRoot, "test/support/run-mutations.mjs"), "utf8"),
    readFile(path.join(serverRoot, "package.json"), "utf8")
  ]);
  const packageJson = JSON.parse(packageSource);
  const p3Mutants = frozenArrayBody(mutations, "P3_MUTANTS");
  const p3MutantNames = [...p3Mutants.matchAll(/\n\s*name:\s*"([^"]+)"/g)]
    .map((match) => match[1]);

  assert.notEqual(p3Mutants, "", "P3_MUTANTS must be declared as a persisted frozen array.");
  assert.deepEqual(p3MutantNames, P3_BASE_MUTANT_NAMES);
  assert.equal(new Set(p3MutantNames).size, P3_BASE_MUTANT_NAMES.length);
  assert.match(
    mutations,
    new RegExp(`P3_MUTANTS\\.length\\s*!==\\s*${P3_BASE_MUTANT_NAMES.length}\\b`),
    "The executable frozen-count guard must agree with the reviewed P3 mutant-name manifest."
  );
  assert.match(p3Mutants, /\{\s*name:\s*["'][^"']+["']/);
  assert.match(p3Mutants, /\bfrom:\s*["']/);
  assert.match(p3Mutants, /\bto:\s*["']/);
  assert.match(
    mutations,
    /(?:mutationPhase\s*===\s*["']P3["']|case\s+["']P3["']\s*:)[\s\S]{0,2200}\.\.\.P3_MUTANTS/,
    "The P3 selector must add its distinct mutants explicitly."
  );
  assert.doesNotMatch(
    mutations,
    /mutationPhase\s*!==\s*["']P1["']\s*&&\s*mutationPhase\s*!==\s*["']P2["']\s*\)/,
    "The mutation phase allowlist must include P3 instead of rejecting it."
  );
  assert.match(mutations, /Phase 3 mutation score:/);
  assert.equal(
    packageJson.scripts?.["mutate:mbt:mbbs-billing"],
    "MBT_MUTATION_PHASE=P3 MBT_MUTATION_SCOPE=MBBS_BILLING node test/support/run-mutations.mjs"
  );
  assert.match(mutations, /mutationScope\s*===\s*"MBBS_BILLING"/u);
  assert.match(mutations, /scope\s*===\s*"mbbs_billing"/u);
  assert.match(mutations, /scopedP3Mutants\.length\s*!==\s*26/u);
});

test("P3.11: every unmutated Node test category is owned by main, coverage, and shuffle", async () => {
  const mbtTestRoot = path.join(serverRoot, "test/mbt");
  const [nodeRunner, shuffledRunner, packageSource, adversarialFiles, topLevelEntries] = await Promise.all([
    readFile(path.join(serverRoot, "test/support/run-node-tests.mjs"), "utf8"),
    readFile(path.join(serverRoot, "test/support/run-shuffled.mjs"), "utf8"),
    readFile(path.join(serverRoot, "package.json"), "utf8"),
    readdir(path.join(mbtTestRoot, "adversarial")),
    readdir(mbtTestRoot, { withFileTypes: true })
  ]);
  const packageJson = JSON.parse(packageSource);
  const eligibleGroups = [];
  for (const entry of topLevelEntries) {
    if (entry.isDirectory()
        && entry.name !== "e2e"
        && entry.name !== "support"
        && await containsNodeTest(path.join(mbtTestRoot, entry.name))) {
      eligibleGroups.push(entry.name);
    }
  }
  const mainGroups = String(packageJson.scripts?.["test:mbt"] || "")
    .replace(/^.*run-node-tests\.mjs\s*/u, "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

  assert.deepEqual(adversarialFiles.filter((name) => /\.test\.(?:js|mjs)$/u.test(name)).sort(), P3_ADVERSARIAL_TESTS);
  assert.deepEqual([...quotedArrayValues(nodeRunner, "ALLOWED_GROUPS")].sort(), [...NODE_TEST_GROUPS].sort());
  assert.deepEqual([...quotedArrayValues(shuffledRunner, "GROUPS")].sort(), [...NODE_TEST_GROUPS].sort());
  assert.deepEqual([...mainGroups].sort(), [...NODE_TEST_GROUPS].sort());
  assert.deepEqual([...eligibleGroups].sort(), [...NODE_TEST_GROUPS].sort());
  assert.equal(packageJson.scripts?.["test:mbt:coverage"], "c8 npm run test:mbt");
});

test("P3.11: browser tests run without runtime skips", async () => {
  const e2eRoot = path.join(serverRoot, "test/mbt/e2e");
  const skips = [];
  for (const file of await matchingFiles(e2eRoot, /\.spec\.(?:js|mjs)$/u)) {
    const source = await readFile(file, "utf8");
    const explicitSkipCount = (source.match(/test\.skip\s*\(/gu) || []).length;
    const declaredSkips = [...source.matchAll(/test\.skip\(\s*[\s\S]*?,\s*"([^"]+)"\s*\)/gu)];
    assert.equal(
      declaredSkips.length,
      explicitSkipCount,
      `${path.basename(file)} has a skip without a static allowlisted reason.`
    );
    assert.doesNotMatch(source, /test\.(?:fixme|describe\.skip)\s*\(/u);
    skips.push(...declaredSkips.map((match) => ({
      file: path.relative(e2eRoot, file).replaceAll(path.sep, "/"),
      reason: match[1]
    })));
  }
  assert.deepEqual(skips, P3_BROWSER_SKIP_ALLOWLIST);
});

test("P3.12: browser specs share one worker-owned database-pool lifecycle", async () => {
  const e2eRoot = path.join(serverRoot, "test/mbt/e2e");
  const fixtureSource = await readFile(path.join(e2eRoot, "mbt-e2e-test.js"), "utf8");
  assert.match(fixtureSource, /scope:\s*["']worker["']/u);
  assert.match(fixtureSource, /auto:\s*true/u);
  assert.match(fixtureSource, /finally\s*\{[\s\S]*await closeDb\(\)/u);

  for (const file of await matchingFiles(e2eRoot, /\.spec\.(?:js|mjs)$/u)) {
    const source = await readFile(file, "utf8");
    assert.match(
      source,
      /import\s*\{\s*expect,\s*test\s*\}\s*from\s*["']\.\/mbt-e2e-test\.js["']/u,
      `${path.basename(file)} must use the shared worker-scoped E2E fixture.`
    );
    assert.doesNotMatch(
      source,
      /\bcloseDb\b/u,
      `${path.basename(file)} must not close the worker-shared pool.`
    );
  }
});

test("P3.11: the extended mutation manifest owns every dedicated runner and the P3 gauntlet executes it", async () => {
  const supportRoot = path.join(serverRoot, "test/support");
  const [manifest, orchestrator, gauntlet, compose, dockerfile, packageSource, supportFiles] = await Promise.all([
    readFile(path.join(supportRoot, "p3-mutation-manifest.mjs"), "utf8"),
    readFile(path.join(supportRoot, "run-p3-extended-mutations.mjs"), "utf8"),
    readFile(path.join(serverRoot, "tools/mbt-gauntlet.sh"), "utf8"),
    readFile(path.join(repoRoot, "docker-compose.mbt-test.yml"), "utf8"),
    readFile(path.join(serverRoot, "Dockerfile.test"), "utf8"),
    readFile(path.join(serverRoot, "package.json"), "utf8"),
    readdir(supportRoot)
  ]);
  const packageJson = JSON.parse(packageSource);
  const onDisk = supportFiles
    .filter((name) => /^run-.+-mutations?\.mjs$/u.test(name))
    .filter((name) => name !== "run-p3-extended-mutations.mjs")
    .sort();

  assert.deepEqual(onDisk, P3_DEDICATED_MUTATION_RUNNERS);
  for (const runner of P3_DEDICATED_MUTATION_RUNNERS) {
    assert.match(manifest, new RegExp(`runner:\\s*["']${runner.replaceAll(".", "\\.")}["']`));
  }
  assert.match(orchestrator, /readdir\(/);
  assert.ok(orchestrator.includes("^run-.+-mutations?\\.mjs$"));
  assert.match(orchestrator, /dedicated mutation runner manifest is incomplete/i);
  assert.match(orchestrator, /source restoration hash mismatch/i);
  assert.match(orchestrator, /MBT_P3_MUTATION_ADMIN_URL/);
  assert.match(orchestrator, /MBT_P38_MUTATION_ADMIN_URL/);
  assert.match(orchestrator, /MBT_P39_MUTATION_ADMIN_URL/);
  assert.match(orchestrator, /MBT_P310_MUTATION_ADMIN_URL/);
  assert.match(orchestrator, /MBT_P311_MUTATION_ADMIN_URL/);
  assert.equal(
    packageJson.scripts?.["mutate:mbt:p3:extended"],
    "node test/support/run-p3-extended-mutations.mjs"
  );
  assert.match(compose, /mutation-p3:[\s\S]*target:\s*test-e2e[\s\S]*read_only:\s*false/);
  const mutationOwnership = dockerfile.match(/chown\s+-R\s+node:node\s+([\s\S]*?)\n\s*\/app\/tools/u)?.[1] || "";
  const ownedPaths = new Set(mutationOwnership.match(/\/app\/[^\s\\]+/gu) || []);
  for (const writableRoot of ["/app/src", "/app/public", "/app/migrations", "/app/test/support"]) {
    assert.ok(
      ownedPaths.has(writableRoot),
      `The unprivileged writable mutation image must own ${writableRoot}.`
    );
  }
  const p3Contract = explicitBashPhaseBranches(gauntlet, "P3").join("\n");
  assert.match(p3Contract, /build[\s\S]*mutation-p3/);
  assert.match(p3Contract, /run\s+--rm[\s\\]+[\s\S]{0,400}mutation-p3[\s\S]{0,400}mutate:mbt:p3:extended/);
  assert.match(p3Contract, /MBT_P3_MUTATION_ADMIN_URL=/);
  assert.doesNotMatch(p3Contract, /mutate:mbt:p[12]\b/i);
});

test("P3.11: the isolated production-shaped app is restarted and all closed gates are verified again", async () => {
  const gauntlet = await readFile(path.join(serverRoot, "tools/mbt-gauntlet.sh"), "utf8");
  const p3Contract = explicitBashPhaseBranches(gauntlet, "P3").join("\n");

  assert.match(p3Contract, /production-image endpoint\/auth fail-closed smoke[\s\S]*restarting isolated Phase 3 application/);
  assert.match(p3Contract, /restart\s+app/);
  assert.match(p3Contract, /up\s+-d\s+--wait\s+app/);
  assert.ok(
    (p3Contract.match(/assert_mbt_app_health/g) || []).length >= 1,
    "The P3 recovery branch must assert health after restart."
  );
  assert.ok(
    (p3Contract.match(/preflight:mbt-p3-deploy/g) || []).length >= 2,
    "The P3 recovery branch must rerun closed migration/gate preflight."
  );
  assert.ok(
    (p3Contract.match(/MBT_P3_RUNTIME_SMOKE=1/g) || []).length >= 2,
    "The P3 recovery branch must rerun the authenticated fail-closed smoke."
  );
  assert.match(gauntlet, /mbt_project[\s\S]*Refusing to use the production Compose project/);
});

test("P3.11: Driver integrity mutants cover every complete-manifest guard and restore sources exactly", async () => {
  const source = await readFile(path.join(serverRoot, "test/support/run-p39-mutations.mjs"), "utf8");
  for (const name of [
    "whole-route order",
    "durable BIN start",
    "pre-manifest occurrence time",
    "stale asset occurrence time",
    "template before-state",
    "template after-state",
    "exact frozen location identity",
    "active dump acceptance"
  ]) {
    assert.match(source, new RegExp(`name:\\s*["'][^"']*${name}[^"']*["']`, "i"));
  }
  assert.match(source, /driver-bin-manifest-integrity\.test\.js/);
  assert.match(source, /driver-bin-template-state-guard\.test\.js/);
  assert.match(source, /source restoration hash mismatch|did not restore[\s\S]*exactly/i);
});
