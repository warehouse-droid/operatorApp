import crypto from "node:crypto";

const ALLOWED_SCOPES = new Set(["rest_webservices", "restlets", "suite_analytics"]);
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const TOKEN_REFRESH_SAFETY_MS = 120_000;

function requiredIdentifier(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 512 || !/^[A-Za-z0-9._~-]+$/.test(normalized)) {
    throw new Error(`A valid NetSuite ${label} is required.`);
  }
  return normalized;
}

function requiredTokenUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("A valid NetSuite HTTPS token URL is required.");
  }
  if (url.protocol !== "https:"
      || !url.hostname.toLowerCase().endsWith(".suitetalk.api.netsuite.com")
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.pathname !== "/services/rest/auth/oauth2/v1/token") {
    throw new Error("The NetSuite token URL must be the exact HTTPS OAuth 2.0 endpoint for the configured account.");
  }
  return url.toString();
}

export function normalizeM2mScopes(value) {
  const input = Array.isArray(value) ? value : String(value || "").split(",");
  const scopes = [...new Set(input.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean))];
  if (!scopes.length) {throw new Error("At least one NetSuite M2M scope is required.");}
  const invalid = scopes.find((scope) => !ALLOWED_SCOPES.has(scope));
  if (invalid) {throw new Error(`Unsupported NetSuite M2M scope: ${invalid}.`);}
  return scopes;
}

function rsaPrivateKey(value) {
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(value);
  } catch {
    throw new Error("A valid NetSuite M2M private key is required.");
  }
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new Error("The NetSuite M2M private key must be RSA.");
  }
  const modulusLength = Number(privateKey.asymmetricKeyDetails?.modulusLength || 0);
  if (modulusLength < 3072) {
    throw new Error("The NetSuite M2M RSA private key must be at least 3072 bits.");
  }
  return privateKey;
}

function encodedJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createClientAssertion({
  clientId,
  certificateId,
  tokenUrl,
  scopes,
  privateKeyPem,
  nowMs = Date.now(),
  jwtId = crypto.randomUUID(),
  ttlSeconds = 300
} = {}) {
  const issuer = requiredIdentifier(clientId, "client ID");
  const keyId = requiredIdentifier(certificateId, "certificate ID");
  const audience = requiredTokenUrl(tokenUrl);
  const normalizedScopes = normalizeM2mScopes(scopes);
  const privateKey = rsaPrivateKey(privateKeyPem);
  const issuedAt = Math.floor(Number(nowMs) / 1000);
  const ttl = Number(ttlSeconds);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {throw new Error("A valid JWT issuance time is required.");}
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 300) {
    throw new Error("The NetSuite M2M assertion lifetime must be between 60 and 300 seconds.");
  }
  const tokenId = requiredIdentifier(jwtId, "JWT ID");
  const header = encodedJson({ typ: "JWT", alg: "PS256", kid: keyId });
  const payload = encodedJson({
    iss: issuer,
    scope: normalizedScopes,
    aud: audience,
    iat: issuedAt,
    exp: issuedAt + ttl,
    jti: tokenId
  });
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign(
    "sha256",
    Buffer.from(signingInput),
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    }
  );
  return `${signingInput}.${signature.toString("base64url")}`;
}

function safeOAuthError(payload, status) {
  const code = String(payload?.error || "").replace(/[^A-Za-z0-9._~-]+/g, "_").slice(0, 80);
  const description = String(payload?.error_description || "")
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, "[redacted credential]")
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "[redacted assertion]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 240);
  return [code || `HTTP_${status}`, description].filter(Boolean).join(": ");
}

function credentialsKey(credentials) {
  return JSON.stringify([
    credentials.revision || 0,
    credentials.clientId,
    credentials.certificateId,
    credentials.tokenUrl,
    normalizeM2mScopes(credentials.scopes)
  ]);
}

export class NetSuiteM2mTokenProvider {
  constructor({
    loadCredentials,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    randomId = () => crypto.randomUUID()
  } = {}) {
    if (typeof loadCredentials !== "function") {throw new TypeError("An M2M credential loader is required.");}
    if (typeof fetchImpl !== "function") {throw new TypeError("An M2M fetch implementation is required.");}
    this.loadCredentials = loadCredentials;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.randomId = randomId;
    this.cached = null;
    this.inFlight = null;
  }

  invalidate() {
    this.cached = null;
  }

  async getAccessToken({ force = false } = {}) {
    const credentials = await this.loadCredentials();
    const key = credentialsKey(credentials);
    const nowMs = Number(this.now());
    if (
      !force
      && this.cached?.key === key
      && this.cached.expiresAt - nowMs > TOKEN_REFRESH_SAFETY_MS
    ) {
      return this.cached.accessToken;
    }
    if (this.inFlight?.key === key) {return this.inFlight.promise;}
    const promise = this.exchange(credentials, key, nowMs);
    this.inFlight = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.inFlight?.promise === promise) {this.inFlight = null;}
    }
  }

  async exchange(credentials, key, nowMs) {
    const tokenUrl = requiredTokenUrl(credentials.tokenUrl);
    const assertion = createClientAssertion({
      ...credentials,
      tokenUrl,
      nowMs,
      jwtId: this.randomId()
    });
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: ASSERTION_TYPE,
      client_assertion: assertion
    });
    const response = await this.fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) {
      throw new Error(`NetSuite M2M token exchange failed: ${safeOAuthError(payload, response.status)}`);
    }
    const accessToken = String(payload.access_token || "").trim();
    const expiresIn = Number(payload.expires_in);
    if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("NetSuite M2M token exchange returned an invalid access-token response.");
    }
    this.cached = {
      key,
      accessToken,
      expiresAt: nowMs + Math.floor(expiresIn * 1000)
    };
    return accessToken;
  }
}
