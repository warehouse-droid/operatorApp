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
  completeNetSuitePreflightRun,
  signoffNetSuitePreflightRun
} from "../../../src/mbt/netsuite-readiness-repository.js";
import { createMbtRouter } from "../../../src/mbt/router.js";

const SUITE_ID = crypto.randomUUID().replaceAll("-", "");
const PRIMARY_ACCOUNT = "1234567_SB1";
const SECONDARY_ACCOUNT = "7654321_SB2";
const BASE_RUNTIME = Object.freeze({
  accountId: PRIMARY_ACCOUNT,
  runtimeAccountId: PRIMARY_ACCOUNT,
  environmentName: "sandbox",
  restBaseUrl: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
  sandboxAccountAllowlist: Object.freeze([PRIMARY_ACCOUNT, SECONDARY_ACCOUNT]),
  directAccessEnabled: true,
  readTimeoutMs: 1_000,
  preflightLeaseSeconds: 30
});
const ACTOR = Object.freeze({
  operatorId: `p2-r7-runtime-admin-${SUITE_ID}`,
  roles: Object.freeze(["admin"])
});
const RUNTIME_MUTATIONS = Object.freeze([
  Object.freeze({
    label: "runtime account ID",
    patch: Object.freeze({ runtimeAccountId: SECONDARY_ACCOUNT }),
    expectedLatestRun: "stale"
  }),
  Object.freeze({
    label: "runtime environment name",
    patch: Object.freeze({ environmentName: "sandbox-reconfigured" }),
    expectedLatestRun: "none"
  })
]);

let sequence = 0;

function commandIdentity(label) {
  sequence += 1;
  return {
    correlationId: `p2-r7-runtime-corr-${label}-${SUITE_ID}-${sequence}`,
    idempotencyKey: `p2-r7-runtime-idem-${label}-${SUITE_ID}-${sequence}`,
    requestId: `p2-r7-runtime-req-${label}-${SUITE_ID}-${sequence}`
  };
}

function repositoryRuntime(runtime) {
  return {
    adapterKind: "read_only_sandbox",
    accountId: runtime.accountId,
    runtimeAccountId: runtime.runtimeAccountId,
    environmentName: runtime.environmentName,
    restBaseUrl: String(runtime.restBaseUrl).replace(/\/+$/, ""),
    directAccessEnabled: runtime.directAccessEnabled,
    sandboxAccountAllowlist: [...runtime.sandboxAccountAllowlist],
    readTimeoutMs: runtime.readTimeoutMs,
    preflightLeaseSeconds: runtime.preflightLeaseSeconds
  };
}

function passingChecks(claim) {
  return claim.requirements.map((requirement) => ({
    checkCode: requirement.checkCode,
    status: "passed",
    observed: { fixture: `p2-r7-runtime-${requirement.checkCode}` },
    message: `P2-R7 runtime fixture passed ${requirement.checkCode}.`
  }));
}

async function createPassingSignedRun(label) {
  const runtime = repositoryRuntime(BASE_RUNTIME);
  const claimIdentity = commandIdentity(`${label}-claim`);
  const claim = await claimNetSuitePreflightRun({
    ...runtime,
    requestedBy: ACTOR.operatorId,
    correlationId: claimIdentity.correlationId,
    leaseOwner: `p2-r7-runtime-worker-${label}-${SUITE_ID}`,
    leaseSeconds: runtime.preflightLeaseSeconds
  });
  const completion = await completeNetSuitePreflightRun({
    preflightRunId: claim.preflightRunId,
    leaseToken: claim.leaseToken,
    checks: passingChecks(claim)
  });
  assert.equal(completion.status, "passed");
  const signed = await signoffNetSuitePreflightRun({
    actor: ACTOR,
    preflightRunId: claim.preflightRunId,
    reason: `P2-R7 baseline signoff for ${label}`,
    runtime,
    ...commandIdentity(`${label}-baseline-signoff`)
  });
  assert.equal(signed.body.signoff.current, true);
  return claim;
}

