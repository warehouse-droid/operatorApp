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
  return {
    port: Number(env.PORT || 3000),
    appBaseUrl: env.APP_BASE_URL || "http://localhost:3000",
    databaseUrl: env.DATABASE_URL,
    googleMapsApiKey: env.GOOGLE_MAPS_API_KEY || "",
    samsara: {
      apiToken: env.SAMSARA_API_TOKEN || env.SAMSARA_API_KEY || "",
      dvirAuthorId: env.SAMSARA_DVIR_AUTHOR_ID || ""
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
      webhookSecret: env.NETSUITE_WEBHOOK_SECRET || ""
    }
  };
}

function replaceConfig(target, next) {
  target.port = next.port;
  target.appBaseUrl = next.appBaseUrl;
  target.databaseUrl = next.databaseUrl;
  target.googleMapsApiKey = next.googleMapsApiKey;
  target.samsara = { ...next.samsara };
  target.photoUpload = { ...next.photoUpload };
  target.netsuite = { ...next.netsuite };
}

export let activeEnvFile = readSelectedEnvFileSync();
export let activeEnvPath = path.join(serverRoot, activeEnvFile);

dotenv.config({ path: activeEnvPath, override: true });

export const config = buildConfig(process.env);

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
