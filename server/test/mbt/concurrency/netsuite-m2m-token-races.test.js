import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { NetSuiteM2mTokenProvider } from "../../../src/netsuite-m2m-auth.js";

const OAUTH_ENDPOINT = "https://1234567.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token";

test("M2M-5: fifty simultaneous callers share exactly one token exchange", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 3072,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  let exchanges = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const provider = new NetSuiteM2mTokenProvider({
    loadCredentials: async () => ({
      revision: 1,
      clientId: "client-id",
      certificateId: "certificate-id",
      tokenUrl: OAUTH_ENDPOINT,
      scopes: ["rest_webservices"],
      privateKeyPem: privateKey
    }),
    fetchImpl: async () => {
      exchanges += 1;
      await barrier;
      return new Response(JSON.stringify({ access_token: "test-shared-token", expires_in: 3600, token_type: "bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const callers = Array.from({ length: 50 }, () => provider.getAccessToken());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exchanges, 1);
  release();
  assert.deepEqual(await Promise.all(callers), Array(50).fill("test-shared-token"));
  assert.equal(exchanges, 1);
});
