import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { normalizeM2mScopes } from "./netsuite-m2m-auth.js";

const execFileAsync = promisify(execFile);
const SETTINGS_VERSION = 1;
const MAX_SETTINGS_BYTES = 256 * 1024;
const ENCRYPTION_AAD = Buffer.from("mbbs:netsuite-m2m:private-key:v1");

function defaultState() {
  return {
    version: SETTINGS_VERSION,
    revision: 0,
    authMode: "authorization_code",
    active: null,
    staged: null
  };
}

function cleanPem(value, label) {
  const pem = String(value || "").trim();
  if (!pem) {throw new Error(`A valid ${label} is required.`);}
  return `${pem}\n`;
}

function safeCommonName(value) {
  const commonName = String(value || "MBBS NetSuite M2M").trim();
  if (!commonName || commonName.length > 64 || !/^[A-Za-z0-9 ._@-]+$/.test(commonName)) {
    throw new Error("The certificate common name contains unsupported characters.");
  }
  return commonName;
}

function safeIdentifier(value, label) {
  const identifier = String(value || "").trim();
  if (!identifier || identifier.length > 512 || !/^[A-Za-z0-9._~-]+$/.test(identifier)) {
    throw new Error(`A valid NetSuite ${label} is required.`);
  }
  return identifier;
}

function safeTokenUrl(value) {
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
    throw new Error("A valid NetSuite HTTPS token URL is required.");
  }
  return url.toString();
}

function validateCertificatePair({ privateKeyPem, publicCertificatePem }) {
  let privateKey;
  let certificate;
  try {
    privateKey = crypto.createPrivateKey(cleanPem(privateKeyPem, "private key"));
    certificate = new crypto.X509Certificate(cleanPem(publicCertificatePem, "public certificate"));
  } catch {
    throw new Error("The generated NetSuite certificate or private key is invalid.");
  }
  if (privateKey.asymmetricKeyType !== "rsa"
      || Number(privateKey.asymmetricKeyDetails?.modulusLength || 0) < 3072) {
    throw new Error("The NetSuite M2M private key must be RSA with at least 3072 bits.");
  }
  if (!certificate.checkPrivateKey(privateKey)) {
    throw new Error("The NetSuite certificate does not match its private key.");
  }
  const notBeforeMs = new Date(certificate.validFrom).getTime();
  const notAfterMs = new Date(certificate.validTo).getTime();
  if (!Number.isFinite(notBeforeMs) || !Number.isFinite(notAfterMs) || notAfterMs <= notBeforeMs) {
    throw new Error("The NetSuite certificate validity period is invalid.");
  }
  if (notAfterMs - notBeforeMs > 731 * 24 * 60 * 60 * 1000) {
    throw new Error("The NetSuite certificate validity period cannot exceed two years.");
  }
  return {
    privateKeyPem: cleanPem(privateKeyPem, "private key"),
    publicCertificatePem: cleanPem(publicCertificatePem, "public certificate"),
    fingerprint256: certificate.fingerprint256,
    notBefore: new Date(notBeforeMs).toISOString(),
    notAfter: new Date(notAfterMs).toISOString()
  };
}

