import assert from "node:assert/strict";
import test from "node:test";

const authorization = /** @type {Record<string, Function>} */ (await import(
  "../../../src/mbt/driver-bin-authorization.js"
).catch((error) => {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") {throw error;}
  return {};
}));

const job = {
  driverLogin: "p3-driver",
  truckId: "901",
  planDate: "2039-08-03",
  mbt: {
    visitId: "00000000-0000-4000-8000-000000000911",
    contractId: "00000000-0000-4000-8000-000000000912",
    assignment: { truckId: "901" }
  }
};

test("P3-F18: every projected BIN job requires exact active driver/date/truck/contract/visit pilot scope", () => {
  assert.equal(typeof authorization.mbtDriverPilotScopeCoversJobs, "function");
  const scopes = [{
    driverLogin: "p3-driver",
    planDate: "2039-08-03",
    truckId: "901",
    contractId: "00000000-0000-4000-8000-000000000912",
    serviceVisitId: "00000000-0000-4000-8000-000000000911"
  }];
  assert.equal(authorization.mbtDriverPilotScopeCoversJobs([job], scopes, {
    driverLogin: "p3-driver",
    planDate: "2039-08-03"
  }), true);
  for (const field of ["driverLogin", "planDate", "truckId", "contractId", "serviceVisitId"]) {
    const mismatched = scopes.map((scope) => ({
      ...scope,
      [field]: field === "planDate" ? "2039-08-04" : `${scope[field]}-wrong`
    }));
    assert.equal(authorization.mbtDriverPilotScopeCoversJobs([job], mismatched, {
      driverLogin: "p3-driver",
      planDate: "2039-08-03"
    }), false, `${field} mismatch must fail closed`);
  }
});

test("P3-F18: ordinary jobs need no BIN pilot scope and cannot make an unrelated BIN scope sufficient", () => {
  assert.equal(typeof authorization.mbtDriverPilotScopeCoversJobs, "function");
  assert.equal(authorization.mbtDriverPilotScopeCoversJobs([
    { jobId: "ordinary", driverLogin: "ordinary-driver", planDate: "2039-08-03" }
  ], [], { driverLogin: "ordinary-driver", planDate: "2039-08-03" }), true);
  assert.equal(authorization.mbtDriverPilotScopeCoversJobs([job], [{
    driverLogin: "another-driver",
    planDate: "2039-08-03",
    truckId: "901",
    contractId: job.mbt.contractId,
    serviceVisitId: job.mbt.visitId
  }], { driverLogin: "p3-driver", planDate: "2039-08-03" }), false);
});
