import assert from "node:assert/strict";
import test from "node:test";

import { scanTextForSecrets, scanUnifiedDiff } from "../../support/scan-diff-secrets.mjs";

test("quality: diff-secret scanner detects high-confidence credentials without returning values", () => {
  const sensitive = [
    'NETSUITE_CLIENT_SECRET="real-production-secret-123456"', // secret-scan: allow scanner fixture
    'const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";', // secret-scan: allow scanner fixture
    "-----BEGIN PRIVATE KEY-----" // secret-scan: allow scanner fixture
  ].join("\n");
  const findings = scanTextForSecrets(sensitive, "server/src/example.js");
  assert.deepEqual(findings.map(({ kind, line }) => [kind, line]), [
    ["credential_assignment", 1],
    ["provider_token", 2],
    ["private_key", 3]
  ]);
  assert.doesNotMatch(JSON.stringify(findings), /real-production|ghp_123456/);
});

test("quality: tracked-file scanning evaluates added diff lines but not unchanged legacy text", () => {
  const diff = [
    "diff --git a/server/src/example.js b/server/src/example.js",
    "--- a/server/src/example.js",
    "+++ b/server/src/example.js",
    "@@ -40,0 +41,2 @@",
    '+const safe = "unchanged replacement";',
    '+const apiSecret = "new-real-credential-123456";' // secret-scan: allow scanner fixture
  ].join("\n");
  assert.deepEqual(scanUnifiedDiff(diff), [
    { file: "server/src/example.js", line: 42, kind: "credential_assignment" }
  ]);
});

test("quality: diff-secret scanner permits empty and explicit isolated-test placeholders", () => {
  const safe = [
    'NETSUITE_CLIENT_SECRET=""',
    "POSTGRES_PASSWORD: mbt_test_password",
    'token: "configured-secret-test-fixture"'
  ].join("\n");
  assert.deepEqual(scanTextForSecrets(safe, "docker-compose.mbt-test.yml"), []);
});
