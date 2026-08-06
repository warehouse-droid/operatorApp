import assert from "node:assert/strict";
import test, { after } from "node:test";

import { config } from "../../../src/config.js";
import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { netSuiteReadOnlyGetTransport } from "../../../src/netsuite.js";

const SANDBOX_ROOT = "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest";

function response({
  status = 200,
  body = "{}",
  redirected = false,
  url = `${SANDBOX_ROOT}/record/v1/customer/33`
} = {}) {
  return {
    status,
    redirected,
    url,
    headers: { get: () => "application/json" },
    async text() {
      return body;
    }
  };
}

async function withSandboxRuntime(callback) {
  const previous = {
    directAccessEnabled: config.netsuite.directAccessEnabled,
    accountId: config.netsuite.accountId,
    mbtSandboxAccountAllowlist: config.netsuite.mbtSandboxAccountAllowlist,
    restBaseUrl: config.netsuite.restBaseUrl,
    requestTimeoutMs: config.netsuite.requestTimeoutMs,
    fetch: globalThis.fetch
  };
  const rollback = await beginRollbackContext();
  try {
    config.netsuite.directAccessEnabled = true;
    config.netsuite.accountId = "1234567_SB1";
    config.netsuite.mbtSandboxAccountAllowlist = ["1234567_SB1"];
    config.netsuite.restBaseUrl = SANDBOX_ROOT;
    config.netsuite.requestTimeoutMs = 2_000;
    return await rollback.run(callback);
  } finally {
    globalThis.fetch = previous.fetch;
    config.netsuite.directAccessEnabled = previous.directAccessEnabled;
    config.netsuite.accountId = previous.accountId;
    config.netsuite.mbtSandboxAccountAllowlist = previous.mbtSandboxAccountAllowlist;
    config.netsuite.restBaseUrl = previous.restBaseUrl;
    config.netsuite.requestTimeoutMs = previous.requestTimeoutMs;
    await rollback.rollback();
  }
}

async function storeToken(expiresAt) {
  await query(
    `INSERT INTO netsuite_tokens (
       id, access_token, refresh_token, token_type, expires_at, scope
     ) VALUES (1, 'p2-read-fixture', 'must-not-refresh', 'Bearer', $1, 'rest_webservices')
     ON CONFLICT (id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       token_type = EXCLUDED.token_type,
       expires_at = EXCLUDED.expires_at,
       scope = EXCLUDED.scope,
       updated_at = clock_timestamp()`,
    [expiresAt]
  );
}

after(async () => {
  await closeDb();
});

test("P2-R2: production readiness bridge performs one bounded authenticated GET", async () => {
  await withSandboxRuntime(async () => {
    await storeToken(new Date(Date.now() + 10 * 60 * 1_000));
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return response({ body: JSON.stringify({ id: "33", isInactive: false }) });
    };

    const result = await netSuiteReadOnlyGetTransport({
      method: "GET",
      path: "customer/33"
    });

    assert.deepEqual(result, {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { id: "33", isInactive: false },
      redirected: false,
      url: `${SANDBOX_ROOT}/record/v1/customer/33`
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${SANDBOX_ROOT}/record/v1/customer/33`);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(calls[0].init.body, undefined);
    assert.deepEqual(calls[0].init.headers, {
      Authorization: "Bearer p2-read-fixture",
      Accept: "application/json"
    });
  });
});

test("P2-R2: the adapter's exact same-origin absolute record URL remains in the bounded target", async () => {
  await withSandboxRuntime(async () => {
    await storeToken(new Date(Date.now() + 10 * 60 * 1_000));
    const absoluteUrl = `${SANDBOX_ROOT}/record/v1/customer/33`;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return response({ body: JSON.stringify({ id: "33", isInactive: false }) });
    };

    const result = await netSuiteReadOnlyGetTransport({
      method: "GET",
      path: absoluteUrl
    });

    assert.equal(result.status, 200);
    assert.deepEqual(calls.map(({ url, init }) => ({
      url,
      method: init.method,
      redirect: init.redirect,
      hasBody: init.body !== undefined
    })), [{
      url: absoluteUrl,
      method: "GET",
      redirect: "error",
      hasBody: false
    }]);
  });
});

test("P2-R3: production readiness bridge forwards only an approved metadata Accept type", async () => {
  await withSandboxRuntime(async () => {
    await storeToken(new Date(Date.now() + 10 * 60 * 1_000));
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return response({
        body: JSON.stringify({ components: { schemas: { salesOrder: { properties: {} } } } }),
        url: `${SANDBOX_ROOT}/record/v1/metadata-catalog/salesOrder`
      });
    };

    await netSuiteReadOnlyGetTransport({
      method: "GET",
      path: "metadata-catalog/salesOrder",
      accept: "application/schema+json"
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${SANDBOX_ROOT}/record/v1/metadata-catalog/salesOrder`);
    assert.equal(calls[0].init.headers.Accept, "application/schema+json");
    await assert.rejects(
      () => netSuiteReadOnlyGetTransport({
        method: "GET",
        path: "customer/33",
        accept: "text/html"
      }),
      (error) => error?.status === 409 && error?.code === "MBT_NETSUITE_READ_ACCEPT_REFUSED"
    );
    assert.equal(calls.length, 1);
  });
});