function authenticate(req, _res, next) {
  if (req.get("authorization") === "Bearer admin") {
    req.operator = {
      id: ACTOR.operatorId,
      role: "admin",
      roles: ACTOR.roles
    };
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
  const responseText = await response.text();
  return {
    status: response.status,
    payload: responseText ? JSON.parse(responseText) : null
  };
}

async function listen(app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

after(async () => {
  await closeDb();
});

for (const { label, patch, expectedLatestRun } of RUNTIME_MUTATIONS) {
  test(`P2-R7 one router binds a live ${label} mutation and makes prior evidence stale`, async () => {
    const rollback = await beginRollbackContext();
    let server;
    try {
      await rollback.run(async () => {
        let mutableRuntime = BASE_RUNTIME;
        let transportCalls = 0;
        const claim = await createPassingSignedRun(label.replaceAll(" ", "-"));
        const app = express();
        app.use(express.json());
        app.use(authenticate);
        app.use("/api/mbt", createMbtRouter({
          netSuiteRuntime: BASE_RUNTIME,
          netSuiteRuntimeProvider: () => mutableRuntime,
          async netSuiteTransport() {
            transportCalls += 1;
            throw new Error("Runtime identity diagnostics must not contact NetSuite.");
          }
        }));
        server = await listen(app);
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        const baselineLatest = await request(
          baseUrl,
          "/api/mbt/config/netsuite/preflight/latest"
        );
        const baselineDetail = await request(
          baseUrl,
          `/api/mbt/config/netsuite/preflight/${claim.preflightRunId}`
        );

        mutableRuntime = Object.freeze({ ...BASE_RUNTIME, ...patch });
        const changedLatest = await request(
          baseUrl,
          "/api/mbt/config/netsuite/preflight/latest"
        );
        const changedDetail = await request(
          baseUrl,
          `/api/mbt/config/netsuite/preflight/${claim.preflightRunId}`
        );
        const changedSignoff = await request(
          baseUrl,
          `/api/mbt/config/netsuite/preflight/${claim.preflightRunId}/signoff`,
          {
            method: "POST",
            headers: { "idempotency-key": `p2-r7-runtime-http-${label}-${SUITE_ID}` },
            body: { auditNote: `Reject stale evidence after ${label} changes.` }
          }
        );

        assert.deepEqual({
          transportCalls,
          baseline: {
            latestCurrent: baselineLatest.payload.run.current,
            latestSignoffCurrent: baselineLatest.payload.run.signoff.current,
            detailCurrent: baselineDetail.payload.run.current,
            detailSignoffCurrent: baselineDetail.payload.run.signoff.current,
            runtimeAccountId: baselineLatest.payload.runtimeBinding.runtimeAccountId,
            environmentName: baselineLatest.payload.runtimeBinding.environmentName
          },
          changed: {
            runtimeAccountId: changedLatest.payload.runtimeBinding.runtimeAccountId,
            environmentName: changedLatest.payload.runtimeBinding.environmentName,
            latestRun: changedLatest.payload.run === null
              ? "none"
              : changedLatest.payload.run.current ? "current" : "stale",
            latestSignoffCurrent: changedLatest.payload.run?.signoff?.current ?? null,
            detailCurrent: changedDetail.payload.run.current,
            detailSignoffCurrent: changedDetail.payload.run.signoff.current,
            signoffStatus: changedSignoff.status,
            signoffCode: changedSignoff.payload.code
          }
        }, {
          transportCalls: 0,
          baseline: {
            latestCurrent: true,
            latestSignoffCurrent: true,
            detailCurrent: true,
            detailSignoffCurrent: true,
            runtimeAccountId: PRIMARY_ACCOUNT,
            environmentName: "sandbox"
          },
          changed: {
            runtimeAccountId: mutableRuntime.runtimeAccountId,
            environmentName: mutableRuntime.environmentName,
            latestRun: expectedLatestRun,
            latestSignoffCurrent: expectedLatestRun === "stale" ? false : null,
            detailCurrent: false,
            detailSignoffCurrent: false,
            signoffStatus: 409,
            signoffCode: "MBT_NETSUITE_PREFLIGHT_RUNTIME_NOT_CURRENT"
          }
        });
      });
    } finally {
      if (server) {
        await closeServer(server);
      }
      await rollback.rollback();
    }
  });
}
