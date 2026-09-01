import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertIsolatedComposeConfig,
  buildIsolatedTestEnvironment,
  resolveHarnessProfile
} from "../../support/test-foundation.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(testDirectory, "../../..");

test("baseline harness resolution is explicit and rejects unsafe commands", () => {
  const manifest = {
    schemaVersion: 1,
    profiles: {
      smoke: ["test:safe"]
    },
    excluded: {
      "test:live": "Requires live credentials."
    }
  };
  const packageScripts = {
    "test:safe": "node src/safe-harness.js",
    "test:live": "node src/live-check.js",
    "test:shell": "node src/safe-harness.js && curl https://example.com"
  };

  assert.deepEqual(resolveHarnessProfile(manifest, packageScripts, "smoke"), [
    {
      name: "test:safe",
      file: "src/safe-harness.js"
    }
  ]);
  assert.throws(
    () => resolveHarnessProfile({ ...manifest, profiles: { smoke: ["test:missing"] } }, packageScripts, "smoke"),
    /not present in package\.json/i
  );
  assert.throws(
    () => resolveHarnessProfile({ ...manifest, profiles: { smoke: ["test:live"] } }, packageScripts, "smoke"),
    /explicitly excluded/i
  );
  assert.throws(
    () => resolveHarnessProfile({ ...manifest, profiles: { smoke: ["test:shell"] } }, packageScripts, "smoke"),
    /single node harness command/i
  );
});

test("full baseline resolution rejects an omitted eligible harness unless it has a documented exclusion", () => {
  const manifest = {
    schemaVersion: 1,
    profiles: {
      full: ["test:owned"]
    },
    excluded: {
      "test:excluded": "Requires an external service."
    }
  };
  const packageScripts = {
    "test:owned": "node src/owned-harness.js",
    "test:omitted": "node src/omitted-harness.js",
    "test:excluded": "node src/excluded-harness.js"
  };

  assert.throws(
    () => resolveHarnessProfile(manifest, packageScripts, "full"),
    /full baseline omits eligible harness test:omitted/i
  );
  assert.doesNotThrow(() => resolveHarnessProfile({
    ...manifest,
    profiles: { full: ["test:owned", "test:omitted"] }
  }, packageScripts, "full"));
});

test("the real full baseline freezes 134 exhaustive harnesses plus documented exclusions", async () => {
  const [manifestSource, packageSource] = await Promise.all([
    readFile(path.join(serverRoot, "test/baseline-harnesses.json"), "utf8"),
    readFile(path.join(serverRoot, "package.json"), "utf8")
  ]);
  const manifest = JSON.parse(manifestSource);
  const packageJson = JSON.parse(packageSource);
  const resolved = resolveHarnessProfile(manifest, packageJson.scripts || {}, "full");

  assert.equal(resolved.length, 134);
  assert.equal(new Set(resolved.map(({ name }) => name)).size, 134);
  assert.deepEqual(Object.keys(manifest.excluded).sort(), [
    "test:netsuite-restlet-live",
    "test:smart-scm"
  ]);
});

