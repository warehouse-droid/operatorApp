import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import express from "express";

import {
  beginRollbackContext,
  closeDb
} from "../../../src/db.js";
import {
  claimNetSuitePreflightRun,
  completeNetSuitePreflightRun
} from "../../../src/mbt/netsuite-readiness-repository.js";
import { createMbtRouter } from "../../../src/mbt/router.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const PRIMARY_ACCOUNT = "1234567_SB1";
const SECONDARY_ACCOUNT = "7654321_SB2";
const BASE_RUNTIME = Object.freeze({
  accountId: PRIMARY_ACCOUNT,
  runtimeAccountId: PRIMARY_ACCOUNT,
  environmentName: "sandbox",
  restBaseUrl: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
  sandboxAccountAllowlist: Object.freeze([SECONDARY_ACCOUNT, PRIMARY_ACCOUNT]),
  directAccessEnabled: true,
  readTimeoutMs: 1_000,
  preflightLeaseSeconds: 30
});
const SWITCHED_RUNTIME = Object.freeze({
  ...BASE_RUNTIME,
  restBaseUrl: `${BASE_RUNTIME.restBaseUrl}/`,
  sandboxAccountAllowlist: Object.freeze([PRIMARY_ACCOUNT]),
  directAccessEnabled: false,
  readTimeoutMs: 2_000,
  preflightLeaseSeconds: 40
});
const ACTOR = Object.freeze({
  id: `p2-r6-http-admin-${RUN_ID}`,
  role: "admin",
  roles: Object.freeze(["admin"])
});

let mutableRuntime = BASE_RUNTIME;
let transportCalls = 0;

function effectiveLeaseSeconds(runtime) {
  const readTimeoutSeconds = Math.ceil(runtime.readTimeoutMs / 1_000);
  return Math.min(900, Math.max(
    runtime.preflightLeaseSeconds,
    (readTimeoutSeconds * 6) + 15
  ));
}

function repositoryRuntime(runtime) {
  return {
    adapterKind: "read_only_sandbox",
    accountId: runtime.accountId,
    runtimeAccountId: runtime.runtimeAccountId || runtime.accountId,
    environmentName: runtime.environmentName || "sandbox",
    restBaseUrl: String(runtime.restBaseUrl).replace(/\/+$/, ""),
    directAccessEnabled: runtime.directAccessEnabled,
    sandboxAccountAllowlist: [...runtime.sandboxAccountAllowlist],
    readTimeoutMs: runtime.readTimeoutMs,
    preflightLeaseSeconds: effectiveLeaseSeconds(runtime)
  };
}

function publicRuntimeBinding(runtime) {
  return {
    accountId: runtime.accountId,
    runtimeAccountId: runtime.runtimeAccountId || runtime.accountId,
    environmentName: runtime.environmentName || "sandbox",
    restBaseUrl: String(runtime.restBaseUrl).replace(/\/+$/, ""),
    directAccessEnabled: runtime.directAccessEnabled,
    sandboxAccountAllowlist: [...new Set(runtime.sandboxAccountAllowlist)].sort(),
    readTimeoutMs: runtime.readTimeoutMs,
    effectivePreflightLeaseSeconds: effectiveLeaseSeconds(runtime)
  };
}

function passingChecks(claim) {
  return claim.requirements.map((requirement) => ({
    checkCode: requirement.checkCode,
    status: "passed",
    observed: { fixture: `p2-r6-http-${requirement.checkCode}` },
    message: `P2-R6 HTTP runtime fixture passed ${requirement.checkCode}.`
  }));
}

async function createPassingRun() {
  const runtime = repositoryRuntime(BASE_RUNTIME);
  const claim = await claimNetSuitePreflightRun({
    ...runtime,
    requestedBy: ACTOR.id,
    correlationId: `p2-r6-http-claim-${RUN_ID}`,
    leaseOwner: `p2-r6-http-worker-${RUN_ID}`,
    leaseSeconds: runtime.preflightLeaseSeconds
  });
  const completion = await completeNetSuitePreflightRun({
    preflightRunId: claim.preflightRunId,
    leaseToken: claim.leaseToken,
    checks: passingChecks(claim)
  });
  assert.equal(completion.status, "passed");
  return claim;
}

function authenticate(req, _res, next) {
  if (req.get("authorization") === "Bearer admin") {
    req.operator = ACTOR;
  }
  next();
}

