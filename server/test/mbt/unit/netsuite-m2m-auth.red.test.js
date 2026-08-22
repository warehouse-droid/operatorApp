import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  createClientAssertion,
  NetSuiteM2mTokenProvider,
  normalizeM2mScopes
} from "../../../src/netsuite-m2m-auth.js";

const OAUTH_ENDPOINT = "https://1234567.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token";
const NON_NETSUITE_ENDPOINT = "https://example.com/services/rest/auth/oauth2/v1/token";
const MALFORMED_ENDPOINT = "not a URL";

function rsaPair(modulusLength = 3072) {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function decodePart(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

test("M2M-1: PS256 client assertion has the exact NetSuite claims and verifies with the matching public key", () => {
  const { privateKey, publicKey } = rsaPair();
  const assertion = createClientAssertion({
    clientId: "client-id-123",
    certificateId: "certificate-id-456",
    tokenUrl: OAUTH_ENDPOINT,
    scopes: ["restlets", "rest_webservices", "restlets"],
    privateKeyPem: privateKey,
    nowMs: Date.UTC(2026, 7, 15, 2, 30, 0),
    jwtId: "fixed-jti"
  });
  const [encodedHeader, encodedPayload, encodedSignature] = assertion.split(".");
  assert.deepEqual(decodePart(encodedHeader), {
    typ: "JWT",
    alg: "PS256",
    kid: "certificate-id-456"
  });
  assert.deepEqual(decodePart(encodedPayload), {
    iss: "client-id-123",
    scope: ["restlets", "rest_webservices"],
    aud: OAUTH_ENDPOINT,
    iat: 1786761000,
    exp: 1786761300,
    jti: "fixed-jti"
  });
  assert.equal(
    crypto.verify(
      "sha256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      {
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
      },
      Buffer.from(encodedSignature, "base64url")
    ),
    true
  );
});

test("M2M-2: assertion validation rejects weak keys, non-HTTPS audiences, unknown scopes, and unsafe identifiers", () => {
  const strong = rsaPair();
  const weak = rsaPair(2048);
  const ec = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  const base = {
    clientId: "client-id",
    certificateId: "certificate-id",
    tokenUrl: OAUTH_ENDPOINT,
    scopes: ["rest_webservices"],
    privateKeyPem: strong.privateKey,
    nowMs: Date.now(),
    jwtId: "jti"
  };
  assert.throws(() => createClientAssertion({ ...base, privateKeyPem: weak.privateKey }), /3072 bits/i);
  assert.throws(() => createClientAssertion({ ...base, privateKeyPem: ec.privateKey }), /must be RSA/i);
  assert.throws(() => createClientAssertion({ ...base, privateKeyPem: "invalid-private-key" }), /valid.*private key/i);
  assert.throws(() => createClientAssertion({ ...base, tokenUrl: OAUTH_ENDPOINT.replace("https:", "http:") }), /HTTPS/i);
  assert.throws(() => createClientAssertion({ ...base, tokenUrl: NON_NETSUITE_ENDPOINT }), /exact HTTPS/i);
  assert.throws(() => createClientAssertion({ ...base, tokenUrl: `${OAUTH_ENDPOINT}?redirect=1` }), /exact HTTPS/i);
  assert.throws(() => createClientAssertion({ ...base, tokenUrl: MALFORMED_ENDPOINT }), /valid.*URL/i);
  assert.throws(() => createClientAssertion({ ...base, scopes: ["administrator"] }), /scope/i);
  assert.throws(() => createClientAssertion({ ...base, scopes: [] }), /scope/i);
  assert.throws(() => createClientAssertion({ ...base, certificateId: "bad\nheader" }), /certificate/i);
  assert.throws(() => createClientAssertion({ ...base, nowMs: 0 }), /issuance time/i);
  assert.throws(() => createClientAssertion({ ...base, ttlSeconds: 59 }), /lifetime/i);
  assert.throws(() => createClientAssertion({ ...base, ttlSeconds: 301 }), /lifetime/i);
  assert.throws(() => createClientAssertion({ ...base, jwtId: "" }), /JWT ID/i);
  assert.deepEqual(normalizeM2mScopes("rest_webservices, restlets,rest_webservices"), ["rest_webservices", "restlets"]);
});

test("M2M-3: token provider posts the JWT bearer grant, caches safely, and never uses Basic authentication", async () => {
  const { privateKey } = rsaPair();
  const requests = [];
  let nowMs = Date.UTC(2026, 7, 15, 2, 30, 0);
  const provider = new NetSuiteM2mTokenProvider({
    loadCredentials: async () => ({
      revision: 4,
      clientId: "client-id",
      certificateId: "certificate-id",
      tokenUrl: OAUTH_ENDPOINT,
      scopes: ["rest_webservices"],
      privateKeyPem: privateKey
    }),
    now: () => nowMs,
    randomId: () => "token-jti",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600, token_type: "bearer" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.equal(await provider.getAccessToken(), "test-access-token");
  assert.equal(await provider.getAccessToken(), "test-access-token");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, OAUTH_ENDPOINT);
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers.Authorization, undefined);
  const body = new URLSearchParams(requests[0].options.body);
  assert.equal(body.get("grant_type"), "client_credentials");
  assert.equal(body.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
  assert.equal(body.get("client_assertion")?.split(".").length, 3);

  nowMs += 3481 * 1000;
  assert.equal(await provider.getAccessToken(), "test-access-token");
  assert.equal(requests.length, 2, "a token with less than two minutes remaining must be replaced");
});

test("M2M-4: token errors are fail-closed and do not echo assertions or private credentials", async () => {
  const { privateKey } = rsaPair();
  const provider = new NetSuiteM2mTokenProvider({
    loadCredentials: async () => ({
      revision: 1,
      clientId: "client-id",
      certificateId: "certificate-id",
      tokenUrl: OAUTH_ENDPOINT,
      scopes: ["rest_webservices"],
      privateKeyPem: privateKey
    }),
    fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "certificate mapping rejected" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    })
  });
  await assert.rejects(
    () => provider.getAccessToken(),
    (error) => {
      assert.match(error.message, /invalid_grant/i);
      assert.doesNotMatch(error.message, /BEGIN PRIVATE KEY|client_assertion|eyJ/i);
      return true;
    }
  );
});

