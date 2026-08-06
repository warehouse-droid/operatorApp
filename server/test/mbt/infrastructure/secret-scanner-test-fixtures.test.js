import assert from "node:assert/strict";
import test from "node:test";

import { scanTextForSecrets } from "../../support/scan-diff-secrets.mjs";

test("quality: synthetic Phase test credentials are allowed only inside the isolated test tree", () => {
  const fixture = [
    'const password = "p3-synthetic-browser-password";',
    'const targetRevisionToken = "f";'
  ].join("\n");
  assert.deepEqual(scanTextForSecrets(fixture, "test/mbt/e2e/synthetic.spec.js"), []);
  assert.deepEqual(
    scanTextForSecrets(fixture, "src/mbt/production.js").map(({ kind, line }) => ({ kind, line })),
    [
      { kind: "credential_assignment", line: 1 },
      { kind: "credential_assignment", line: 2 }
    ]
  );
  assert.deepEqual(
    scanTextForSecrets(
      'const password = "real-production-secret-123456";', // secret-scan: allow scanner fixture
      "test/mbt/e2e/hostile.spec.js"
    ).map(({ kind, line }) => ({ kind, line })),
    [{ kind: "credential_assignment", line: 1 }]
  );
});
