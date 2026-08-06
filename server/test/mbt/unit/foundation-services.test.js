import assert from "node:assert/strict";
import test from "node:test";

import { toErrorEnvelope } from "../../../src/mbt/errors.js";
import { assertOutboxTransition, recoverExpiredLease } from "../../../src/mbt/outbox-state.js";
import {
  configurationHash,
  createPhaseOneNetSuiteAdapter,
  evaluatePreflightReadiness
} from "../../../src/mbt/preflight.js";
import { redactMbtValue } from "../../../src/mbt/redaction.js";
import { assertExpectedRevision, nextRevision } from "../../../src/mbt/revisions.js";

test("F03: revision commands accept the current integer revision and increment exactly once", () => {
  assert.equal(assertExpectedRevision(4, 4), 4);
  assert.equal(nextRevision(4), 5);
  assert.throws(() => nextRevision(0), /positive revision/i);
  assert.throws(() => nextRevision(4.5), /positive revision/i);
});

test("F03: stale and malformed expected revisions fail with stable public envelopes", () => {
  for (const [actual, expected, code, status] of [
    [5, 4, "MBT_STALE_REVISION", 409],
    [5, "5", "MBT_REVISION_REQUIRED", 400],
    [5, null, "MBT_REVISION_REQUIRED", 400]
  ]) {
    assert.throws(
      () => assertExpectedRevision(actual, expected),
      (error) => {
        assert.deepEqual(toErrorEnvelope(error, { correlationId: "corr-revision" }), {
          status,
          body: {
            error: code === "MBT_STALE_REVISION"
              ? "This MBT record changed. Refresh it before saving again."
              : "A positive integer expected revision is required.",
            code,
            details: {},
            correlationId: "corr-revision"
          }
        });
        assert.equal(error.status, status);
        return true;
      }
    );
  }
});

test("F03 hardening: missing or corrupted stored revisions never masquerade as a stale write", () => {
  for (const actual of [undefined, null, "4", 0, -1, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => assertExpectedRevision(actual, 4),
      (error) => error instanceof TypeError
        && error.message === "The stored revision must be a positive integer."
    );
  }
  assert.throws(
    () => assertExpectedRevision(undefined, undefined),
    (error) => error.code === "MBT_REVISION_REQUIRED" && error.status === 400,
    "caller input validation takes precedence over a missing stored row"
  );
});

test("F03 hardening: expected and next revisions reject unsafe numeric boundaries", () => {
  for (const expected of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, false]) {
    assert.throws(
      () => assertExpectedRevision(4, expected),
      (error) => error.code === "MBT_REVISION_REQUIRED" && error.status === 400
    );
  }
  for (const current of [undefined, null, "4", -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => nextRevision(current),
      (error) => error instanceof TypeError
        && error.message === "The current revision must be a positive revision integer."
    );
  }
  assert.equal(nextRevision(Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER);
  assert.throws(
    () => nextRevision(Number.MAX_SAFE_INTEGER),
    (error) => error instanceof RangeError
      && error.message === "The current revision exceeds the safe integer range."
  );
});

test("F05: audit redaction recursively removes secret keys, known values, and dangerous prototypes", () => {
  const input = {
    safe: "keep",
    password: "do-not-store", // secret-scan: allow redaction fixture
    nested: {
      access_token: "oauth-token", // secret-scan: allow redaction fixture
      note: "prefix configured-secret suffix",
      cardNumber: "4111111111111111",
      ordinary: 12
    },
    list: [{ clientSecret: "hidden" }, "configured-secret"] // secret-scan: allow redaction fixture
  };
  Object.defineProperty(input.nested, "__proto__", {
    value: { polluted: true },
    enumerable: true
  });

  const redacted = redactMbtValue(input, { secretValues: ["configured-secret"] });
  assert.deepEqual(redacted, {
    safe: "keep",
    password: "[REDACTED]",
    nested: {
      access_token: "[REDACTED]",
      note: "[REDACTED]",
      cardNumber: "[REDACTED]",
      ordinary: 12
    },
    list: [{ clientSecret: "[REDACTED]" }, "[REDACTED]"]
  });
  assert.equal({}.polluted, undefined);
  assert.equal(input.password, "do-not-store", "Redaction must not mutate the caller's evidence");
});