test("M2M-6: malformed responses, transport failures, and changed credentials never leave a stale in-flight token", async () => {
  const { privateKey } = rsaPair();
  const credentials = {
    revision: 1,
    clientId: "client-id",
    certificateId: "certificate-id",
    tokenUrl: OAUTH_ENDPOINT,
    scopes: ["rest_webservices"],
    privateKeyPem: privateKey
  };
  assert.throws(() => new NetSuiteM2mTokenProvider(), /credential loader/i);
  assert.throws(
    () => new NetSuiteM2mTokenProvider({ loadCredentials: async () => credentials, fetchImpl: null }),
    /fetch implementation/i
  );

  const malformed = new NetSuiteM2mTokenProvider({
    loadCredentials: async () => credentials,
    fetchImpl: async () => new Response("not-json", { status: 500 })
  });
  await assert.rejects(() => malformed.getAccessToken(), /HTTP_500/i);

  const incomplete = new NetSuiteM2mTokenProvider({
    loadCredentials: async () => credentials,
    fetchImpl: async () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 })
  });
  await assert.rejects(() => incomplete.getAccessToken(), /invalid access-token response/i);

  let calls = 0;
  let revision = 1;
  const recovering = new NetSuiteM2mTokenProvider({
    loadCredentials: async () => ({ ...credentials, revision }),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {throw new Error("temporary transport failure");}
      return new Response(JSON.stringify({ access_token: `token-${calls}`, expires_in: 3600 }), { status: 200 });
    }
  });
  await assert.rejects(() => recovering.getAccessToken(), /temporary transport failure/i);
  assert.equal(await recovering.getAccessToken(), "token-2");
  revision += 1;
  assert.equal(await recovering.getAccessToken(), "token-3", "a credential revision must invalidate the cached token");
  recovering.invalidate();
  assert.equal(await recovering.getAccessToken(), "token-4");
  assert.equal(await recovering.getAccessToken({ force: true }), "token-5");
});
