import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import {
  generateNetSuiteM2mCertificate,
  NetSuiteM2mSettingsStore
} from "../../../src/netsuite-m2m-settings.js";

const OAUTH_ENDPOINT = "https://1234567.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token";
const STORAGE_SECRET = "test-storage-secret-that-is-at-least-thirty-two-characters";
const RECOVERY_PASSPHRASE = "one-time recovery passphrase 2026";

let fixtureRoot;
let certificate;

before(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "netsuite-m2m-settings-"));
  certificate = await generateNetSuiteM2mCertificate({ commonName: "MBBS M2M unit test" });
});

after(async () => {
  if (fixtureRoot) {await rm(fixtureRoot, { recursive: true, force: true });}
});

function store(name, storageSecret = STORAGE_SECRET) {
  return new NetSuiteM2mSettingsStore({
    settingsPath: path.join(fixtureRoot, `${name}.json`),
    storageSecret,
    tokenUrl: OAUTH_ENDPOINT,
    certificateGenerator: async () => certificate,
    now: () => new Date("2026-08-15T18:00:00.000Z")
  });
}

function publicKeyDer(value) {
  return crypto.createPublicKey(value).export({ type: "spki", format: "der" });
}

test("M2M-S1: generated certificate is RSA 4096, self-consistent, and no more than two years", async () => {
  const x509 = new crypto.X509Certificate(certificate.publicCertificatePem);
  const privateKey = crypto.createPrivateKey(certificate.privateKeyPem);
  assert.equal(privateKey.asymmetricKeyType, "rsa");
  assert.equal(privateKey.asymmetricKeyDetails.modulusLength, 4096);
  assert.equal(x509.checkPrivateKey(privateKey), true);
  const lifetime = new Date(x509.validTo).getTime() - new Date(x509.validFrom).getTime();
  assert.ok(lifetime > 700 * 24 * 60 * 60 * 1000);
  assert.ok(lifetime <= 731 * 24 * 60 * 60 * 1000);
});

test("M2M-S2: staging returns one encrypted recovery backup and persists no plaintext private credential", async () => {
  const settings = store("staging");
  const staged = await settings.stageCertificate({ recoveryPassphrase: RECOVERY_PASSPHRASE });
  assert.match(staged.publicCertificatePem, /BEGIN CERTIFICATE/);
  assert.match(staged.recoveryPrivateKeyPem, /BEGIN ENCRYPTED PRIVATE KEY/);

  const recoveredKey = crypto.createPrivateKey({
    key: staged.recoveryPrivateKeyPem,
    format: "pem",
    passphrase: RECOVERY_PASSPHRASE
  });
  assert.deepEqual(publicKeyDer(recoveredKey), publicKeyDer(staged.publicCertificatePem));

  const stored = await readFile(path.join(fixtureRoot, "staging.json"), "utf8");
  assert.doesNotMatch(stored, new RegExp(["-----BEGIN", "PRIVATE KEY-----"].join(" ")));
  assert.doesNotMatch(stored, new RegExp(RECOVERY_PASSPHRASE));
  assert.doesNotMatch(JSON.stringify(await settings.getStatus()), /private|passphrase|ciphertext/i);
  assert.equal(await settings.getPublicCertificate("staged"), staged.publicCertificatePem);
  await assert.rejects(() => settings.getRecoveryPrivateKey(), /not available/i);
});

