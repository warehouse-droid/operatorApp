import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb } from "./db.js";
import { createNetSuiteMirrorSignature } from "./netsuite-mirror-service.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(process.env.MBBS_REPO_ROOT || path.resolve(dirname, "../.."));
const serverRoot = path.resolve(process.env.MBBS_SERVER_ROOT || path.join(repoRoot, "server"));
const secret = "mirror-harness-secret";
const timestamp = "1784419200";
const method = "POST";
const requestPath = "/api/internal/netsuite-sync/events";
const bodyText = JSON.stringify({
  contract: "netsuite-mirror/v1",
  events: [{ sequence: 42, eventUuid: "00000000-0000-4000-8000-000000000042" }]
});
const bodyDigest = crypto.createHash("sha256").update(bodyText).digest("hex");
const expected = crypto
  .createHmac("sha256", secret)
  .update([timestamp, method, requestPath, bodyDigest].join("."))
  .digest("hex");

assert.equal(
  createNetSuiteMirrorSignature({ secret, timestamp, method, path: requestPath, bodyText }),
  expected,
  "mirror signature must bind timestamp, method, exact path, and body digest"
);
assert.notEqual(
  createNetSuiteMirrorSignature({ secret, timestamp, method, path: requestPath, bodyText: "{}" }),
  expected,
  "a changed request body must invalidate the signature"
);

const [migration, v2Compose, v2Env, netsuiteClient, samsaraClient, configClient] = await Promise.all([
  fs.readFile(path.join(serverRoot, "migrations/038_netsuite_mirror.sql"), "utf8"),
  fs.readFile(path.join(repoRoot, "docker-compose.v2.yml"), "utf8"),
  fs.readFile(path.join(repoRoot, "docker/v2.env.example"), "utf8"),
  fs.readFile(path.join(serverRoot, "src/netsuite.js"), "utf8"),
  fs.readFile(path.join(serverRoot, "src/samsara.js"), "utf8"),
  fs.readFile(path.join(serverRoot, "src/config.js"), "utf8")
]);

assert.match(migration, /netsuite_mirror_events/);
assert.match(migration, /source_sequence bigint NOT NULL UNIQUE/);
assert.match(migration, /netsuite_mirror_sequence/);
assert.match(v2Compose, /name: mbbs-operator-app-v2/);
assert.match(v2Compose, /127\.0\.0\.1:3099:3000/);
assert.match(v2Compose, /\.env\.old:\/app\/\.env\.old:ro/);
assert.doesNotMatch(v2Compose, /mirror_sync|MBBS_MIRROR_NETWORK/);
assert.match(v2Env, /NETSUITE_MIRROR_ROLE=disabled/);
assert.match(v2Env, /NETSUITE_DIRECT_ACCESS_ENABLED=true/);
assert.match(v2Env, /SAMSARA_WRITES_ENABLED=false/);
assert.match(v2Env, /SMART_SCM_LIVE_EXECUTION_ENABLED=false/);
assert.match(netsuiteClient, /assertNetSuiteDirectAccessEnabled\(\)/);
assert.match(samsaraClient, /Samsara writes are disabled/);
const consumerGuards = configClient.match(/mirrorRole === "consumer" \? false/g) || [];
assert.equal(consumerGuards.length, 2, "consumer mode must force-disable NetSuite access and Samsara writes");

await closeDb();
console.log("NetSuite compatibility and disabled V2 deployment harness passed.");
