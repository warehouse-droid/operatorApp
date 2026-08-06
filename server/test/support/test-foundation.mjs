const HARNESS_COMMAND = /^node (src\/[a-z0-9-]+-harness\.js)$/;

const SECRET_ENVIRONMENT_KEYS = [
  "GOOGLE_MAPS_API_KEY",
  "NETSUITE_ACCOUNT_ID",
  "NETSUITE_AUTH_URL",
  "NETSUITE_CLIENT_ID",
  "NETSUITE_CLIENT_SECRET",
  "NETSUITE_IFIR_WEBHOOK_SECRET",
  "NETSUITE_MIRROR_CONSUMER_URL",
  "NETSUITE_MIRROR_SHARED_SECRET",
  "NETSUITE_MIRROR_SOURCE_URL",
  "NETSUITE_REDIRECT_URI",
  "NETSUITE_REST_BASE_URL",
  "NETSUITE_TOKEN_URL",
  "NETSUITE_WEBHOOK_SECRET",
  "PHOTO_UPLOAD_ALLOWED_ORIGINS",
  "PHOTO_UPLOAD_PUBLIC_BASE_URL",
  "PHOTO_UPLOAD_TOKEN_SECRET",
  "PHOTO_UPLOAD_WORKER_URL",
  "SAMSARA_API_KEY",
  "SAMSARA_API_TOKEN",
  "SAMSARA_DVIR_AUTHOR_ID",
  "SMART_SCM_PICKING_TICKET_RESTLET_URL"
];

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is Record<string, unknown>}
 */
function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function assertDocumentedHarnessExclusions(excluded, packageScripts) {
  for (const [name, reason] of Object.entries(excluded)) {
    if (typeof name !== "string" || !name.startsWith("test:")
        || typeof reason !== "string" || !reason.trim()) {
      throw new Error("Every excluded harness must have a test script name and a documented reason.");
    }
    if (typeof packageScripts[name] !== "string") {
      throw new Error(`Excluded harness ${name} is not present in package.json scripts.`);
    }
  }
}

function assertFullHarnessOwnership(profileName, names, excluded, packageScripts) {
  if (profileName !== "full") {
    return;
  }
  const declared = new Set(names);
  const omitted = Object.entries(packageScripts)
    .filter(([, command]) => typeof command === "string" && HARNESS_COMMAND.test(command.trim()))
    .map(([name]) => name)
    .filter((name) => !declared.has(name) && !Object.hasOwn(excluded, name))
    .sort();
  if (omitted.length > 0) {
    throw new Error(`Full baseline omits eligible harness ${omitted.join(", ")}.`);
  }
}

/**
 * @param {{schemaVersion: number, profiles: Record<string, string[]>, excluded?: Record<string, string>}} manifest
 * @param {Record<string, string>} packageScripts
 * @param {string} profileName
 * @returns {{name: string, file: string}[]}
 */
