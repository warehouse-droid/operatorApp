import dotenv from "dotenv";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(dirname, "..");
const dataDir = path.join(serverRoot, "data");
const envSelectionPath = path.join(dataDir, "env-selection.json");

function isSelectableEnvFile(file) {
  return /^\.env($|\.)/.test(file) && file !== ".env.example";
}

function readSelectedEnvFileSync() {
  const override = String(process.env.MBBS_ENV_FILE || "").trim();
  if (override && isSelectableEnvFile(path.basename(override))) return path.basename(override);
  try {
    const saved = JSON.parse(fs.readFileSync(envSelectionPath, "utf8"));
    const file = path.basename(String(saved.envFile || saved.selectedEnvFile || ".env"));
    return isSelectableEnvFile(file) ? file : ".env";
  } catch {
    return ".env";
  }
}

function buildConfig(env) {
  const mirrorRole = ["source", "consumer"].includes(String(env.NETSUITE_MIRROR_ROLE || "").trim().toLowerCase())
    ? String(env.NETSUITE_MIRROR_ROLE).trim().toLowerCase()
    : "disabled";
  const booleanValue = (value, fallback) => {
    if (value === undefined || value === null || value === "") return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
  };
  return {
    port: Number(env.PORT || 3000),
    appBaseUrl: env.APP_BASE_URL || "http://localhost:3000",
    databaseUrl: env.DATABASE_URL,
    googleMapsApiKey: env.GOOGLE_MAPS_API_KEY || "",
    transferDependency: {
      westYardPenaltyMinutes: Number(env.TRANSFER_DEPENDENCY_150_PENALTY_MINUTES || 60),
      employeeId: String(env.TRANSFER_DEPENDENCY_EMPLOYEE_ID || "8721"),
      deliveryMethodId: String(env.TRANSFER_DEPENDENCY_DELIVERY_METHOD_ID || "2")
    },
    samsara: {
      apiToken: env.SAMSARA_API_TOKEN || env.SAMSARA_API_KEY || "",
      dvirAuthorId: env.SAMSARA_DVIR_AUTHOR_ID || "",
      writesEnabled: mirrorRole === "consumer" ? false : booleanValue(env.SAMSARA_WRITES_ENABLED, true)
    },
    ollama: {
      baseUrl: String(env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, ""),
      model: env.OLLAMA_MODEL || "qwen3:4b-instruct"
    },
    photoUpload: {
      provider: env.PHOTO_UPLOAD_PROVIDER || "local_data_url",
      workerUrl: env.PHOTO_UPLOAD_WORKER_URL || "",
      tokenSecret: env.PHOTO_UPLOAD_TOKEN_SECRET || "",
      tokenTtlMinutes: Number(env.PHOTO_UPLOAD_TOKEN_TTL_MINUTES || 45),
      maxMb: Number(env.PHOTO_UPLOAD_MAX_MB || 10),
      allowedOrigins: env.PHOTO_UPLOAD_ALLOWED_ORIGINS || "",
      publicBaseUrl: env.PHOTO_UPLOAD_PUBLIC_BASE_URL || ""
    },
    netsuite: {
      accountId: env.NETSUITE_ACCOUNT_ID,
      clientId: env.NETSUITE_CLIENT_ID,
      clientSecret: env.NETSUITE_CLIENT_SECRET,
      redirectUri: env.NETSUITE_REDIRECT_URI,
      authUrl: env.NETSUITE_AUTH_URL,
      tokenUrl: env.NETSUITE_TOKEN_URL,
      restBaseUrl: env.NETSUITE_REST_BASE_URL,
      scopes: env.NETSUITE_SCOPES || "rest_webservices",
      requestTimeoutMs: Number(env.NETSUITE_REQUEST_TIMEOUT_MS || 120000),
      subsidiaryId: env.NETSUITE_SUBSIDIARY_ID || "",
      webhookSecret: env.NETSUITE_WEBHOOK_SECRET || "",
      directAccessEnabled: mirrorRole === "consumer" ? false : booleanValue(env.NETSUITE_DIRECT_ACCESS_ENABLED, true)
    },
    netSuiteMirror: {
      role: mirrorRole,
      sharedSecret: env.NETSUITE_MIRROR_SHARED_SECRET || "",
      sourceBaseUrl: String(env.NETSUITE_MIRROR_SOURCE_URL || "").replace(/\/+$/, ""),
      consumerBaseUrl: String(env.NETSUITE_MIRROR_CONSUMER_URL || "").replace(/\/+$/, ""),
      relayIntervalMs: Math.max(1000, Number(env.NETSUITE_MIRROR_RELAY_INTERVAL_MS || 5000)),
      pollIntervalMs: Math.max(5000, Number(env.NETSUITE_MIRROR_POLL_INTERVAL_MS || 30000)),
      reconcileIntervalMs: Math.max(300000, Number(env.NETSUITE_MIRROR_RECONCILE_INTERVAL_MS || 21600000)),
      requestTimeoutMs: Math.max(1000, Number(env.NETSUITE_MIRROR_REQUEST_TIMEOUT_MS || 15000)),
      signatureMaxAgeSeconds: Math.max(30, Number(env.NETSUITE_MIRROR_SIGNATURE_MAX_AGE_SECONDS || 300)),
      pageSize: Math.min(500, Math.max(1, Number(env.NETSUITE_MIRROR_PAGE_SIZE || 100)))
    }
  };
}

