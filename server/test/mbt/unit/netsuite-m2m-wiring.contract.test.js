import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("M2M-W1: every normal NetSuite access-token request can select active M2M without changing browser OAuth storage", async () => {
  const source = await readFile(new URL("../../../src/netsuite.js", import.meta.url), "utf8");
  assert.match(source, /isNetSuiteM2mActive/u);
  assert.match(source, /getNetSuiteM2mAccessToken/u);
  assert.match(source, /if \(await isNetSuiteM2mActive\(\)\)/u);
  assert.match(source, /SELECT \* FROM netsuite_tokens WHERE id = 1/u);
  assert.doesNotMatch(source, /saveToken\([^)]*getNetSuiteM2mAccessToken/su);
});

test("M2M-W2: REST and SuiteQL invalidate a rejected M2M token before one retry", async () => {
  const source = await readFile(new URL("../../../src/netsuite.js", import.meta.url), "utf8");
  assert.match(source, /invalidateNetSuiteM2mAccessToken/u);
  assert.match(source, /response\.status === 401/u);
  assert.match(source, /m2mAuthRetry/u);
});
