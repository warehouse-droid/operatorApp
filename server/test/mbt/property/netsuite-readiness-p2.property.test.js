import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import {
  createReadOnlyNetSuiteAdapter,
  projectObservedNetSuiteRecord
} from "../../../src/mbt/netsuite-readonly-adapter.js";
import {
  buildPreflightReport,
  serializePreflightCsv,
  serializePreflightJson
} from "../../../src/mbt/netsuite-readiness-report.js";
import { configurationHash } from "../../../src/mbt/preflight.js";

const NUM_RUNS = 1_000;
const SEED = 2_026_080_302;
const SANDBOX_ENVIRONMENT = Object.freeze({
  directAccessEnabled: true,
  configuredAccountId: "1234567_SB1",
  runtimeAccountId: "1234567_SB1",
  sandboxAccountAllowlist: Object.freeze(["1234567_SB1"]),
  restBaseUrl: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1"
});

const safePathSegment = fc.string({ minLength: 1, maxLength: 80 });
const safeJsonObject = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 20 }),
  fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
  { maxKeys: 10 }
);

function permutation(values, salt) {
  if (values.length < 2) {
    return [...values];
  }
  const offset = Math.abs(salt) % values.length;
  return values.slice(offset).concat(values.slice(0, offset)).reverse();
}

function reportWithMessages(messages) {
  return {
    runId: "a1111111-2222-4333-8444-555555555555",
    accountId: "1234567_SB1",
    environmentName: "sandbox",
    configurationHash: "b".repeat(64),
    status: "failed",
    generatedAt: "2026-08-03T12:34:56.000Z",
    current: false,
    signoff: null,
    checks: messages.map((message, index) => ({
      sequenceNumber: index + 1,
      checkCode: `check_${String(index + 1).padStart(3, "0")}`,
      mappingType: "sales_order_item",
      localKey: `item_${String(index + 1).padStart(3, "0")}`,
      required: true,
      severity: "error",
      status: "unable_to_verify",
      expected: { active: true },
      observed: projectObservedNetSuiteRecord("serviceItem", {
        id: index + 1,
        name: message,
        isInactive: false
      }),
      message
    }))
  };
}

test("P2-F01 property: every hostile record identifier remains one encoded GET path segment", async () => {
  await fc.assert(fc.asyncProperty(safePathSegment, async (internalId) => {
    const calls = [];
    const adapter = createReadOnlyNetSuiteAdapter({
      environment: SANDBOX_ENVIRONMENT,
      async transport(url, init) {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          redirected: false,
          async json() {
            return { id: internalId, name: "Observed", isInactive: false };
          }
        };
      }
    });

    await adapter.readRecord("customer", internalId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(calls[0].url, `${SANDBOX_ENVIRONMENT.restBaseUrl}/customer/${encodeURIComponent(internalId)}`);
    const parsed = new URL(calls[0].url);
    assert.equal(parsed.origin, "https://1234567-sb1.suitetalk.api.netsuite.com");
    assert.equal(parsed.pathname.startsWith("/services/rest/record/v1/customer/"), true);
  }), { numRuns: NUM_RUNS, seed: SEED });
});

test("P2-F01 property: arbitrary unrestricted remote fields never survive observed projection", () => {
  fc.assert(fc.property(safeJsonObject, (untrusted) => {
    const projected = projectObservedNetSuiteRecord("customer", {
      id: "33",
      name: "Customer 33",
      isInactive: false,
      unrestricted: untrusted,
      rawPayload: untrusted,
      accessToken: JSON.stringify(untrusted)
    });
    const serialized = JSON.stringify(projected);
    assert.deepEqual(Object.keys(projected), ["recordType", "id", "name", "active"]);
    assert.doesNotMatch(serialized, /unrestricted|rawPayload|accessToken/);
  }), { numRuns: NUM_RUNS, seed: SEED + 1 });
});