test("P2-R2: method and target escapes fail before token lookup or network access", async () => {
  await withSandboxRuntime(async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return response();
    };
    const attempts = [
      {
        input: { method: "POST", path: "customer/33" },
        code: "MBT_NETSUITE_READ_METHOD_REFUSED"
      },
      {
        input: { method: "GET", path: "https://attacker.invalid/collect" },
        code: "MBT_NETSUITE_READ_PATH_REFUSED"
      },
      {
        input: { method: "GET", path: "../suiteql" },
        code: "MBT_NETSUITE_READ_PATH_REFUSED"
      },
      {
        input: { method: "GET", path: "customer/33?q=changed" },
        code: "MBT_NETSUITE_READ_PATH_REFUSED"
      }
    ];
    for (const { input, code } of attempts) {
      await assert.rejects(
        () => netSuiteReadOnlyGetTransport(input),
        (error) => error?.status === 409 && error?.code === code,
        code
      );
    }
    assert.equal(calls, 0);
  });
});

test("P2-F01: the production OAuth bridge independently refuses non-allowlisted or production configuration before fetch", async () => {
  await withSandboxRuntime(async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return response();
    };
    const scenarios = [
      {
        accountId: "1234567",
        allowlist: ["1234567"],
        restBaseUrl: "https://1234567.suitetalk.api.netsuite.com/services/rest",
        code: "MBT_NETSUITE_PRODUCTION_REFUSED"
      },
      {
        accountId: "1234567_SB1",
        allowlist: [],
        restBaseUrl: SANDBOX_ROOT,
        code: "MBT_NETSUITE_SANDBOX_NOT_ALLOWED"
      },
      {
        accountId: "1234567_SB1",
        allowlist: ["1234567_SB1"],
        restBaseUrl: "https://1234567-sb2.suitetalk.api.netsuite.com/services/rest",
        code: "MBT_NETSUITE_PRODUCTION_REFUSED"
      }
    ];
    for (const scenario of scenarios) {
      config.netsuite.accountId = scenario.accountId;
      config.netsuite.mbtSandboxAccountAllowlist = scenario.allowlist;
      config.netsuite.restBaseUrl = scenario.restBaseUrl;
      await assert.rejects(
        () => netSuiteReadOnlyGetTransport({ method: "GET", path: "customer/33" }),
        (error) => error?.status === 409 && error?.code === scenario.code,
        scenario.code
      );
    }
    assert.equal(calls, 0);
  });
});

test("P2-R2: an expiring token fails closed without refresh or a remote request", async () => {
  await withSandboxRuntime(async () => {
    await storeToken(new Date(Date.now() + 60_000));
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return response();
    };
    await assert.rejects(
      () => netSuiteReadOnlyGetTransport({ method: "GET", path: "customer/33" }),
      (error) => error?.status === 502 && error?.code === "MBT_NETSUITE_TOKEN_UNAVAILABLE"
    );
    assert.equal(calls, 0);
    const retained = await query(
      "SELECT access_token, refresh_token FROM netsuite_tokens WHERE id = 1"
    );
    assert.deepEqual(retained.rows, [{
      access_token: "p2-read-fixture",
      refresh_token: "must-not-refresh"
    }]);
  });
});

test("P2-R2: redirects and oversized responses fail, while malformed JSON stays bounded", async () => {
  await withSandboxRuntime(async () => {
    await storeToken(new Date(Date.now() + 10 * 60 * 1_000));
    globalThis.fetch = async () => response({ redirected: true });
    await assert.rejects(
      () => netSuiteReadOnlyGetTransport({ method: "GET", path: "customer/33" }),
      (error) => error?.status === 502 && error?.code === "MBT_NETSUITE_REDIRECT_REFUSED"
    );

    globalThis.fetch = async () => response({ body: "x".repeat((1024 * 1024) + 1) });
    await assert.rejects(
      () => netSuiteReadOnlyGetTransport({ method: "GET", path: "customer/33" }),
      (error) => error?.status === 502 && error?.code === "MBT_NETSUITE_RESPONSE_TOO_LARGE"
    );

    globalThis.fetch = async () => response({ body: "not-json" });
    const malformed = await netSuiteReadOnlyGetTransport({ method: "GET", path: "customer/33" });
    assert.equal(malformed.body, "not-json");
    assert.equal(JSON.stringify(malformed).includes("p2-read-fixture"), false);
  });
});