async function request(baseUrl, path, {
  method = "GET",
  body,
  headers = {}
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: "Bearer admin",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    noStore: /(?:^|,)\s*no-store\b/i.test(response.headers.get("cache-control") || ""),
    payload: text ? JSON.parse(text) : null
  };
}

after(async () => {
  await closeDb();
});

test("P2-R6: one router resolves its mutable runtime provider for every latest, detail, and signoff request", async () => {
  const rollback = await beginRollbackContext();
  let server;
  try {
    await rollback.run(async () => {
      mutableRuntime = BASE_RUNTIME;
      transportCalls = 0;
      const claim = await createPassingRun();
      const app = express();
      app.use(express.json());
      app.use(authenticate);
      app.use("/api/mbt", createMbtRouter({
        // The static fallback proves that changing the provider, rather than
        // rebuilding the Express router, controls each request.
        netSuiteRuntime: BASE_RUNTIME,
        netSuiteRuntimeProvider: () => mutableRuntime,
        async netSuiteTransport() {
          transportCalls += 1;
          throw new Error("Runtime-currentness reads must not contact NetSuite.");
        }
      }));
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      const baselineLatest = await request(
        baseUrl,
        "/api/mbt/config/netsuite/preflight/latest"
      );
      const baselineDetail = await request(
        baseUrl,
        `/api/mbt/config/netsuite/preflight/${claim.preflightRunId}`
      );

      mutableRuntime = SWITCHED_RUNTIME;
      const switchedLatest = await request(
        baseUrl,
        "/api/mbt/config/netsuite/preflight/latest"
      );
      const switchedDetail = await request(
        baseUrl,
        `/api/mbt/config/netsuite/preflight/${claim.preflightRunId}`
      );
      const switchedSignoff = await request(
        baseUrl,
        `/api/mbt/config/netsuite/preflight/${claim.preflightRunId}/signoff`,
        {
          method: "POST",
          headers: { "idempotency-key": `p2-r6-http-signoff-${RUN_ID}` },
          body: { auditNote: "Reject a signoff after the live runtime changes." }
        }
      );

      assert.deepEqual({
        transportCalls,
        baseline: {
          latestStatus: baselineLatest.status,
          latestNoStore: baselineLatest.noStore,
          latestRunId: baselineLatest.payload.run.runId,
          latestCurrent: baselineLatest.payload.run.current,
          latestBinding: baselineLatest.payload.runtimeBinding,
          detailStatus: baselineDetail.status,
          detailNoStore: baselineDetail.noStore,
          detailCurrent: baselineDetail.payload.run.current,
          detailBinding: baselineDetail.payload.runtimeBinding
        },
        switched: {
          latestStatus: switchedLatest.status,
          latestNoStore: switchedLatest.noStore,
          latestRunId: switchedLatest.payload.run.runId,
          latestCurrent: switchedLatest.payload.run.current,
          latestBinding: switchedLatest.payload.runtimeBinding,
          detailStatus: switchedDetail.status,
          detailNoStore: switchedDetail.noStore,
          detailCurrent: switchedDetail.payload.run.current,
          detailBinding: switchedDetail.payload.runtimeBinding,
          signoffStatus: switchedSignoff.status,
          signoffNoStore: switchedSignoff.noStore,
          signoffCode: switchedSignoff.payload.code
        }
      }, {
        transportCalls: 0,
        baseline: {
          latestStatus: 200,
          latestNoStore: true,
          latestRunId: claim.preflightRunId,
          latestCurrent: true,
          latestBinding: publicRuntimeBinding(BASE_RUNTIME),
          detailStatus: 200,
          detailNoStore: true,
          detailCurrent: true,
          detailBinding: publicRuntimeBinding(BASE_RUNTIME)
        },
        switched: {
          latestStatus: 200,
          latestNoStore: true,
          latestRunId: claim.preflightRunId,
          latestCurrent: false,
          latestBinding: publicRuntimeBinding(SWITCHED_RUNTIME),
          detailStatus: 200,
          detailNoStore: true,
          detailCurrent: false,
          detailBinding: publicRuntimeBinding(SWITCHED_RUNTIME),
          signoffStatus: 409,
          signoffNoStore: true,
          signoffCode: "MBT_NETSUITE_PREFLIGHT_RUNTIME_NOT_CURRENT"
        }
      });
    });
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await rollback.rollback();
  }
});
