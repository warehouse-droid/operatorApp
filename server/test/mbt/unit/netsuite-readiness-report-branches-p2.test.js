import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPreflightReport,
  serializePreflightCsv
} from "../../../src/mbt/netsuite-readiness-report.js";

function baseRun(overrides = {}) {
  return {
    runId: "b1111111-2222-4333-8444-555555555555",
    accountId: "1234567_SB1",
    environmentName: "sandbox",
    configurationHash: "b".repeat(64),
    status: "unable_to_verify",
    generatedAt: "2026-08-03T16:00:00.000Z",
    current: false,
    signoff: null,
    checks: [],
    ...overrides
  };
}

test("P2-F05 report boundaries reject malformed roots and support empty reports", () => {
  for (const value of [null, undefined, "run", 7, []]) {
    assert.throws(
      () => buildPreflightReport(value),
      /persisted NetSuite preflight run/
    );
    assert.throws(
      () => serializePreflightCsv(value),
      /NetSuite preflight report/
    );
  }

  const withoutChecks = buildPreflightReport({
    runId: "empty",
    signoff: [],
    checks: "not-an-array"
  });
  assert.deepEqual(withoutChecks.checks, []);
  assert.equal(withoutChecks.signoff, null);
  assert.equal(Object.isFrozen(withoutChecks), true);
  assert.equal(
    serializePreflightCsv({ ...withoutChecks, checks: null }),
    "run_id,account_id,environment_name,configuration_hash,run_status,generated_at,current,signoff_status,sequence_number,check_code,mapping_type,local_key,required,severity,check_status,expected_json,observed_json,message\r\n"
  );
});

test("P2-F05 report projection bounds cycles, scalars, arrays, dangerous keys, and malformed checks", () => {
  const hostile = Object.create(null);
  hostile.safeNumber = 42;
  hostile.notFinite = Number.POSITIVE_INFINITY;
  hostile.bigInteger = 1n;
  hostile.callable = () => "not evidence";
  hostile.symbol = Symbol("not evidence");
  hostile.array = [true, 3, Number.NaN, "safe"];
  Object.defineProperty(hostile, "__proto__", { enumerable: true, value: "refused" });
  Object.defineProperty(hostile, "constructor", { enumerable: true, value: "refused" });
  Object.defineProperty(hostile, "prototype", { enumerable: true, value: "refused" });
  hostile.accessToken = "must-not-persist";
  hostile.rawResponse = { refused: true };
  hostile.links = [{ href: "https://attacker.invalid" }];
  hostile.self = hostile;

  const report = buildPreflightReport(baseRun({
    checks: [
      {
        sequenceNumber: 2,
        checkCode: "tie_b",
        expected: hostile,
        observed: [1, Number.NEGATIVE_INFINITY, "observed"],
        message: "second"
      },
      {
        sequenceNumber: 2,
        checkCode: "tie_a",
        expected: { scalar: false },
        observed: "bounded scalar",
        message: "first"
      },
      null,
      [],
      {
        sequenceNumber: 3,
        checkCode: "null_observed",
        observed: null
      },
      {
        sequenceNumber: 4,
        checkCode: "undefined_observed",
        observed: undefined
      },
      {
        sequenceNumber: 5,
        checkCode: "plain_observed",
        observed: { active: true, nested: { value: 9 } }
      }
    ]
  }));

  assert.deepEqual(report.checks.map(({ checkCode }) => checkCode), [
    "",
    "",
    "tie_a",
    "tie_b",
    "null_observed",
    "undefined_observed",
    "plain_observed"
  ]);
  const hostileCheck = report.checks.find(({ checkCode }) => checkCode === "tie_b");
  assert.deepEqual(hostileCheck.expected, {
    safeNumber: 42,
    notFinite: null,
    bigInteger: null,
    callable: null,
    symbol: null,
    array: [true, 3, null, "safe"],
    self: null
  });
  assert.deepEqual(hostileCheck.observed, [1, null, "observed"]);
  assert.equal(JSON.stringify(report).includes("attacker"), false);
  assert.equal(Object.isFrozen(hostileCheck.expected), true);
});

test("P2-F05 signoff and CSV fallbacks remain deterministic and formula-safe", () => {
  const report = buildPreflightReport(baseRun({
    current: true,
    signoff: {
      signoffId: 91,
      actor: "admin",
      note: "approved",
      signedAt: "2026-08-03T16:01:00.000Z",
      configurationHash: "c".repeat(64)
    },
    checks: [{
      sequenceNumber: 1,
      checkCode: "formula",
      mappingType: "custom_field",
      localKey: "formula",
      required: false,
      severity: "warning",
      status: "passed",
      expected: null,
      observed: false,
      message: "  +SUM(1,2)\n\"quoted\""
    }]
  }));

  assert.deepEqual(report.signoff, {
    status: "signed",
    signoffId: "91",
    actor: "admin",
    note: "approved",
    signedAt: "2026-08-03T16:01:00.000Z",
    configurationHash: "c".repeat(64)
  });
  const csv = serializePreflightCsv(report);
  assert.match(csv, /,signed,/);
  assert.match(csv, /"'  \+SUM\(1,2\)/);
  assert.match(csv, /""quoted""/);

  const defaultSigned = serializePreflightCsv({
    ...report,
    signoff: {},
    checks: report.checks
  });
  assert.match(defaultSigned, /,signed,/);
  const notSigned = serializePreflightCsv({
    ...report,
    signoff: "not-an-object",
    checks: report.checks
  });
  assert.match(notSigned, /,not_signed,/);
});