export async function generateNetSuiteM2mCertificate({
  commonName = "MBBS NetSuite M2M",
  execFileImpl = execFileAsync,
  temporaryRoot = os.tmpdir()
} = {}) {
  if (typeof execFileImpl !== "function") {throw new TypeError("An OpenSSL command runner is required.");}
  const subject = safeCommonName(commonName);
  const temporaryDirectory = await fs.mkdtemp(path.join(path.resolve(temporaryRoot), "netsuite-m2m-cert-"));
  const privateKeyPath = path.join(temporaryDirectory, "private-key.pem");
  const certificatePath = path.join(temporaryDirectory, "certificate.pem");
  try {
    await execFileImpl("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:4096",
      "-sha256",
      "-days",
      "730",
      "-nodes",
      "-subj",
      `/CN=${subject}`,
      "-addext",
      "keyUsage=critical,digitalSignature",
      "-keyout",
      privateKeyPath,
      "-out",
      certificatePath
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    await fs.chmod(privateKeyPath, 0o600);
    const [privateKeyPem, publicCertificatePem] = await Promise.all([
      fs.readFile(privateKeyPath, "utf8"),
      fs.readFile(certificatePath, "utf8")
    ]);
    return validateCertificatePair({ privateKeyPem, publicCertificatePem });
  } catch (error) {
    const wrapped = new Error("Unable to generate the NetSuite M2M certificate with OpenSSL.");
    wrapped.cause = error;
    throw wrapped;
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function validateRecoveryPassphrase(value) {
  const passphrase = String(value || "");
  if (passphrase.length < 16 || passphrase.length > 256 || /[\r\n\0]/.test(passphrase)) {
    throw new Error("The recovery passphrase must contain 16 to 256 characters without line breaks.");
  }
  return passphrase;
}

function encryptedRecoveryKey(privateKeyPem, passphrase) {
  return String(crypto.createPrivateKey(privateKeyPem).export({
    type: "pkcs8",
    format: "pem",
    cipher: "aes-256-cbc",
    passphrase
  }));
}

function deriveSecretKey(secret) {
  const value = String(secret || "");
  if (value.length < 32) {
    throw new Error("NETSUITE_M2M_STORAGE_SECRET must contain at least 32 characters.");
  }
  return crypto.scryptSync(value, "mbbs:netsuite-m2m:storage:v1", 32);
}

function recordEncryptionKey(masterKey, salt) {
  return Buffer.from(crypto.hkdfSync("sha256", masterKey, salt, ENCRYPTION_AAD, 32));
}

function encryptPrivateKey(privateKeyPem, masterKey) {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", recordEncryptionKey(masterKey, salt), iv);
  cipher.setAAD(ENCRYPTION_AAD);
  const ciphertext = Buffer.concat([cipher.update(privateKeyPem, "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decryptPrivateKey(encrypted, masterKey) {
  if (encrypted?.algorithm !== "aes-256-gcm") {
    throw new Error("The stored NetSuite M2M credential cannot be decrypted.");
  }
  try {
    const salt = Buffer.from(String(encrypted.salt || ""), "base64");
    const iv = Buffer.from(String(encrypted.iv || ""), "base64");
    const tag = Buffer.from(String(encrypted.tag || ""), "base64");
    const ciphertext = Buffer.from(String(encrypted.ciphertext || ""), "base64");
    if (salt.length !== 32 || iv.length !== 12 || tag.length !== 16 || !ciphertext.length) {throw new Error("invalid envelope");}
    const decipher = crypto.createDecipheriv("aes-256-gcm", recordEncryptionKey(masterKey, salt), iv);
    decipher.setAAD(ENCRYPTION_AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("The stored NetSuite M2M credential cannot be decrypted.");
  }
}

function maskIdentifier(value) {
  const text = String(value || "");
  if (!text) {return "";}
  if (text.length <= 8) {return `${text.slice(0, 2)}…${text.slice(-2)}`;}
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

function safeSlot(slot) {
  if (!slot) {return null;}
  return {
    clientIdMasked: maskIdentifier(slot.clientId),
    certificateIdMasked: maskIdentifier(slot.certificateId),
    scopes: Array.isArray(slot.scopes) ? [...slot.scopes] : [],
    fingerprint256: String(slot.fingerprint256 || ""),
    notBefore: slot.notBefore || null,
    notAfter: slot.notAfter || null,
    createdAt: slot.createdAt || null,
    activatedAt: slot.activatedAt || null
  };
}

function safeState(state) {
  return {
    configured: Boolean(state.active),
    revision: Number(state.revision || 0),
    authMode: state.authMode === "client_credentials" ? "client_credentials" : "authorization_code",
    active: safeSlot(state.active),
    staged: safeSlot(state.staged)
  };
}

function normalizeState(value) {
  if (!value || typeof value !== "object" || Number(value.version) !== SETTINGS_VERSION) {
    throw new Error("The NetSuite M2M settings file is invalid or unsupported.");
  }
  return {
    version: SETTINGS_VERSION,
    revision: Math.max(0, Number(value.revision) || 0),
    authMode: value.authMode === "client_credentials" ? "client_credentials" : "authorization_code",
    active: value.active && typeof value.active === "object" ? value.active : null,
    staged: value.staged && typeof value.staged === "object" ? value.staged : null
  };
}

export class NetSuiteM2mSettingsStore {
  constructor({
    settingsPath,
    masterKeyPath,
    storageSecret = "",
    tokenUrl,
    certificateGenerator = generateNetSuiteM2mCertificate,
    now = () => new Date()
  } = {}) {
    if (!settingsPath) {throw new Error("A NetSuite M2M settings path is required.");}
    if (typeof certificateGenerator !== "function") {throw new TypeError("A certificate generator is required.");}
    if (typeof now !== "function") {throw new TypeError("A clock is required.");}
    this.settingsPath = path.resolve(settingsPath);
    this.masterKeyPath = path.resolve(masterKeyPath || path.join(path.dirname(this.settingsPath), ".netsuite-m2m-master-key"));
    this.storageSecret = String(storageSecret || "");
    if (this.storageSecret) {deriveSecretKey(this.storageSecret);}
    this.tokenUrl = tokenUrl;
    this.certificateGenerator = certificateGenerator;
    this.now = now;
    this.masterKey = null;
    this.queue = Promise.resolve();
  }

  locked(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => {});
    return run;
  }

  timestamp() {
    const date = this.now();
    const timestamp = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(timestamp.getTime())) {throw new Error("A valid M2M settings timestamp is required.");}
    return timestamp.toISOString();
  }

  async loadMasterKey() {
    if (this.masterKey) {return this.masterKey;}
    if (this.storageSecret) {
      this.masterKey = deriveSecretKey(this.storageSecret);
      return this.masterKey;
    }
    await fs.mkdir(path.dirname(this.masterKeyPath), { recursive: true, mode: 0o700 });
    try {
      const stored = String(await fs.readFile(this.masterKeyPath, "utf8")).trim();
      const decoded = Buffer.from(stored, "base64");
      if (decoded.length !== 32) {throw new Error("invalid key length");}
      this.masterKey = decoded;
      return this.masterKey;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error("The NetSuite M2M master key file is invalid or unreadable.");
      }
    }
    const generated = crypto.randomBytes(32);
    try {
      await fs.writeFile(this.masterKeyPath, `${generated.toString("base64")}\n`, { flag: "wx", mode: 0o600 });
      this.masterKey = generated;
      return this.masterKey;
    } catch (error) {
      if (error?.code !== "EEXIST") {throw error;}
      const stored = String(await fs.readFile(this.masterKeyPath, "utf8")).trim();
      const decoded = Buffer.from(stored, "base64");
      if (decoded.length !== 32) {throw new Error("The NetSuite M2M master key file is invalid or unreadable.");}
      this.masterKey = decoded;
      return this.masterKey;
    }
  }

  async readState() {
    let contents;
    try {
      const stat = await fs.lstat(this.settingsPath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SETTINGS_BYTES) {
        throw new Error("The NetSuite M2M settings path is unsafe or invalid.");
      }
      contents = await fs.readFile(this.settingsPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {return defaultState();}
      throw error;
    }
    try {
      return normalizeState(JSON.parse(contents));
    } catch (error) {
      if (/NetSuite M2M settings/.test(String(error?.message || ""))) {throw error;}
      throw new Error("The NetSuite M2M settings file is invalid or unsupported.");
    }
  }

  async writeState(state) {
    const directory = path.dirname(this.settingsPath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const serialized = `${JSON.stringify(normalizeState(state), null, 2)}\n`;
    if (/-----BEGIN PRIVATE KEY-----/.test(serialized)) { // secret-scan: allow plaintext-key rejection marker
      throw new Error("Refusing to persist a plaintext NetSuite private key.");
    }
    const temporaryPath = path.join(directory, `.${path.basename(this.settingsPath)}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, this.settingsPath);
      await fs.chmod(this.settingsPath, 0o600);
    } finally {
      if (handle) {await handle.close().catch(() => {});}
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  getStatus() {
    return this.locked(async () => safeState(await this.readState()));
  }

  stageCertificate({ recoveryPassphrase, commonName } = {}) {
    return this.locked(async () => {
      const passphrase = validateRecoveryPassphrase(recoveryPassphrase);
      const generated = validateCertificatePair(await this.certificateGenerator({ commonName }));
      const masterKey = await this.loadMasterKey();
      const state = await this.readState();
      const createdAt = this.timestamp();
      state.revision += 1;
      state.staged = {
        credentialRevision: state.revision,
        clientId: "",
        certificateId: "",
        scopes: [],
        publicCertificatePem: generated.publicCertificatePem,
        encryptedPrivateKey: encryptPrivateKey(generated.privateKeyPem, masterKey),
        fingerprint256: generated.fingerprint256,
        notBefore: generated.notBefore,
        notAfter: generated.notAfter,
        createdAt,
        activatedAt: null
      };
      await this.writeState(state);
      return {
        publicCertificatePem: generated.publicCertificatePem,
        recoveryPrivateKeyPem: encryptedRecoveryKey(generated.privateKeyPem, passphrase),
        status: safeState(state)
      };
    });
  }

  getPublicCertificate(slotName = "active") {
    return this.locked(async () => {
      if (!new Set(["active", "staged"]).has(slotName)) {throw new Error("A valid certificate slot is required.");}
      const state = await this.readState();
      const certificate = String(state[slotName]?.publicCertificatePem || "");
      if (!certificate) {throw new Error(`No ${slotName} NetSuite M2M public certificate is available.`);}
      return certificate;
    });
  }

  async getRecoveryPrivateKey() {
    throw new Error("The one-time private-key recovery backup is not available after certificate generation.");
  }

  activate({ clientId, certificateId, scopes, probe } = {}) {
    return this.locked(async () => {
      if (typeof probe !== "function") {throw new TypeError("A read-only NetSuite activation probe is required.");}
      const state = await this.readState();
      if (!state.staged) {throw new Error("Generate and upload a staged certificate before activating M2M.");}
      const credentials = await this.credentialsForSlot(state.staged, {
        clientId: safeIdentifier(clientId, "client ID"),
        certificateId: safeIdentifier(certificateId, "certificate ID"),
        scopes: normalizeM2mScopes(scopes)
      });
      const evidence = await probe(credentials);
      if (evidence?.ok !== true) {throw new Error("The read-only NetSuite M2M activation probe did not succeed.");}
      state.revision += 1;
      state.active = {
        ...state.staged,
        credentialRevision: state.revision,
        clientId: credentials.clientId,
        certificateId: credentials.certificateId,
        scopes: credentials.scopes,
        activatedAt: this.timestamp()
      };
      state.staged = null;
      state.authMode = "client_credentials";
      await this.writeState(state);
      return safeState(state);
    });
  }

  reactivate({ probe } = {}) {
    return this.locked(async () => {
      if (typeof probe !== "function") {throw new TypeError("A read-only NetSuite activation probe is required.");}
      const state = await this.readState();
      if (!state.active) {throw new Error("No previously activated NetSuite M2M mapping is available.");}
      const credentials = await this.credentialsForSlot(state.active);
      const evidence = await probe(credentials);
      if (evidence?.ok !== true) {throw new Error("The read-only NetSuite M2M activation probe did not succeed.");}
      state.revision += 1;
      state.authMode = "client_credentials";
      state.active = { ...state.active, credentialRevision: state.revision, activatedAt: this.timestamp() };
      await this.writeState(state);
      return safeState(state);
    });
  }

  useAuthorizationCodeFallback() {
    return this.locked(async () => {
      const state = await this.readState();
      state.revision += 1;
      state.authMode = "authorization_code";
      await this.writeState(state);
      return safeState(state);
    });
  }

  getActiveCredentials() {
    return this.locked(async () => {
      const state = await this.readState();
      if (state.authMode !== "client_credentials" || !state.active) {
        throw new Error("NetSuite M2M authentication is not active.");
      }
      return this.credentialsForSlot(state.active);
    });
  }

  async credentialsForSlot(slot, overrides = {}) {
    const masterKey = await this.loadMasterKey();
    return {
      revision: Number(slot.credentialRevision || 0),
      clientId: safeIdentifier(overrides.clientId ?? slot.clientId, "client ID"),
      certificateId: safeIdentifier(overrides.certificateId ?? slot.certificateId, "certificate ID"),
      tokenUrl: safeTokenUrl(typeof this.tokenUrl === "function" ? this.tokenUrl() : this.tokenUrl),
      scopes: normalizeM2mScopes(overrides.scopes ?? slot.scopes),
      privateKeyPem: decryptPrivateKey(slot.encryptedPrivateKey, masterKey)
    };
  }

}