test("M2M-S3: failed probe is atomic; successful probe activates the staged certificate", async () => {
  const settings = store("activation");
  await settings.stageCertificate({ recoveryPassphrase: RECOVERY_PASSPHRASE });
  await assert.rejects(
    () => settings.activate({
      clientId: "client-id",
      certificateId: "certificate-id",
      scopes: ["rest_webservices"],
      probe: async () => { throw new Error("mapping rejected"); }
    }),
    /mapping rejected/i
  );
  await assert.rejects(
    () => settings.activate({
      clientId: "client-id",
      certificateId: "certificate-id",
      scopes: ["rest_webservices"],
      probe: async () => ({ ok: false })
    }),
    /probe did not succeed/i
  );
  assert.equal((await settings.getStatus()).authMode, "authorization_code");
  await assert.rejects(() => settings.getActiveCredentials(), /not active/i);

  let probeCredentials;
  const activated = await settings.activate({
    clientId: "client-id",
    certificateId: "certificate-id",
    scopes: ["rest_webservices", "restlets"],
    probe: async (credentials) => {
      probeCredentials = credentials;
      return { ok: true, account: "1234567" };
    }
  });
  assert.equal(activated.authMode, "client_credentials");
  assert.equal(activated.active.clientIdMasked, "clie…t-id");
  assert.equal(activated.active.certificateIdMasked, "cert…e-id");
  assert.match(probeCredentials.privateKeyPem, /BEGIN PRIVATE KEY/);
  assert.deepEqual(probeCredentials.scopes, ["rest_webservices", "restlets"]);

  const credentials = await settings.getActiveCredentials();
  assert.equal(credentials.clientId, "client-id");
  assert.equal(credentials.certificateId, "certificate-id");
  assert.match(credentials.privateKeyPem, /BEGIN PRIVATE KEY/);
  assert.equal((await settings.getStatus()).staged, null);
});

test("M2M-S4: browser OAuth fallback preserves the active M2M mapping for later reactivation", async () => {
  const settings = store("fallback");
  await settings.stageCertificate({ recoveryPassphrase: RECOVERY_PASSPHRASE });
  await settings.activate({
    clientId: "client-id",
    certificateId: "certificate-id",
    scopes: ["rest_webservices"],
    probe: async () => ({ ok: true })
  });
  const fallback = await settings.useAuthorizationCodeFallback();
  assert.equal(fallback.authMode, "authorization_code");
  assert.ok(fallback.active);
  await assert.rejects(() => settings.getActiveCredentials(), /not active/i);
});

test("M2M-S5: a different storage secret cannot decrypt the runtime private key", async () => {
  const settings = store("wrong-secret");
  await settings.stageCertificate({ recoveryPassphrase: RECOVERY_PASSPHRASE });
  await settings.activate({
    clientId: "client-id",
    certificateId: "certificate-id",
    scopes: ["rest_webservices"],
    probe: async () => ({ ok: true })
  });
  const wrong = store("wrong-secret", "different-storage-secret-that-is-also-long-enough-for-testing");
  await assert.rejects(() => wrong.getActiveCredentials(), /decrypt|credential/i);
});