test("P2-R2: response limits reject declared and streamed overflow without buffering the full body", async () => {
  await withSandboxRuntime(async () => {
    await storeToken(new Date(Date.now() + 10 * 60 * 1_000));
    let textCalls = 0;
    let cancellations = 0;
    globalThis.fetch = async () => ({
      status: 200,
      redirected: false,
      url: `${SANDBOX_ROOT}/record/v1/customer/33`,
      headers: {
        get(name) {
          return String(name).toLowerCase() === "content-length"
            ? String((1024 * 1024) + 1)
            : "application/json";
        }
      },
      body: { async cancel() { cancellations += 1; } },
      async text() { textCalls += 1; return "must-not-buffer"; }
    });
    await assert.rejects(
      () => netSuiteReadOnlyGetTransport({ method: "GET", path: "customer/33" }),
      (error) => error?.status === 502 && error?.code === "MBT_NETSUITE_RESPONSE_TOO_LARGE"
    );
    assert.equal(textCalls, 0);
    assert.equal(cancellations, 1);

    const chunks = [
      new Uint8Array(700_000),
      new Uint8Array(400_000)
    ];
    let index = 0;
    cancellations = 0;
    globalThis.fetch = async () => ({
      status: 200,
      redirected: false,
      url: `${SANDBOX_ROOT}/record/v1/customer/33`,
      headers: { get: () => "application/json" },
      body: {
        getReader() {
          return {
            async read() {
              return index < chunks.length
                ? { done: false, value: chunks[index++] }
                : { done: true, value: undefined };
            },
            async cancel() { cancellations += 1; }
          };
        }
      },
      async text() { textCalls += 1; return "must-not-buffer"; }
    });
    await assert.rejects(
      () => netSuiteReadOnlyGetTransport({ method: "GET", path: "customer/33" }),
      (error) => error?.status === 502 && error?.code === "MBT_NETSUITE_RESPONSE_TOO_LARGE"
    );
    assert.equal(textCalls, 0);
    assert.equal(cancellations, 1);
  });
});

test("P2-F01/P2-R2: disabled, incomplete, malformed, or tokenless production transport fails closed", async () => {
  await withSandboxRuntime(async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return response();
    };

    config.netsuite.directAccessEnabled = false;
    await assert.rejects(
      () => netSuiteReadOnlyGetTransport({ method: "GET", path: "customer/33" }),
      (error) => error?.status === 409
        && error?.code === "MBT_NETSUITE_DIRECT_ACCESS_REQUIRED"
    );

    config.netsuite.directAccessEnabled = true;
    config.netsuite.restBaseUrl = undefined;
    await assert.rejects(
      () => netSuiteReadOnlyGetTransport({ method: "GET", path: "customer/33" }),
      /Missing required config: netsuite\.restBaseUrl/
    );

    config.netsuite.restBaseUrl = SANDBOX_ROOT;
    config.netsuite.mbtSandboxAccountAllowlist = {};
    await assert.rejects(
      () => netSuiteReadOnlyGetTransport({ method: "GET", path: "customer/33" }),
      (error) => error?.status === 409 && error?.code === "MBT_NETSUITE_SANDBOX_NOT_ALLOWED"
    );

    config.netsuite.mbtSandboxAccountAllowlist = ["1234567_SB1"];
    await query("DELETE FROM netsuite_tokens WHERE id = 1");
    await assert.rejects(
      () => netSuiteReadOnlyGetTransport({ method: "GET", path: "customer/33" }),
      (error) => error?.status === 502 && error?.code === "MBT_NETSUITE_TOKEN_UNAVAILABLE"
    );
    assert.equal(calls, 0);
  });
});

test("P2-R2: production transport honors the exact record root and normalizes timeout failures", async () => {
  await withSandboxRuntime(async () => {
    await storeToken(new Date(Date.now() + 10 * 60 * 1_000));
    config.netsuite.restBaseUrl = `${SANDBOX_ROOT}/record/v1`;
    const timeout = Object.assign(new Error("fixture timeout"), { name: "TimeoutError" });
    globalThis.fetch = async () => {
      throw timeout;
    };
    await assert.rejects(
      () => netSuiteReadOnlyGetTransport({ method: "GET", path: "customer/33" }),
      (error) => error?.code === "NETSUITE_REQUEST_TIMEOUT"
        && error?.timeoutMs === 2_000
        && error?.cause === timeout
    );

    const networkFailure = new Error("fixture network failure");
    globalThis.fetch = async () => {
      throw networkFailure;
    };
    await assert.rejects(
      () => netSuiteReadOnlyGetTransport({ method: "GET", path: "customer/33" }),
      (error) => error === networkFailure
    );

    globalThis.fetch = async () => ({
      status: 204,
      redirected: false,
      url: `${SANDBOX_ROOT}/record/v1/customer/33`,
      headers: { get: () => null },
      async text() { return ""; }
    });
    const empty = await netSuiteReadOnlyGetTransport({ method: "GET", path: "customer/33" });
    assert.deepEqual(empty, {
      status: 204,
      headers: { "content-type": "" },
      body: null,
      redirected: false,
      url: `${SANDBOX_ROOT}/record/v1/customer/33`
    });
  });
});
