import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  probeNetSuiteM2mCredentials,
  resolveNetSuiteM2mTokenUrl
} from "../../../src/netsuite-m2m-runtime.js";

const OAUTH_ENDPOINT = "https://1234567.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token";
const CUSTOM_OAUTH_ENDPOINT = "https://custom.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token";
const NON_NETSUITE_ENDPOINT = "https://example.com/services/rest/auth/oauth2/v1/token";
const MALFORMED_ENDPOINT = "not-a-url";

function privateKey() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 3072,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  }).privateKey;
}

test("M2M-R1: token URL is exact and sandbox account IDs are normalized for the account domain", () => {
  assert.equal(
    resolveNetSuiteM2mTokenUrl({ accountId: "1234567_SB1", tokenUrl: "" }),
    "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token"
  );
  assert.equal(
    resolveNetSuiteM2mTokenUrl({
      accountId: "ignored",
      tokenUrl: CUSTOM_OAUTH_ENDPOINT
    }),
    "https://custom.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token"
  );
  assert.throws(() => resolveNetSuiteM2mTokenUrl({ accountId: "bad/account" }), /account ID/i);
  assert.throws(
    () => resolveNetSuiteM2mTokenUrl({ tokenUrl: NON_NETSUITE_ENDPOINT }),
    /valid.*token URL/i
  );
  assert.throws(
    () => resolveNetSuiteM2mTokenUrl({ tokenUrl: `${OAUTH_ENDPOINT}?next=1` }),
    /valid.*token URL/i
  );
  assert.throws(() => resolveNetSuiteM2mTokenUrl({ tokenUrl: MALFORMED_ENDPOINT }), /valid.*token URL/i);
});

test("M2M-R2: activation probe exchanges a token then performs one read-only metadata GET", async () => {
  const requests = [];
  const credentials = {
    revision: 1,
    clientId: "client-id",
    certificateId: "certificate-id",
    tokenUrl: OAUTH_ENDPOINT,
    scopes: ["rest_webservices"],
    privateKeyPem: privateKey()
  };
  const result = await probeNetSuiteM2mCredentials({
    credentials,
    restBaseUrl: "https://1234567.suitetalk.api.netsuite.com/services/rest",
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (requests.length === 1) {
        return new Response(JSON.stringify({ access_token: "test-probe-token", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ links: [] }), {
        status: 200,
        headers: { "content-type": "application/schema+json" }
      });
    }
  });
  assert.deepEqual(result, { ok: true, status: 200, contentType: "application/schema+json" });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "https://1234567.suitetalk.api.netsuite.com/services/rest/record/v1/metadata-catalog");
  assert.equal(requests[1].options.method, "GET");
  assert.equal(requests[1].options.redirect, "error");
  assert.equal(requests[1].options.headers.Authorization, "Bearer test-probe-token");
});

test("M2M-R3: activation probe fails closed on redirects and rejected metadata access", async () => {
  const credentials = {
    revision: 1,
    clientId: "client-id",
    certificateId: "certificate-id",
    tokenUrl: OAUTH_ENDPOINT,
    scopes: ["rest_webservices"],
    privateKeyPem: privateKey()
  };
  let call = 0;
  await assert.rejects(
    () => probeNetSuiteM2mCredentials({
      credentials,
      restBaseUrl: "https://1234567.suitetalk.api.netsuite.com/services/rest",
      fetchImpl: async () => {
        call += 1;
        if (call === 1) {return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });}
        return new Response("forbidden", { status: 403 });
      }
    }),
    /probe failed: 403/i
  );

  await assert.rejects(
    () => probeNetSuiteM2mCredentials({
      credentials,
      restBaseUrl: "https://example.com/services/rest",
      fetchImpl: async () => { throw new Error("must not be called"); }
    }),
    /valid.*REST metadata URL/i
  );

  await assert.rejects(
    () => probeNetSuiteM2mCredentials({
      credentials,
      restBaseUrl: "not-a-url",
      fetchImpl: async () => { throw new Error("must not be called"); }
    }),
    /valid.*REST base URL/i
  );

  await assert.rejects(
    () => probeNetSuiteM2mCredentials({ credentials, restBaseUrl: "https://1234567.suitetalk.api.netsuite.com/services/rest", fetchImpl: null }),
    /probe transport/i
  );
});

test("M2M-R4: activation probe rejects redirects and non-JSON metadata even after a valid token exchange", async () => {
  const credentials = {
    revision: 1,
    clientId: "client-id",
    certificateId: "certificate-id",
    tokenUrl: OAUTH_ENDPOINT,
    scopes: ["rest_webservices"],
    privateKeyPem: privateKey()
  };
  for (const response of [
    {
      ok: true,
      status: 200,
      redirected: true,
      headers: new Headers({ "content-type": "application/json" }),
      body: { cancel: async () => {} }
    },
    new Response("<html>not metadata</html>", {
      status: 200,
      headers: { "content-type": "text/html" }
    })
  ]) {
    let call = 0;
    await assert.rejects(
      () => probeNetSuiteM2mCredentials({
        credentials,
        restBaseUrl: "https://1234567.suitetalk.api.netsuite.com/services/rest",
        fetchImpl: async () => {
          call += 1;
          if (call === 1) {
            return new Response(JSON.stringify({ access_token: "test-token", expires_in: 3600 }), { status: 200 });
          }
          return response;
        }
      }),
      /redirect|unsupported content type/i
    );
    assert.equal(call, 2);
  }
});
