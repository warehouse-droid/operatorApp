import assert from "node:assert/strict";
import crypto from "node:crypto";
import { access } from "node:fs/promises";
import test from "node:test";

import fc from "fast-check";

const NUM_RUNS = 1_000;
const RECONCILE_RUNS = 500;
const SEED = 2_026_080_303;
const BASE_TIME = Date.parse("2026-08-03T00:00:00.000Z");

async function optionalModule(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  try {
    await access(url);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({});
    }
    throw error;
  }
  return import(url.href);
}

const rulesModule = await optionalModule("../../../src/mbt/customer-source-rules.js");

function requiredFunction(module, name) {
  assert.equal(
    typeof module[name],
    "function",
    `P3.3 requires the production export ${name}; this is the intended RED boundary.`
  );
  return module[name];
}

function digest(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function cursorValue(second, internalId) {
  return {
    modifiedAt: new Date(BASE_TIME + (second * 1_000)).toISOString(),
    internalId
  };
}

function referenceCompare(left, right) {
  const modifiedDifference = Date.parse(left.modifiedAt) - Date.parse(right.modifiedAt);
  if (modifiedDifference !== 0) {
    return modifiedDifference;
  }
  return left.internalId - right.internalId;
}

function observation({
  netsuiteId,
  sourceKind,
  modifiedSecond,
  payloadMarker,
  version = `v-${modifiedSecond}`
}) {
  return {
    netsuiteId,
    sourceKind,
    sourceModifiedAt: new Date(BASE_TIME + (modifiedSecond * 1_000)).toISOString(),
    sourceVersion: version,
    payloadHash: digest(payloadMarker),
    displayName: `Synthetic ${payloadMarker}`
  };
}

test("P3-F01 property: tuple cursors never lose or duplicate equal-timestamp customer IDs", () => {
  const compareCustomerCursor = requiredFunction(rulesModule, "compareCustomerCursor");
  const customerIsAfterCursor = requiredFunction(rulesModule, "customerIsAfterCursor");
  fc.assert(fc.property(
    fc.uniqueArray(fc.record({
      modifiedSecond: fc.integer({ min: 0, max: 8 }),
      internalId: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER })
    }), {
      minLength: 1,
      maxLength: 100,
      selector: ({ modifiedSecond, internalId }) => `${modifiedSecond}:${internalId}`
    }),
    fc.integer({ min: 1, max: 17 }),
    (generated, pageSize) => {
      const values = generated.map(({ modifiedSecond, internalId }) => (
        cursorValue(modifiedSecond, internalId)
      ));
      const expected = [...values].sort(referenceCompare);
      const ordered = [...values].sort(compareCustomerCursor);
      assert.deepEqual(ordered, expected);

      const visited = [];
      let current = null;
      while (visited.length < expected.length) {
        const page = values
          .filter((candidate) => current === null || customerIsAfterCursor(candidate, current))
          .sort(compareCustomerCursor)
          .slice(0, pageSize);
        assert.ok(page.length > 0, "A valid tuple cursor must make forward progress.");
        visited.push(...page);
        current = page[page.length - 1];
      }
      assert.deepEqual(visited, expected);
      assert.equal(new Set(visited.map(({ modifiedAt, internalId }) => (
        `${modifiedAt}:${internalId}`
      ))).size, expected.length);
      assert.deepEqual(
        values.map((candidate) => customerIsAfterCursor(candidate, current)),
        values.map(() => false)
      );
    }
  ), { numRuns: NUM_RUNS, seed: SEED });
});