test("P2-F01 property: nested item subsidiary references project only sorted unique scalar IDs", () => {
  const referenceId = fc.oneof(
    fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    fc.stringMatching(/^[A-Za-z0-9]{1,20}$/),
    fc.constant(null)
  );
  fc.assert(fc.property(
    fc.array(fc.record({
      id: referenceId,
      refName: fc.string({ maxLength: 40 }),
      links: safeJsonObject
    }), { maxLength: 40 }),
    (references) => {
      const projected = projectObservedNetSuiteRecord("serviceSaleItem", {
        id: "88",
        subsidiary: { items: references, rawPayload: references }
      });
      const expectedIds = [...new Set(references
        .map(({ id }) => id === null ? null : String(id))
        .filter((id) => id !== null))].sort();
      assert.deepEqual(projected.subsidiaryIds, expectedIds);
      assert.doesNotMatch(JSON.stringify(projected), /\[object Object\]|rawPayload|links/);
    }
  ), { numRuns: NUM_RUNS, seed: SEED + 6 });
});

test("P2-F04 property: canonical configuration hashes ignore all mapping and key permutations", () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.record({
      mappingType: fc.constantFrom("subsidiary", "sales_order_item", "custom_field"),
      localKey: fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/),
      externalId: fc.string({ minLength: 1, maxLength: 20 }),
      revision: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
      cents: fc.integer({ min: 0, max: 10_000_000 })
    }), {
      minLength: 1,
      maxLength: 20,
      selector: ({ mappingType, localKey }) => `${mappingType}\u0000${localKey}`
    }),
    fc.integer(),
    (values, salt) => {
      const forward = values.map((value) => ({
        mappingType: value.mappingType,
        localKey: value.localKey,
        externalId: value.externalId,
        revision: value.revision,
        configuration: { amountCents: value.cents, enabled: true }
      }));
      const reordered = permutation(values, salt).map((value) => ({
        configuration: { enabled: true, amountCents: value.cents },
        revision: value.revision,
        externalId: value.externalId,
        localKey: value.localKey,
        mappingType: value.mappingType
      }));
      assert.equal(configurationHash(forward), configurationHash(reordered));
    }
  ), { numRuns: NUM_RUNS, seed: SEED + 2 });
});

test("P2-F05 property: JSON and CSV exports are deterministic for every input check permutation", () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.string({ maxLength: 120 }), { minLength: 1, maxLength: 20 }),
    fc.integer(),
    (messages, salt) => {
      const forward = reportWithMessages(messages);
      const reordered = { ...forward, checks: permutation(forward.checks, salt) };
      const left = buildPreflightReport(forward);
      const right = buildPreflightReport(reordered);
      assert.deepEqual(left, right);
      assert.equal(serializePreflightJson(left), serializePreflightJson(right));
      assert.equal(serializePreflightCsv(left), serializePreflightCsv(right));
    }
  ), { numRuns: NUM_RUNS, seed: SEED + 3 });
});

test("P2-F05 property: every leading spreadsheet formula character is neutralized in CSV", () => {
  fc.assert(fc.property(
    fc.constantFrom("", " ", "   ", "\t", "\r", "\n", "\u0000", " \t"),
    fc.constantFrom("=", "+", "-", "@"),
    fc.string({ maxLength: 120 }),
    (leading, prefix, suffix) => {
      const dangerous = `${leading}${prefix}${suffix}`;
      const csv = serializePreflightCsv(buildPreflightReport(reportWithMessages([dangerous])));
      assert.equal(csv.includes(`'${dangerous.replaceAll('"', '""')}`), true);
      assert.equal(csv.includes(`,${dangerous},`), false);
    }
  ), { numRuns: NUM_RUNS, seed: SEED + 4 });
});

test("P2-F05 property: JSON export round-trips arbitrary hostile Unicode without literal HTML delimiters", () => {
  fc.assert(fc.property(fc.string({ maxLength: 300 }), (message) => {
    const report = buildPreflightReport(reportWithMessages([message]));
    const serialized = serializePreflightJson(report);
    assert.deepEqual(JSON.parse(serialized), report);
    assert.doesNotMatch(serialized, /[<>&\u2028\u2029]/u);
  }), { numRuns: NUM_RUNS, seed: SEED + 5 });
});
