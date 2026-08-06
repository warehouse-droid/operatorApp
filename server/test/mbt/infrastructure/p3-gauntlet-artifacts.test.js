import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertMbtCiWorkflow } from "../../support/ci-workflow-contract.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDirectory, "../../..");
const repoRoot = path.resolve(process.env.MBBS_REPO_ROOT || path.resolve(serverRoot, ".."));
const UPLOAD_SHA = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";

test("P3 gauntlet artifacts: the JSON skip validator runs immediately after browser E2E", async () => {
  const source = await readFile(path.join(serverRoot, "tools/mbt-gauntlet.sh"), "utf8");
  const e2eRun = source.indexOf('run --rm e2e');
  const validator = source.indexOf('validate-playwright-report.mjs');
  const diffCheck = source.indexOf('echo "[gauntlet] source diff integrity"');

  assert.ok(e2eRun >= 0, "The browser E2E command must remain present.");
  assert.ok(validator > e2eRun, "The persisted skip validator must run after browser E2E.");
  assert.ok(diffCheck > validator, "No later gauntlet layer may defer skip validation.");
  assert.match(source, /test-artifacts\/playwright\/report\.json/);
});

test("P3 gauntlet artifacts: summary writer emits exact pass/fail machine records and rejects bad input", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mbt-gauntlet-summary-"));
  const script = path.join(serverRoot, "tools/mbt-gauntlet-summary.sh");
  try {
    const passedPath = path.join(temporaryDirectory, "passed.json");
    const passed = spawnSync("bash", [
      script,
      passedPath,
      "P3",
      "0",
      "null",
      "2026-08-04T00:00:00Z",
      "2026-08-04T00:10:00Z"
    ], { encoding: "utf8" });
    assert.equal(passed.status, 0, passed.stderr);
    assert.deepEqual(JSON.parse(await readFile(passedPath, "utf8")), {
      schemaVersion: "mbt-gauntlet-summary-v1",
      phase: "P3",
      status: "passed",
      exitCode: 0,
      failedLine: null,
      startedAt: "2026-08-04T00:00:00Z",
      finishedAt: "2026-08-04T00:10:00Z"
    });

    const failedPath = path.join(temporaryDirectory, "failed.json");
    const failed = spawnSync("bash", [
      script,
      failedPath,
      "P3",
      "17",
      "284",
      "2026-08-04T00:00:00Z",
      "2026-08-04T00:02:00Z"
    ], { encoding: "utf8" });
    assert.equal(failed.status, 0, failed.stderr);
    assert.deepEqual(JSON.parse(await readFile(failedPath, "utf8")), {
      schemaVersion: "mbt-gauntlet-summary-v1",
      phase: "P3",
      status: "failed",
      exitCode: 17,
      failedLine: 284,
      startedAt: "2026-08-04T00:00:00Z",
      finishedAt: "2026-08-04T00:02:00Z"
    });

    const rejected = spawnSync("bash", [
      script,
      path.join(temporaryDirectory, "invalid.json"),
      "P4",
      "0",
      "null",
      "2026-08-04T00:00:00Z",
      "2026-08-04T00:01:00Z"
    ], { encoding: "utf8" });
    assert.notEqual(rejected.status, 0);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("P3 gauntlet artifacts: EXIT finalization owns the summary before isolated cleanup", async () => {
  const source = await readFile(path.join(serverRoot, "tools/mbt-gauntlet.sh"), "utf8");
  assert.match(source, /trap\s+['"]mbt_finish_gauntlet\s+["']?\$\?["']?['"]\s+EXIT/);
  assert.match(source, /trap\s+['"]mbt_failed_line=[^\n]+exit 130['"]\s+INT/);
  assert.match(source, /trap\s+['"]mbt_failed_line=[^\n]+exit 143['"]\s+TERM/);
  assert.match(source, /mbt_write_gauntlet_summary[\s\S]*gauntlet-summary\.json/);
  assert.match(source, /mbt_finish_gauntlet[\s\S]*cleanup_mbt_stack[\s\S]*mbt_write_gauntlet_summary/);
});

test("P3 gauntlet artifacts: CI always uploads the bounded artifact directory with a pinned action", async () => {
  const workflowPath = path.join(repoRoot, ".github/workflows/mbt-p3.yml");
  const source = await readFile(workflowPath, "utf8");
  assert.equal(assertMbtCiWorkflow(source, { phase: "P3" }), true);
  assert.match(source, /^        if: \$\{\{ always\(\) \}\}\s*$/m);
  assert.match(source, new RegExp(`^      - uses: actions/upload-artifact@${UPLOAD_SHA}$`, "m"));
  assert.match(source, /^          path: server\/test-artifacts\/\s*$/m);
  assert.match(source, /^          if-no-files-found: error\s*$/m);
  assert.match(source, /^          retention-days: 14\s*$/m);

  for (const unsafe of [
    source.replace("if: ${{ always() }}", "if: success()"),
    source.replace(UPLOAD_SHA, "v4"),
    source.replace("path: server/test-artifacts/", "path: /"),
    source.replace("if-no-files-found: error", "if-no-files-found: warn"),
    source.replace("contents: read", "contents: write")
  ]) {
    assert.throws(
      () => assertMbtCiWorkflow(unsafe, { phase: "P3" }),
      /unsafe MBT Phase 3 CI workflow/i
    );
  }
});

test("P3 gauntlet artifacts: persisted isolated mutations cover the exact skip boundary", async () => {
  const [source, gauntlet] = await Promise.all([
    readFile(path.join(serverRoot, "test/support/check-p3-gauntlet-artifact-mutations.mjs"), "utf8"),
    readFile(path.join(serverRoot, "tools/mbt-gauntlet.sh"), "utf8")
  ]);
  const names = [...source.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(names, [
    "ignores report-level errors",
    "ignores unexpected tests",
    "ignores flaky tests",
    "ignores expected-status skips",
    "accepts runtime skips",
    "ignores the JSON stats skip count"
  ]);
  assert.match(source, /mkdtemp/);
  assert.match(source, /playwright-report-validator\.property\.test\.js/);
  assert.match(source, /source restoration hash mismatch/i);
  assert.match(source, /6\/6 Phase 3 gauntlet artifact mutants killed by the property suite alone/);
  assert.match(
    gauntlet,
    /P3\)[\s\S]*check-p3-gauntlet-artifact-mutations\.mjs[\s\S]*;;/,
    "The P3 gauntlet must execute its persisted artifact boundary mutants."
  );
});
