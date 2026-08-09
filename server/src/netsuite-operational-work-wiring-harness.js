import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [serverSource, returnRepositorySource] = await Promise.all([
  readFile(new URL("./server.js", import.meta.url), "utf8"),
  readFile(new URL("./return-repository.js", import.meta.url), "utf8")
]);

test("the global reconciliation guard reads precise operational NetSuite work", () => {
  assert.match(serverSource, /isNetSuiteOperationalWorkActive\(\)/);
  assert.doesNotMatch(serverSource, /returnPendingSyncRunning/);
  assert.doesNotMatch(serverSource, /returnReconciliationRunning/);
  assert.match(serverSource, /returnPendingSyncTickRunning/);
  assert.match(serverSource, /returnReconciliationTickRunning/);
});

test("Return creation and reconciliation mark only actual NetSuite calls as operational work", () => {
  assert.match(returnRepositorySource, /withNetSuiteOperationalWork\(\s*["']returns\.pending["']/);
  assert.match(returnRepositorySource, /withNetSuiteOperationalWork\(\s*["']returns\.reconcile["']/);
  assert.match(returnRepositorySource, /withNetSuiteOperationalWork\(\s*["']returns\.manual-link["']/);
  const pendingDiscovery = returnRepositorySource.indexOf("export async function processPendingReturnSyncs");
  const pendingNetSuiteSignal = returnRepositorySource.match(
    /withNetSuiteOperationalWork\(\s*["']returns\.pending["']/
  )?.index ?? -1;
  assert.ok(pendingDiscovery >= 0 && pendingNetSuiteSignal >= 0);
  assert.ok(
    pendingNetSuiteSignal < pendingDiscovery,
    "The actual NetSuite write must be instrumented inside syncReturnRecord, not around the empty polling query."
  );
});
