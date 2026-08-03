import assert from "node:assert/strict";
import fs from "node:fs/promises";

const repositorySource = await fs.readFile(
  new URL("./driver-offline-repository.js", import.meta.url),
  "utf8"
);
const serverSource = await fs.readFile(new URL("./server.js", import.meta.url), "utf8");

const repositoryStart = repositorySource.indexOf("export async function dismissDriverClientSyncIssue");
const repositoryEnd = repositorySource.indexOf("export async function revokeDriverSession", repositoryStart);
const dismissalRepositorySource = repositorySource.slice(repositoryStart, repositoryEnd);
assert.ok(repositoryStart >= 0 && repositoryEnd > repositoryStart);
assert.match(dismissalRepositorySource, /requiredText\(auditNote, "Audit note"/);
assert.match(dismissalRepositorySource, /session_id = \$1::uuid/);
assert.match(dismissalRepositorySource, /serverReceivedAt' = \$2/);
assert.match(dismissalRepositorySource, /dispatchDismissal/);
assert.match(dismissalRepositorySource, /idempotentReplay: true/);
assert.match(dismissalRepositorySource, /DRIVER_SYNC_ISSUE_CHANGED/);
assert.doesNotMatch(dismissalRepositorySource, /\bDELETE\b/i);
assert.match(
  repositorySource,
  /COALESCE\(sync_status->'dispatchDismissal'->>'reportReceivedAt', ''\)[\s\S]*<> sync_status->>'serverReceivedAt'/,
  "Only the exact dismissed telemetry report may be hidden from active device issues."
);

const routeStart = serverSource.indexOf(
  'app.post("/api/dispatch/offline-review/device-issues/:sessionId/dismiss"'
);
const routeEnd = serverSource.indexOf(
  'app.get("/api/dispatch/driver-pwa/stops"',
  routeStart
);
const dismissalRouteSource = serverSource.slice(routeStart, routeEnd);
assert.ok(routeStart >= 0 && routeEnd > routeStart);
assert.match(dismissalRouteSource, /requireDispatcher/);
assert.match(dismissalRouteSource, /withTransaction\(async \(\) =>/);
assert.match(dismissalRouteSource, /dismissDriverClientSyncIssue\(\{/);
assert.match(dismissalRouteSource, /expectedReportedAt:[\s\S]*expectedReportTimestamp[\s\S]*reportedAt/);
assert.match(dismissalRouteSource, /if \(!dismissal\.idempotentReplay\)[\s\S]*writeDispatchAudit\(\{/);
assert.match(dismissalRouteSource, /action: "driver_client_sync_issue_dismissed"/);
assert.match(dismissalRouteSource, /telemetryPreserved: true/);

console.log("Driver device sync issue dismissal harness passed.");