test("P3-F02 property: every source/version precedence law preserves authoritative data", () => {
  const decideCustomerObservation = requiredFunction(
    rulesModule,
    "decideCustomerObservation"
  );
  fc.assert(fc.property(
    fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    fc.integer({ min: 2, max: 1_000_000 }),
    fc.string({ minLength: 1, maxLength: 80 }),
    fc.string({ minLength: 1, maxLength: 80 }).filter((value) => value !== "same"),
    (netsuiteId, newerSecond, currentMarker, differentMarker) => {
      const currentCsv = observation({
        netsuiteId,
        sourceKind: "csv_bootstrap",
        modifiedSecond: newerSecond - 1,
        payloadMarker: currentMarker,
        version: `csv-${newerSecond - 1}`
      });
      const olderCsv = observation({
        netsuiteId,
        sourceKind: "csv_bootstrap",
        modifiedSecond: newerSecond - 2,
        payloadMarker: differentMarker,
        version: `csv-${newerSecond - 2}`
      });
      const newerCsv = observation({
        netsuiteId,
        sourceKind: "csv_bootstrap",
        modifiedSecond: newerSecond,
        payloadMarker: differentMarker,
        version: `csv-${newerSecond}`
      });
      const equalSame = { ...currentCsv };
      const equalDifferent = {
        ...currentCsv,
        payloadHash: digest(`${differentMarker}-equal`),
        displayName: `Synthetic ${differentMarker}-equal`
      };
      assert.equal(decideCustomerObservation(currentCsv, olderCsv).action, "ignore");
      assert.equal(decideCustomerObservation(currentCsv, newerCsv).action, "apply");
      assert.equal(decideCustomerObservation(currentCsv, equalSame).action, "unchanged");
      assert.equal(decideCustomerObservation(currentCsv, equalDifferent).action, "conflict");

      const live = observation({
        netsuiteId,
        sourceKind: "netsuite_read",
        modifiedSecond: 0,
        payloadMarker: differentMarker,
        version: "live-observation"
      });
      assert.equal(
        decideCustomerObservation(currentCsv, live).action,
        "apply",
        "A first live observation supersedes a CSV row even with an older source clock."
      );
      const lateDifferentCsv = observation({
        netsuiteId,
        sourceKind: "csv_bootstrap",
        modifiedSecond: newerSecond + 1,
        payloadMarker: `${differentMarker}-late`,
        version: `csv-${newerSecond + 1}`
      });
      const lateIdenticalCsv = { ...lateDifferentCsv, payloadHash: live.payloadHash };
      assert.equal(decideCustomerObservation(live, lateDifferentCsv).action, "conflict");
      assert.equal(decideCustomerObservation(live, lateIdenticalCsv).action, "unchanged");
    }
  ), { numRuns: NUM_RUNS, seed: SEED + 1 });
});

test("P3-F02 property: canonical reconciliation is permutation-invariant and keyed only by internal ID", () => {
  const reconcileCustomerObservations = requiredFunction(
    rulesModule,
    "reconcileCustomerObservations"
  );
  fc.assert(fc.property(
    fc.uniqueArray(fc.record({
      netsuiteId: fc.integer({ min: 1, max: 100_000 }),
      versionRank: fc.integer({ min: 1, max: 100_000 }),
      nameSalt: fc.string({ maxLength: 40 })
    }), {
      minLength: 1,
      maxLength: 80,
      selector: ({ netsuiteId, versionRank }) => `${netsuiteId}:${versionRank}`
    }),
    fc.integer(),
    (rows, salt) => {
      const inputs = rows.map(({ netsuiteId, versionRank, nameSalt }) => observation({
        netsuiteId,
        sourceKind: "csv_bootstrap",
        modifiedSecond: versionRank,
        payloadMarker: `${netsuiteId}:${versionRank}:${nameSalt}`,
        version: `csv-${versionRank}`
      }));
      const offset = Math.abs(salt) % inputs.length;
      const permuted = inputs.slice(offset).concat(inputs.slice(0, offset)).reverse();
      const forward = reconcileCustomerObservations([], inputs);
      const reordered = reconcileCustomerObservations([], permuted);
      assert.deepEqual(forward, reordered);
      assert.deepEqual(forward.conflicts, []);

      const expectedById = new Map();
      for (const input of inputs) {
        const previous = expectedById.get(input.netsuiteId);
        if (!previous || Date.parse(input.sourceModifiedAt) > Date.parse(previous.sourceModifiedAt)) {
          expectedById.set(input.netsuiteId, input);
        }
      }
      assert.deepEqual(
        forward.customers.map(({ netsuiteId, sourceVersion, payloadHash }) => ({
          netsuiteId,
          sourceVersion,
          payloadHash
        })),
        [...expectedById.values()]
          .sort((left, right) => left.netsuiteId - right.netsuiteId)
          .map(({ netsuiteId, sourceVersion, payloadHash }) => ({
            netsuiteId,
            sourceVersion,
            payloadHash
          }))
      );
      assert.equal(
        new Set(forward.customers.map(({ netsuiteId }) => netsuiteId)).size,
        forward.customers.length,
        "Display-name changes must never create a second customer identity."
      );
    }
  ), { numRuns: RECONCILE_RUNS, seed: SEED + 2 });
});
