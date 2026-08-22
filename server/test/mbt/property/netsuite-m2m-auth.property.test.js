import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createClientAssertion } from "../../../src/netsuite-m2m-auth.js";

const OAUTH_ENDPOINT = "https://1234567.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token";

test("M2M-P1: assertion timestamps remain bounded and signatures verify across 64 issuance times", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 3072,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  for (let index = 0; index < 64; index += 1) {
    const nowMs = Date.UTC(2026, 0, 1) + index * 1_234_567;
    const assertion = createClientAssertion({
      clientId: `client-${index}`,
      certificateId: `certificate-${index}`,
      tokenUrl: OAUTH_ENDPOINT,
      scopes: index % 2 ? ["rest_webservices"] : ["restlets", "rest_webservices"],
      privateKeyPem: privateKey,
      nowMs,
      jwtId: `jti-${index}`
    });
    const [header, payload, signature] = assertion.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url"));
    assert.equal(claims.iat, Math.floor(nowMs / 1000));
    assert.equal(claims.exp - claims.iat, 300);
    assert.equal(
      crypto.verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        {
          key: publicKey,
          padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
          saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
        },
        Buffer.from(signature, "base64url")
      ),
      true
    );
  }
});