test("M2M-S6: generated file credentials survive restart with owner-only permissions", async () => {
  const settingsPath = path.join(fixtureRoot, "file-key-settings.json");
  const masterKeyPath = path.join(fixtureRoot, "file-key-master.key");
  const options = {
    settingsPath,
    masterKeyPath,
    tokenUrl: OAUTH_ENDPOINT,
    certificateGenerator: async () => certificate,
    now: () => new Date("2026-08-15T18:00:00.000Z")
  };
  const first = new NetSuiteM2mSettingsStore(options);
  await first.stageCertificate({ recoveryPassphrase: RECOVERY_PASSPHRASE });
  await first.activate({
    clientId: "restart-client",
    certificateId: "restart-certificate",
    scopes: ["rest_webservices"],
    probe: async () => ({ ok: true })
  });

  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
  assert.equal((await stat(masterKeyPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(masterKeyPath, "utf8"), /PRIVATE KEY|restart-client/u);

  const restarted = new NetSuiteM2mSettingsStore(options);
  const credentials = await restarted.getActiveCredentials();
  assert.equal(credentials.clientId, "restart-client");
  assert.equal(credentials.certificateId, "restart-certificate");
  assert.match(credentials.privateKeyPem, /BEGIN PRIVATE KEY/u);
});

test("M2M-S7: fallback can be reactivated only after another successful read-only probe", async () => {
  const settings = store("reactivation");
  await settings.stageCertificate({ recoveryPassphrase: RECOVERY_PASSPHRASE });
  await settings.activate({
    clientId: "client-id",
    certificateId: "certificate-id",
    scopes: ["rest_webservices"],
    probe: async () => ({ ok: true })
  });
  const activeCertificate = await settings.getPublicCertificate("active");
  await settings.useAuthorizationCodeFallback();

  await assert.rejects(
    () => settings.reactivate({ probe: async () => ({ ok: false }) }),
    /probe did not succeed/i
  );
  assert.equal((await settings.getStatus()).authMode, "authorization_code");
  const reactivated = await settings.reactivate({ probe: async () => ({ ok: true }) });
  assert.equal(reactivated.authMode, "client_credentials");
  assert.equal(await settings.getPublicCertificate("active"), activeCertificate);
});

test("M2M-S8: malformed inputs, unsafe state paths, and tampered ciphertext fail closed", async () => {
  assert.throws(() => new NetSuiteM2mSettingsStore(), /settings path/i);
  assert.throws(
    () => new NetSuiteM2mSettingsStore({ settingsPath: path.join(fixtureRoot, "short-secret.json"), storageSecret: "invalid-short" }),
    /at least 32/i
  );
  await assert.rejects(
    () => generateNetSuiteM2mCertificate({ commonName: "invalid/common/name" }),
    /common name/i
  );
  await assert.rejects(
    () => generateNetSuiteM2mCertificate({ execFileImpl: null }),
    /OpenSSL command runner/i
  );

  const invalidInput = store("invalid-input");
  await assert.rejects(
    () => invalidInput.stageCertificate({ recoveryPassphrase: "too short" }),
    /passphrase/i
  );
  await assert.rejects(() => invalidInput.getPublicCertificate("unknown"), /slot/i);
  await assert.rejects(() => invalidInput.getPublicCertificate("active"), /available/i);
  await assert.rejects(() => invalidInput.activate({ probe: async () => ({ ok: true }) }), /staged certificate/i);
  await assert.rejects(() => invalidInput.reactivate({ probe: async () => ({ ok: true }) }), /previously activated/i);

  const malformedPath = path.join(fixtureRoot, "malformed.json");
  await writeFile(malformedPath, "{not-json", { mode: 0o600 });
  const malformed = new NetSuiteM2mSettingsStore({
    settingsPath: malformedPath,
    storageSecret: STORAGE_SECRET,
    tokenUrl: OAUTH_ENDPOINT
  });
  await assert.rejects(() => malformed.getStatus(), /invalid or unsupported/i);

  const targetPath = path.join(fixtureRoot, "symlink-target.json");
  const linkPath = path.join(fixtureRoot, "symlink-settings.json");
  await writeFile(targetPath, JSON.stringify({ version: 1 }), { mode: 0o600 });
  await symlink(targetPath, linkPath);
  const linked = new NetSuiteM2mSettingsStore({
    settingsPath: linkPath,
    storageSecret: STORAGE_SECRET,
    tokenUrl: OAUTH_ENDPOINT
  });
  await assert.rejects(() => linked.getStatus(), /unsafe or invalid/i);

  await assert.rejects(
    () => invalidInput.writeState({
      version: 1,
      revision: 0,
      authMode: "authorization_code",
      active: { privateKeyPem: certificate.privateKeyPem },
      staged: null
    }),
    /plaintext.*private key/i
  );

  const tamperedPath = path.join(fixtureRoot, "tampered.json");
  const tampered = new NetSuiteM2mSettingsStore({
    settingsPath: tamperedPath,
    storageSecret: STORAGE_SECRET,
    tokenUrl: OAUTH_ENDPOINT,
    certificateGenerator: async () => certificate,
    now: () => new Date("2026-08-15T18:00:00.000Z")
  });
  await tampered.stageCertificate({ recoveryPassphrase: RECOVERY_PASSPHRASE });
  await tampered.activate({
    clientId: "client-id",
    certificateId: "certificate-id",
    scopes: ["rest_webservices"],
    probe: async () => ({ ok: true })
  });
  const persisted = JSON.parse(await readFile(tamperedPath, "utf8"));
  persisted.active.encryptedPrivateKey.tag = Buffer.alloc(16, 0).toString("base64");
  await writeFile(tamperedPath, `${JSON.stringify(persisted)}\n`, { mode: 0o600 });
  const reopened = new NetSuiteM2mSettingsStore({
    settingsPath: tamperedPath,
    storageSecret: STORAGE_SECRET,
    tokenUrl: OAUTH_ENDPOINT
  });
  await assert.rejects(() => reopened.getActiveCredentials(), /cannot be decrypted/i);
});
