import dotenv from "dotenv";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDispatchPlannerMode } from "./dispatch-planner-optimization.js";

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
  const commaSeparatedValues = (value) => [...new Set(String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean))];
  const boundedInteger = (value, fallback, minimum, maximum) => {
    if (value === undefined || value === null || String(value).trim() === "") {
      return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed)
      ? Math.min(maximum, Math.max(minimum, Math.trunc(parsed)))
      : fallback;
  };
  return {
    port: Number(env.PORT || 3000),
    appBaseUrl: env.APP_BASE_URL || "http://localhost:3000",
    databaseUrl: env.DATABASE_URL,
    googleMapsApiKey: env.GOOGLE_MAPS_API_KEY || "",
    mbt: {
      enabled: booleanValue(env.MBT_ENABLED, false),
      netSuiteWritesEnabled: booleanValue(env.MBT_NETSUITE_WRITES_ENABLED, false)
    },
    mbtPhase3: {
      customerSyncEnabled: booleanValue(env.MBT_CUSTOMER_SYNC_ENABLED, false),
      masterDataEnabled: booleanValue(env.MBT_MASTER_DATA_ENABLED, false),
      assetManagementEnabled: booleanValue(env.MBT_ASSET_MANAGEMENT_ENABLED, false),
      frontdeskOperationsEnabled: booleanValue(env.MBT_FRONTDESK_OPERATIONS_ENABLED, false),
      binDispatchEnabled: booleanValue(env.MBT_BIN_DISPATCH_ENABLED, false),
      driverExecutionEnabled: booleanValue(env.MBT_DRIVER_EXECUTION_ENABLED, false),
      billingOperationsEnabled: booleanValue(env.MBT_BILLING_OPERATIONS_ENABLED, false)
    },
    dispatch: {
      driverOrientedPlanning: ["1", "true", "yes", "on"].includes(String(env.DISPATCH_DRIVER_ORIENTED_PLANNING ?? "false").trim().toLowerCase()),
      plannerOrderPoolMode: normalizeDispatchPlannerMode(env.DISPATCH_PLANNER_ORDER_POOL_MODE),
      plannerCommandMode: normalizeDispatchPlannerMode(env.DISPATCH_PLANNER_COMMAND_MODE)
    },
    driverRoutePush: {
      vapidPublicKey: String(env.DRIVER_ROUTE_PUSH_VAPID_PUBLIC_KEY || "").trim(),
      vapidPrivateKey: String(env.DRIVER_ROUTE_PUSH_VAPID_PRIVATE_KEY || "").trim(),
      vapidSubject: String(env.DRIVER_ROUTE_PUSH_VAPID_SUBJECT || "").trim()
    },
    sales: {
      publicAccessEnabled: booleanValue(env.SALES_PUBLIC_ACCESS_ENABLED, false)
    },
    transferDependency: {
      westYardPenaltyMinutes: Number(env.TRANSFER_DEPENDENCY_150_PENALTY_MINUTES || 60),
      employeeId: String(env.TRANSFER_DEPENDENCY_EMPLOYEE_ID || "8721"),
      deliveryMethodId: String(env.TRANSFER_DEPENDENCY_DELIVERY_METHOD_ID || "2")
    },
    specialStock: {
      deliveryMethodId: String(env.SPECIAL_STOCK_DELIVERY_METHOD_ID || "2").trim(),
      pickupMethodId: String(env.SPECIAL_STOCK_PICKUP_METHOD_ID || "").trim(),
      subsidiaryId: String(env.SPECIAL_STOCK_SUBSIDIARY_ID || env.NETSUITE_SUBSIDIARY_ID || "").trim()
    },
    smartScm: {
      inputDir: path.resolve(env.SMART_SCM_INPUT_DIR || path.join(dataDir, "scm-inputs")),
      printDir: path.resolve(env.SMART_SCM_PRINT_DIR || path.join(dataDir, "scm-print-jobs")),
      maxInputMb: Math.min(100, Math.max(1, Number(env.SMART_SCM_MAX_INPUT_MB || 30))),
      liveExecutionEnabled: booleanValue(env.SMART_SCM_LIVE_EXECUTION_ENABLED, false),
      pickingTicketRestletUrl: String(env.SMART_SCM_PICKING_TICKET_RESTLET_URL || "").trim(),
      forecastIntervalMinutes: Math.max(5, Number(env.SMART_SCM_TICK_INTERVAL_MINUTES || 15))
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
      m2mSettingsPath: path.resolve(env.NETSUITE_M2M_SETTINGS_PATH || path.join(dataDir, "netsuite-m2m-settings.json")),
      m2mMasterKeyPath: path.resolve(env.NETSUITE_M2M_MASTER_KEY_PATH || path.join(dataDir, ".netsuite-m2m-master-key")),
      m2mStorageSecret: env.NETSUITE_M2M_STORAGE_SECRET || "",
      requestTimeoutMs: Number(env.NETSUITE_REQUEST_TIMEOUT_MS || 120000),
      subsidiaryId: env.NETSUITE_SUBSIDIARY_ID || "",
      webhookSecret: env.NETSUITE_WEBHOOK_SECRET || "",
      mbtSandboxAccountAllowlist: commaSeparatedValues(
        env.MBT_NETSUITE_SANDBOX_ACCOUNT_ALLOWLIST
      ),
      mbtReadTimeoutMs: boundedInteger(env.MBT_NETSUITE_READ_TIMEOUT_MS, 10000, 1000, 60000),
      mbtPreflightLeaseSeconds: boundedInteger(
        env.MBT_NETSUITE_PREFLIGHT_LEASE_SECONDS,
        120,
        15,
        900
      ),
      ifIrWebhookSecret: env.NETSUITE_IFIR_WEBHOOK_SECRET || "",
      ifIrWebhookSignatureMaxAgeSeconds: Math.max(
        30,
        Number(env.NETSUITE_IFIR_WEBHOOK_SIGNATURE_MAX_AGE_SECONDS || 300)
      ),
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
  target.mbt = { ...next.mbt };
  target.mbtPhase3 = { ...next.mbtPhase3 };
  target.dispatch = { ...next.dispatch };
  target.driverRoutePush = { ...next.driverRoutePush };
  target.sales = { ...next.sales };
  target.transferDependency = { ...next.transferDependency };
  target.smartScm = { ...next.smartScm };
  target.samsara = { ...next.samsara };
  target.ollama = { ...next.ollama };
  target.photoUpload = { ...next.photoUpload };
  target.netsuite = { ...next.netsuite };
  target.netSuiteMirror = { ...next.netSuiteMirror };
}

export let activeEnvFile = readSelectedEnvFileSync();
export let activeEnvPath = path.join(serverRoot, activeEnvFile);

function parseEnvFileSync(filePath) {
  try {
    return dotenv.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

let activeEnvValues = parseEnvFileSync(activeEnvPath);
let activeEnvAmbientValues = new Map(Object.keys(activeEnvValues).map((key) => [
  key,
  process.env[key]
]));

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
  const nextEnv = { ...process.env };
  for (const key of Object.keys(activeEnvValues)) {
    if (!Object.hasOwn(parsed, key)) {
      const ambientValue = activeEnvAmbientValues.get(key);
      if (ambientValue === undefined) {
        delete nextEnv[key];
      } else {
        nextEnv[key] = ambientValue;
      }
    }
  }
  Object.assign(nextEnv, parsed);
  const nextConfig = buildConfig(nextEnv);
  if (String(nextConfig.databaseUrl || "") !== String(config.databaseUrl || "")) {
    throw new Error("DATABASE_URL is different. Restart the server to switch database connections safely.");
  }
  const nextAmbientValues = new Map(Object.keys(parsed).map((key) => [
    key,
    Object.hasOwn(activeEnvValues, key) ? activeEnvAmbientValues.get(key) : process.env[key]
  ]));
  for (const key of Object.keys(activeEnvValues)) {
    if (!Object.hasOwn(parsed, key)) {
      const ambientValue = activeEnvAmbientValues.get(key);
      if (ambientValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = ambientValue;
      }
    }
  }
  Object.assign(process.env, parsed);
  activeEnvValues = parsed;
  activeEnvAmbientValues = nextAmbientValues;
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
