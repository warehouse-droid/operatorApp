import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after } from "node:test";

import {
  beginRollbackContext,
  closeDb
} from "../../../src/db.js";
import {
  claimNetSuitePreflightRun,
  completeNetSuitePreflightRun,
  getCurrentNetSuiteReadiness,
  getNetSuitePreflightRun,
  signoffNetSuitePreflightRun
} from "../../../src/mbt/netsuite-readiness-repository.js";

const RUN_ID = crypto.randomUUID().replaceAll("-", "");
const PRIMARY_ACCOUNT = "1234567_SB1";
const SECONDARY_ACCOUNT = "7654321_SB2";
const ACTOR = Object.freeze({
  operatorId: `p2-r6-runtime-admin-${RUN_ID}`,
  roles: Object.freeze(["admin"])
});
const BASE_RUNTIME = Object.freeze({
  adapterKind: "read_only_sandbox",
  accountId: PRIMARY_ACCOUNT,
  environmentName: "sandbox",
  restBaseUrl: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1",
  directAccessEnabled: true,
  sandboxAccountAllowlist: Object.freeze([PRIMARY_ACCOUNT, SECONDARY_ACCOUNT]),
  readTimeoutMs: 10_000,
  preflightLeaseSeconds: 120
});

let sequence = 0;

function commandIdentity(label) {
  sequence += 1;
  return {
    correlationId: `p2-r6-runtime-corr-${label}-${RUN_ID}-${sequence}`,
    idempotencyKey: `p2-r6-runtime-idem-${label}-${RUN_ID}-${sequence}`,
    requestId: `p2-r6-runtime-req-${label}-${RUN_ID}-${sequence}`
  };
}

async function inRollback(callback) {
  const context = await beginRollbackContext();
  try {
    return await context.run(callback);
  } finally {
    await context.rollback();
  }
}

function passingChecks(claim) {
  return claim.requirements.map((requirement) => ({
    checkCode: requirement.checkCode,
    status: "passed",
    observed: { fixture: `p2-r6-runtime-${requirement.checkCode}` },
    message: `P2-R6 runtime fixture passed ${requirement.checkCode}.`
  }));
}

async function createPassingRun(runtime = BASE_RUNTIME, label = "passing") {
  const claim = await claimNetSuitePreflightRun({
    ...runtime,
    requestedBy: ACTOR.operatorId,
    correlationId: commandIdentity(`${label}-claim`).correlationId,
    leaseOwner: `p2-r6-runtime-worker-${RUN_ID}-${sequence}`,
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

async function signoffOutcome(preflightRunId, runtime, label) {
  try {
    const result = await signoffNetSuitePreflightRun({
      actor: ACTOR,
      preflightRunId,
      reason: `P2-R6 runtime currentness ${label}`,
      runtime,
      ...commandIdentity(`${label}-signoff`)
    });
    return { status: result.status, code: null };
  } catch (error) {
    return { status: error?.status, code: error?.code };
  }
}

async function observedInvalidation(claim, runtime, label) {
  const detail = await getNetSuitePreflightRun(claim.preflightRunId, runtime);
  const latest = await getCurrentNetSuiteReadiness(runtime);
  const signoff = await signoffOutcome(claim.preflightRunId, runtime, label);
  return {
    detailCurrent: detail.current,
    latestRunId: latest.run?.preflightRunId || null,
    latestCurrent: latest.run?.current ?? null,
    latestReady: latest.ready,
    signoff
  };
}

const BOUND_RUNTIME_MUTATIONS = Object.freeze([
  Object.freeze({
    label: "direct access state",
    patch: Object.freeze({ directAccessEnabled: false })
  }),
  Object.freeze({
    label: "sandbox allowlist membership",
    patch: Object.freeze({ sandboxAccountAllowlist: Object.freeze([PRIMARY_ACCOUNT]) })
  }),
  Object.freeze({
    label: "read timeout",
    patch: Object.freeze({ readTimeoutMs: 10_001 })
  }),
  Object.freeze({
    label: "effective preflight lease",
    patch: Object.freeze({ preflightLeaseSeconds: 121 })
  })
]);

after(async () => {
  await closeDb();
});

for (const { label, patch } of BOUND_RUNTIME_MUTATIONS) {
  test(`P2-R6: a ${label} change invalidates repository currentness and signoff`, async () => {
    await inRollback(async () => {
      const claim = await createPassingRun(BASE_RUNTIME, label.replaceAll(" ", "-"));
      const changedRuntime = { ...BASE_RUNTIME, ...patch };
      const observed = await observedInvalidation(claim, changedRuntime, label);
      assert.deepEqual(observed, {
        detailCurrent: false,
        latestRunId: claim.preflightRunId,
        latestCurrent: false,
        latestReady: false,
        signoff: {
          status: 409,
          code: "MBT_NETSUITE_PREFLIGHT_RUNTIME_NOT_CURRENT"
        }
      });
    });
  });
}

test("P2-R6: allowlist order is equivalent but exact membership remains fingerprint-bound", async () => {
  await inRollback(async () => {
    const claim = await createPassingRun(BASE_RUNTIME, "allowlist-order");
    const reorderedRuntime = {
      ...BASE_RUNTIME,
      sandboxAccountAllowlist: [SECONDARY_ACCOUNT, PRIMARY_ACCOUNT]
    };
    const reorderedDetail = await getNetSuitePreflightRun(claim.preflightRunId, reorderedRuntime);
    const reorderedSignoff = await signoffNetSuitePreflightRun({
      actor: ACTOR,
      preflightRunId: claim.preflightRunId,
      reason: "P2-R6 allowlist order equivalence",
      runtime: reorderedRuntime,
      ...commandIdentity("allowlist-order-signoff")
    });
    const reorderedLatest = await getCurrentNetSuiteReadiness(reorderedRuntime);

    const changedMembershipRuntime = {
      ...BASE_RUNTIME,
      sandboxAccountAllowlist: [PRIMARY_ACCOUNT]
    };
    const changedDetail = await getNetSuitePreflightRun(
      claim.preflightRunId,
      changedMembershipRuntime
    );
    const changedLatest = await getCurrentNetSuiteReadiness(changedMembershipRuntime);
    const changedSignoff = await signoffOutcome(
      claim.preflightRunId,
      changedMembershipRuntime,
      "allowlist-membership-after-signoff"
    );

    assert.deepEqual({
      reordered: {
        detailCurrent: reorderedDetail.current,
        signoffCurrent: reorderedSignoff.body.signoff.current,
        latestCurrent: reorderedLatest.run?.current,
        latestReady: reorderedLatest.ready
      },
      changedMembership: {
        detailCurrent: changedDetail.current,
        latestCurrent: changedLatest.run?.current,
        latestReady: changedLatest.ready,
        signoff: changedSignoff
      }
    }, {
      reordered: {
        detailCurrent: true,
        signoffCurrent: true,
        latestCurrent: true,
        latestReady: true
      },
      changedMembership: {
        detailCurrent: false,
        latestCurrent: false,
        latestReady: false,
        signoff: {
          status: 409,
          code: "MBT_NETSUITE_PREFLIGHT_RUNTIME_NOT_CURRENT"
        }
      }
    });
  });
});