test("isolated test environment fails closed for external systems", () => {
  const env = buildIsolatedTestEnvironment({
    PATH: "/usr/bin",
    HOME: "/home/tester",
    DATABASE_URL: "postgres://production.invalid/prod", // secret-scan: allow fail-closed fixture
    NETSUITE_CLIENT_SECRET: "real-secret", // secret-scan: allow fail-closed fixture
    NETSUITE_DIRECT_ACCESS_ENABLED: "true",
    NETSUITE_MIRROR_ROLE: "source",
    SMART_SCM_LIVE_EXECUTION_ENABLED: "true",
    SAMSARA_API_TOKEN: "real-token", // secret-scan: allow fail-closed fixture
    SAMSARA_WRITES_ENABLED: "true",
    GOOGLE_MAPS_API_KEY: "real-key", // secret-scan: allow fail-closed fixture
    OLLAMA_BASE_URL: "https://external.invalid"
  }, {
    databaseUrl: "postgres://mbt_test:mbt_test@db:5432/mbt_test"
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/tester");
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.MBT_TEST_ISOLATED, "1");
  assert.equal(env.DATABASE_URL, "postgres://mbt_test:mbt_test@db:5432/mbt_test");
  assert.equal(env.NETSUITE_DIRECT_ACCESS_ENABLED, "false");
  assert.equal(env.NETSUITE_MIRROR_ROLE, "disabled");
  assert.equal(env.SMART_SCM_LIVE_EXECUTION_ENABLED, "false");
  assert.equal(env.SAMSARA_WRITES_ENABLED, "false");
  assert.equal(env.SALES_PUBLIC_ACCESS_ENABLED, "false");
  assert.equal(env.NETSUITE_CLIENT_SECRET, "");
  assert.equal(env.SAMSARA_API_TOKEN, "");
  assert.equal(env.GOOGLE_MAPS_API_KEY, "");
  assert.equal(env.OLLAMA_BASE_URL, "http://127.0.0.1:9");
});

test("compose isolation guard rejects production mounts, networks, and volumes", () => {
  const safeConfig = `
name: mbbs-mbt-p1-test
services:
  db:
    image: postgres:18-alpine@sha256:abc
    tmpfs:
      - /var/lib/postgresql/data
  app:
    image: mbbs-mbt-p1-runtime-check:latest
    build:
      context: ./server
      dockerfile: Dockerfile
    environment:
      NODE_ENV: "production"
      MBT_ENABLED: "false"
      MBT_NETSUITE_WRITES_ENABLED: "false"
    networks:
      mbt_test_internal:
        aliases:
          - mbt-web
  test:
    image: mbbs-mbt-p1-test-test:latest
    environment:
      MBT_TEST_ISOLATED: "1"
      NETSUITE_DIRECT_ACCESS_ENABLED: "false"
  e2e:
    image: mbbs-mbt-p1-test-test:latest
    environment:
      MBT_TEST_BASE_URL: http://mbt-web:3000
networks:
  mbt_test_internal:
    internal: true
`;

  assert.equal(assertIsolatedComposeConfig(safeConfig), true);
  const safeLoopbackProxy = safeConfig.replace(
    "      MBT_TEST_BASE_URL: http://mbt-web:3000",
    [
      "      MBT_TEST_BASE_URL: http://127.0.0.1:3100",
      "      MBT_TEST_TRUSTED_PROXY_TARGET: http://mbt-web:3000",
      '      MBT_TEST_TRUSTED_PROXY_PORT: "3100"'
    ].join("\n")
  );
  assert.equal(assertIsolatedComposeConfig(safeLoopbackProxy), true);
  assert.throws(
    () => assertIsolatedComposeConfig(
      safeLoopbackProxy.replace("http://mbt-web:3000", "http://app:3000")
    ),
    /isolated MBT test compose/i
  );
  assert.throws(
    () => assertIsolatedComposeConfig(
      safeLoopbackProxy.replace('MBT_TEST_TRUSTED_PROXY_PORT: "3100"', 'MBT_TEST_TRUSTED_PROXY_PORT: "3101"')
    ),
    /isolated MBT test compose/i
  );
  for (const unsafeConfig of [
    `${safeConfig}\n    env_file: ./docker/env/.env`,
    `${safeConfig}\n    volumes: [postgres_data:/var/lib/postgresql/data]`,
    `${safeConfig}\n    volumes: [/var/run/docker.sock:/var/run/docker.sock]`,
    `${safeConfig}\n    volumes: [/etc:/host-etc:ro]`,
    `${safeConfig}\n  ollama: { image: ollama/ollama:latest }`,
    safeConfig.replace('NETSUITE_DIRECT_ACCESS_ENABLED: "false"', 'NETSUITE_DIRECT_ACCESS_ENABLED: "true"'),
    safeConfig.replace("internal: true", "internal: false"),
    safeConfig.replace("name: mbbs-mbt-p1-test", "name: mbbs-operator-app"),
    safeConfig.replace("          - mbt-web", "          - app"),
    safeConfig.replace("MBT_TEST_BASE_URL: http://mbt-web:3000", "MBT_TEST_BASE_URL: http://app:3000"),
    safeConfig.replace("image: mbbs-mbt-p1-runtime-check:latest", "image: mbbs-mbt-p1-test-test:latest"),
    safeConfig.replace('MBT_ENABLED: "false"', 'MBT_ENABLED: "true"'),
    safeConfig.replace("dockerfile: Dockerfile", "dockerfile: Dockerfile.test"),
    `${safeConfig}\n    ports: ["3000:3000"]`
  ]) {
    assert.throws(() => assertIsolatedComposeConfig(unsafeConfig), /isolated MBT test compose/i);
  }
});