test("F13: readiness configuration hashes are canonical and ignore presentation order", () => {
  const left = [
    { mappingType: "subsidiary", localKey: "mbt", externalId: "33", revision: 2, active: true },
    { mappingType: "sales_order_form", localKey: "default", externalId: "81", revision: 1, active: true }
  ];
  const right = [
    { active: true, revision: 1, externalId: "81", localKey: "default", mappingType: "sales_order_form" },
    { active: true, externalId: "33", mappingType: "subsidiary", revision: 2, localKey: "mbt" }
  ];
  assert.match(configurationHash(left), /^[a-f0-9]{64}$/);
  assert.equal(configurationHash(left), configurationHash(right));
  assert.notEqual(configurationHash(left), configurationHash([{ ...left[0], revision: 3 }, left[1]]));
});

test("F13: readiness fails closed for missing, invalid, stale, or unverifiable checks", () => {
  const hash = "a".repeat(64);
  const required = ["subsidiary", "sales_order_form", "income_account"];
  const passingChecks = required.map((checkType) => ({ checkType, status: "passed", required: true }));

  assert.deepEqual(evaluatePreflightReadiness({
    currentConfigurationHash: hash,
    runConfigurationHash: hash,
    requiredChecks: required,
    checks: passingChecks
  }), { ready: true, reasons: [] });

  for (const scenario of [
    {
      input: { currentConfigurationHash: hash, runConfigurationHash: "b".repeat(64), requiredChecks: required, checks: passingChecks },
      reason: "configuration_changed"
    },
    {
      input: { currentConfigurationHash: hash, runConfigurationHash: hash, requiredChecks: required, checks: passingChecks.slice(0, 2) },
      reason: "missing:income_account"
    },
    {
      input: { currentConfigurationHash: hash, runConfigurationHash: hash, requiredChecks: required, checks: passingChecks.map((check) => check.checkType === "income_account" ? { ...check, status: "unable_to_verify" } : check) },
      reason: "unable_to_verify:income_account"
    }
  ]) {
    const result = evaluatePreflightReadiness(scenario.input);
    assert.equal(result.ready, false);
    assert.ok(result.reasons.includes(scenario.reason), JSON.stringify(result));
  }
});

test("F13/F15: the Phase 1 NetSuite adapter exposes reads and makes operational writes impossible", async () => {
  const readCalls = [];
  const adapter = createPhaseOneNetSuiteAdapter({
    async readRecord(type, id) {
      readCalls.push([type, id]);
      return { id, type };
    }
  });
  assert.deepEqual(await adapter.readRecord("subsidiary", "33"), { id: "33", type: "subsidiary" });
  assert.deepEqual(readCalls, [["subsidiary", "33"]]);
  for (const method of ["createSalesOrder", "createDeposit", "updateSalesOrder", "deleteRecord"]) {
    assert.equal(typeof adapter[method], "function");
    await assert.rejects(
      () => adapter[method]({}),
      (error) => error.code === "MBT_NETSUITE_WRITE_DISABLED" && error.status === 409
    );
  }
});

test("F12: expired pre-send leases retry, while post-send and uncertain leases require attention", () => {
  assert.deepEqual(recoverExpiredLease({ status: "leased", sentAt: null, externalAcknowledgedAt: null }), {
    status: "pending",
    attentionReason: null
  });
  assert.deepEqual(recoverExpiredLease({ status: "leased", sentAt: "2026-08-03T01:00:00.000Z", externalAcknowledgedAt: null }), {
    status: "attention",
    attentionReason: "external_outcome_uncertain"
  });
  assert.deepEqual(recoverExpiredLease({ status: "leased", sentAt: null, externalAcknowledgedAt: "2026-08-03T01:00:00.000Z" }), {
    status: "attention",
    attentionReason: "invalid_lease_evidence"
  });
});

test("F12: outbox state transitions reject delivery before external acknowledgement", () => {
  assert.equal(assertOutboxTransition("pending", "leased", {}), true);
  assert.equal(assertOutboxTransition("leased", "sent", { externalAcknowledgedAt: "2026-08-03T01:00:00.000Z" }), true);
  assert.throws(
    () => assertOutboxTransition("leased", "sent", {}),
    (error) => error.code === "MBT_OUTBOX_ACK_REQUIRED" && error.status === 409
  );
  assert.throws(
    () => assertOutboxTransition("pending", "sent", { externalAcknowledgedAt: "2026-08-03T01:00:00.000Z" }),
    (error) => error.code === "MBT_OUTBOX_INVALID_TRANSITION" && error.status === 409
  );
});