function replaceConfig(target, next) {
  target.port = next.port;
  target.appBaseUrl = next.appBaseUrl;
  target.databaseUrl = next.databaseUrl;
  target.googleMapsApiKey = next.googleMapsApiKey;
  target.transferDependency = { ...next.transferDependency };
  target.samsara = { ...next.samsara };
  target.ollama = { ...next.ollama };
  target.photoUpload = { ...next.photoUpload };
  target.netsuite = { ...next.netsuite };
  target.netSuiteMirror = { ...next.netSuiteMirror };
}

export let activeEnvFile = readSelectedEnvFileSync();
export let activeEnvPath = path.join(serverRoot, activeEnvFile);

dotenv.config({ path: activeEnvPath, override: true });

export const config = buildConfig(process.env);

export function isNetSuiteSandboxEnvironment() {
  const marker = `${config.netsuite.accountId || ""} ${config.netsuite.restBaseUrl || ""}`.toLowerCase();
  return /(?:^|[-_])sb\d+(?:$|[.\s/_-])/.test(marker) || marker.includes("sandbox");
}

export function requireConfig(keys) {
  const missing = keys.filter((key) => !key.split(".").reduce((value, part) => value?.[part], config));
  if (missing.length) {
    throw new Error(`Missing required config: ${missing.join(", ")}`);
  }
}

export async function listEnvFiles() {
  const files = (await fsp.readdir(serverRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && isSelectableEnvFile(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const selectedEnvFile = await readSelectedEnvFile();
  const details = await Promise.all(files.map(async (file) => {
    const stat = await fsp.stat(path.join(serverRoot, file));
    return {
      file,
      selected: file === selectedEnvFile,
      active: file === activeEnvFile,
      lastModifiedAt: stat.mtime.toISOString(),
      size: stat.size
    };
  }));
  return {
    activeEnvFile,
    selectedEnvFile,
    restartRequired: selectedEnvFile !== activeEnvFile,
    files: details
  };
}

export async function readSelectedEnvFile() {
  try {
    const saved = JSON.parse(await fsp.readFile(envSelectionPath, "utf8"));
    const file = path.basename(String(saved.envFile || saved.selectedEnvFile || ".env"));
    return isSelectableEnvFile(file) ? file : ".env";
  } catch {
    return ".env";
  }
}

export async function applyEnvFile(envFile) {
  const file = path.basename(String(envFile || "").trim());
  if (!isSelectableEnvFile(file)) throw new Error("Select a valid env file.");
  const parsed = dotenv.parse(await fsp.readFile(path.join(serverRoot, file), "utf8"));
  const nextEnv = { ...process.env, ...parsed };
  const nextConfig = buildConfig(nextEnv);
  if (String(nextConfig.databaseUrl || "") !== String(config.databaseUrl || "")) {
    throw new Error("DATABASE_URL is different. Restart the server to switch database connections safely.");
  }
  Object.assign(process.env, parsed);
  replaceConfig(config, nextConfig);
  activeEnvFile = file;
  activeEnvPath = path.join(serverRoot, file);
  return listEnvFiles();
}

export async function selectEnvFile(envFile, { applyNow = false } = {}) {
  const file = path.basename(String(envFile || "").trim());
  if (!isSelectableEnvFile(file)) throw new Error("Select a valid env file.");
  const target = path.join(serverRoot, file);
  try {
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error("Selected env file is not a file.");
  } catch {
    throw new Error(`Env file ${file} was not found in server folder.`);
  }
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(envSelectionPath, JSON.stringify({ envFile: file, updatedAt: new Date().toISOString() }, null, 2));
  const previousActiveEnvFile = activeEnvFile;
  if (!applyNow) return { ...(await listEnvFiles()), appliedNow: false, previousActiveEnvFile };
  try {
    return { ...(await applyEnvFile(file)), appliedNow: true, previousActiveEnvFile };
  } catch (error) {
    return { ...(await listEnvFiles()), appliedNow: false, applyError: error.message, previousActiveEnvFile };
  }
}