export function resolveHarnessProfile(manifest, packageScripts, profileName) {
  assertPlainObject(manifest, "Harness manifest");
  assertPlainObject(packageScripts, "Package scripts");
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported harness manifest schema: ${String(manifest.schemaVersion)}.`);
  }
  assertPlainObject(manifest.profiles, "Harness profiles");
  assertPlainObject(manifest.excluded || {}, "Excluded harnesses");
  const excluded = manifest.excluded || {};
  assertDocumentedHarnessExclusions(excluded, packageScripts);

  const names = manifest.profiles[profileName];
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error(`Harness profile ${profileName} must contain at least one explicit script.`);
  }
  assertFullHarnessOwnership(profileName, names, excluded, packageScripts);

  const seen = new Set();
  return names.map((name) => {
    if (typeof name !== "string" || !name.startsWith("test:")) {
      throw new Error(`Invalid harness script name in profile ${profileName}.`);
    }
    if (seen.has(name)) {
      throw new Error(`Harness ${name} is listed more than once.`);
    }
    seen.add(name);
    if (Object.hasOwn(excluded, name)) {
      throw new Error(`Harness ${name} is explicitly excluded: ${excluded[name]}`);
    }

    const command = packageScripts[name];
    if (typeof command !== "string") {
      throw new Error(`Harness ${name} is not present in package.json scripts.`);
    }
    const match = HARNESS_COMMAND.exec(command.trim());
    if (!match) {
      throw new Error(`Harness ${name} must be a single Node harness command.`);
    }
    const file = match[1];
    if (!file) {
      throw new Error(`Harness ${name} did not resolve to a file.`);
    }
    return { name, file };
  });
}

/**
 * @param {NodeJS.ProcessEnv} [baseEnvironment]
 * @param {{databaseUrl?: string}} [options]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildIsolatedTestEnvironment(baseEnvironment = {}, { databaseUrl } = {}) {
  assertPlainObject(baseEnvironment, "Base environment");
  const cleanDatabaseUrl = String(databaseUrl || "").trim();
  if (!/^postgres(?:ql)?:\/\/[^/]+\/[^/]+$/.test(cleanDatabaseUrl)) {
    throw new Error("An explicit PostgreSQL test database URL is required.");
  }

  const environment = { ...baseEnvironment };
  for (const key of SECRET_ENVIRONMENT_KEYS) {
    environment[key] = "";
  }
  Object.assign(environment, {
    NODE_ENV: "test",
    MBT_TEST_ISOLATED: "1",
    MBBS_ENV_FILE: ".env.mbt-test-does-not-exist",
    DATABASE_URL: cleanDatabaseUrl,
    APP_BASE_URL: "http://127.0.0.1:3000",
    NETSUITE_DIRECT_ACCESS_ENABLED: "false",
    NETSUITE_MIRROR_ROLE: "disabled",
    SMART_SCM_LIVE_EXECUTION_ENABLED: "false",
    SAMSARA_WRITES_ENABLED: "false",
    SALES_PUBLIC_ACCESS_ENABLED: "false",
    PHOTO_UPLOAD_PROVIDER: "local_data_url",
    OLLAMA_BASE_URL: "http://127.0.0.1:9"
  });
  return environment;
}

/** @param {string} config */
function hasSafeE2eTarget(config) {
  if (/MBT_TEST_BASE_URL\s*:\s*http:\/\/mbt-web:3000\b/i.test(config)) {
    return true;
  }
  const loopbackPort = /MBT_TEST_BASE_URL\s*:\s*http:\/\/127\.0\.0\.1:(\d+)\b/i.exec(config)?.[1];
  const trustedProxyPort = /MBT_TEST_TRUSTED_PROXY_PORT\s*:\s*["']?(\d+)["']?/i.exec(config)?.[1];
  return Boolean(loopbackPort)
    && loopbackPort === trustedProxyPort
    && /MBT_TEST_TRUSTED_PROXY_TARGET\s*:\s*http:\/\/mbt-web:3000\b/i.test(config);
}

/**
 * @param {unknown} source
 */
export function assertIsolatedComposeConfig(source) {
  const config = String(source || "");
  const appService = config.match(/^  app:\s*$([\s\S]*?)^  e2e:\s*$/m)?.[1] || "";
  const forbidden = [
    /(?:^|\s)env_file\s*:/im,
    /docker\/env\/\.env/i,
    /\/var\/run\/docker\.sock/i,
    /\/(?:etc|home|root|var\/run|srv|opt)(?:\/|:)/i,
    /\b(?:postgres_data|app_data|ollama_models)\b/i,
    /^\s{2}ollama\s*:/im,
    /ollama\/ollama/i,
    /NETSUITE_DIRECT_ACCESS_ENABLED\s*:\s*["']?true\b/i,
    /SMART_SCM_LIVE_EXECUTION_ENABLED\s*:\s*["']?true\b/i,
    /SAMSARA_WRITES_ENABLED\s*:\s*["']?true\b/i,
    /internal\s*:\s*false\b/i,
    /name\s*:\s*mbbs-operator-app\b/i,
    /^\s+ports\s*:/im,
    /MBT_TEST_BASE_URL\s*:\s*https?:\/\/app(?::|\/)\b/i
  ];
  const required = [
    /name\s*:\s*mbbs-mbt-p1-test\b/i,
    /image\s*:\s*mbbs-mbt-p1-test-test:latest\b/i,
    /MBT_TEST_ISOLATED\s*:\s*["']?1["']?/i,
    /NETSUITE_DIRECT_ACCESS_ENABLED\s*:\s*["']?false\b/i,
    /\/var\/lib\/postgresql\/data/i,
    /internal\s*:\s*true\b/i,
    /aliases\s*:\s*\n\s*-\s*mbt-web\b/i,
    /image\s*:\s*mbbs-mbt-p1-runtime-check:latest\b/i,
    /dockerfile\s*:\s*Dockerfile\s*$/im,
    /MBT_ENABLED\s*:\s*["']?false\b/i,
    /MBT_NETSUITE_WRITES_ENABLED\s*:\s*["']?false\b/i
  ];

  const productionRuntime = /NODE_ENV\s*:\s*["']?production\b/i.test(appService);
  if (!productionRuntime
      || !hasSafeE2eTarget(config)
      || forbidden.some((pattern) => pattern.test(config))
      || required.some((pattern) => !pattern.test(config))) {
    throw new Error("The isolated MBT test compose configuration is unsafe or incomplete.");
  }
  return true;
}
