import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalize,
  canonicalJson,
  canonicalSha256
} from "../../../src/mbt/canonical-json.js";
import { evaluateCapability } from "../../../src/mbt/capabilities.js";
import { MbtError, toErrorEnvelope } from "../../../src/mbt/errors.js";
import {
  compareCommandPayload,
  hashCommandPayload
} from "../../../src/mbt/idempotency.js";
import {
  selectRateBand,
  validateRateBands
} from "../../../src/mbt/rate-bands.js";

const VALID_BANDS = Object.freeze([
  Object.freeze({ id: "local", minimumMetres: 0, maximumMetres: 10_000 }),
  Object.freeze({ id: "regional", minimumMetres: 10_000, maximumMetres: 25_000 }),
  Object.freeze({ id: "extended", minimumMetres: 25_000, maximumMetres: null })
]);

test("F04 canonical JSON recursively sorts object keys, preserves array order, and does not mutate input", () => {
  const input = {
    z: [{ beta: true, alpha: null }, 3, 2, 1],
    a: { deep: { y: "last", x: "first" }, count: 2 }
  };
  const before = structuredClone(input);

  assert.deepEqual(canonicalize(input), {
    a: { count: 2, deep: { x: "first", y: "last" } },
    z: [{ alpha: null, beta: true }, 3, 2, 1]
  });
  assert.equal(
    canonicalJson(input),
    '{"a":{"count":2,"deep":{"x":"first","y":"last"}},"z":[{"alpha":null,"beta":true},3,2,1]}'
  );
  assert.deepEqual(input, before);
});

test("F04 canonical SHA-256 is lowercase, fixed-width, and based on canonical bytes", () => {
  assert.equal(
    canonicalSha256({ b: 2, a: 1 }),
    "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
  );
  assert.match(canonicalSha256(null), /^[0-9a-f]{64}$/);
});

test("F04 canonical JSON rejects values that cannot arrive in a JSON request", () => {
  const unsupported = [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, new Date(0)];

  for (const value of unsupported) {
    assert.throws(
      () => canonicalJson(value),
      (error) => error instanceof TypeError
        && error.message === "Canonical JSON accepts only JSON values."
    );
  }

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => canonicalJson(cyclic),
    (error) => error instanceof TypeError
      && error.message === "Canonical JSON accepts only JSON values."
  );
});

test("F01 capability evaluation fails closed at the global, database, and NetSuite-write gates", () => {
  assert.deepEqual(evaluateCapability({
    mbtEnabled: false,
    capabilityEnabled: true
  }), {
    enabled: false,
    code: "MBT_CAPABILITY_DISABLED",
    reason: "mbt_disabled"
  });

  assert.deepEqual(evaluateCapability({
    mbtEnabled: true,
    capabilityEnabled: false
  }), {
    enabled: false,
    code: "MBT_CAPABILITY_DISABLED",
    reason: "capability_disabled"
  });

  assert.deepEqual(evaluateCapability({
    mbtEnabled: true,
    capabilityEnabled: true,
    requiresNetSuiteWrite: true,
    netSuiteWritesEnabled: false
  }), {
    enabled: false,
    code: "MBT_CAPABILITY_DISABLED",
    reason: "netsuite_writes_disabled"
  });

  assert.deepEqual(evaluateCapability({
    mbtEnabled: true,
    capabilityEnabled: true,
    requiresNetSuiteWrite: false,
    netSuiteWritesEnabled: false
  }), {
    enabled: true,
    code: null,
    reason: null
  });

  assert.deepEqual(evaluateCapability({
    mbtEnabled: true,
    capabilityEnabled: true,
    requiresNetSuiteWrite: true,
    netSuiteWritesEnabled: true
  }), {
    enabled: true,
    code: null,
    reason: null
  });

  assert.equal(
    evaluateCapability({ mbtEnabled: "true", capabilityEnabled: true }).enabled,
    false,
    "only the normalized boolean true may open a capability"
  );
});

test("F01 capability denial precedence is deterministic and exposes no configuration value", () => {
  assert.deepEqual(evaluateCapability({
    mbtEnabled: false,
    capabilityEnabled: false,
    requiresNetSuiteWrite: true,
    netSuiteWritesEnabled: false
  }), {
    enabled: false,
    code: "MBT_CAPABILITY_DISABLED",
    reason: "mbt_disabled"
  });
});

test("F03/F04 typed MBT errors produce the exact public error envelope", () => {
  const error = new MbtError({
    status: 409,
    code: "MBT_STALE_REVISION",
    message: "This record changed. Reload and try again.",
    details: { expectedRevision: 4, actualRevision: 5 }
  });

  assert.deepEqual(toErrorEnvelope(error, { correlationId: "corr-p1-0001" }), {
    status: 409,
    body: {
      error: "This record changed. Reload and try again.",
      code: "MBT_STALE_REVISION",
      details: { expectedRevision: 4, actualRevision: 5 },
      correlationId: "corr-p1-0001"
    }
  });
});

test("F05 unexpected failures are redacted by the public error envelope", () => {
  const envelope = toErrorEnvelope(
    new Error("database failed with password=hunter2 and oauthToken=abc123"),
    { correlationId: "corr-p1-0002" }
  );

  assert.deepEqual(envelope, {
    status: 500,
    body: {
      error: "An unexpected error occurred.",
      code: "MBT_INTERNAL_ERROR",
      details: {},
      correlationId: "corr-p1-0002"
    }
  });
  assert.doesNotMatch(JSON.stringify(envelope), /hunter2|abc123|oauthToken|password/i);
});

test("F04 idempotency hashes canonical payloads and recognizes exact retries", () => {
  const storedHash = hashCommandPayload({ event: "reserve", slot: 1 });

  assert.equal(storedHash, "828f01826ef8b57a9653483b9e2b0ae4ecd2bfce3710bd826aa06bd4c889e656");
  assert.deepEqual(
    compareCommandPayload(storedHash, { slot: 1, event: "reserve" }),
    { outcome: "replay", payloadHash: storedHash }
  );
});

test("F04 reusing an idempotency key for a different payload raises the exact conflict", () => {
  const storedHash = hashCommandPayload({ event: "reserve", slot: 1 });

  assert.throws(
    () => compareCommandPayload(storedHash, { event: "reserve", slot: "1" }),
    (error) => error instanceof MbtError
      && error.status === 409
      && error.code === "MBT_IDEMPOTENCY_CONFLICT"
      && error.message === "Idempotency key was already used with a different payload."
      && error.details?.storedPayloadHash === storedHash
      && error.details?.candidatePayloadHash === hashCommandPayload({ event: "reserve", slot: "1" })
  );
});

test("F09 valid rate bands begin at zero, are contiguous, and end with one open band", () => {
  assert.deepEqual(validateRateBands(VALID_BANDS), { valid: true, issues: [] });
});

test("F09 rate validation reports stable issue codes and messages", () => {
  const cases = [
    {
      bands: [],
      code: "MBT_RATE_BANDS_EMPTY",
      message: "At least one rate band is required."
    },
    {
      bands: [{ id: "bad", minimumMetres: 1, maximumMetres: null }],
      code: "MBT_RATE_BAND_START",
      message: "The first rate band must begin at 0 metres."
    },
    {
      bands: [
        { id: "a", minimumMetres: 0, maximumMetres: 10 },
        { id: "b", minimumMetres: 11, maximumMetres: null }
      ],
      code: "MBT_RATE_BAND_GAP",
      message: "Rate bands must be contiguous; band 2 begins after band 1 ends."
    },
    {
      bands: [
        { id: "a", minimumMetres: 0, maximumMetres: 10 },
        { id: "b", minimumMetres: 9, maximumMetres: null }
      ],
      code: "MBT_RATE_BAND_OVERLAP",
      message: "Rate bands must not overlap; band 2 begins before band 1 ends."
    },
    {
      bands: [
        { id: "a", minimumMetres: 0, maximumMetres: null },
        { id: "b", minimumMetres: 10, maximumMetres: null }
      ],
      code: "MBT_RATE_BAND_OPEN_NOT_LAST",
      message: "Only the final rate band may have an open maximum."
    },
    {
      bands: [{ id: "closed", minimumMetres: 0, maximumMetres: 10 }],
      code: "MBT_RATE_BAND_FINAL_OPEN",
      message: "The final rate band must have an open maximum."
    },
    {
      bands: [{ id: "fraction", minimumMetres: 0, maximumMetres: 1.5 }],
      code: "MBT_RATE_BAND_METRES",
      message: "Rate band boundaries must be non-negative integer metres or a final null maximum."
    }
  ];

  for (const { bands, code, message } of cases) {
    const result = validateRateBands(bands);
    assert.equal(result.valid, false, code);
    assert.deepEqual(result.issues[0], { code, message });
  }
});

test("F09 exact raw-metre boundaries select [minimum, maximum) bands", () => {
  assert.equal(selectRateBand(VALID_BANDS, 0).id, "local");
  assert.equal(selectRateBand(VALID_BANDS, 9_999).id, "local");
  assert.equal(selectRateBand(VALID_BANDS, 10_000).id, "regional");
  assert.equal(selectRateBand(VALID_BANDS, 24_999).id, "regional");
  assert.equal(selectRateBand(VALID_BANDS, 25_000).id, "extended");
  assert.equal(selectRateBand(VALID_BANDS, 9_999_999).id, "extended");
});

test("2026 tariff boundaries keep the exact upper kilometre in the quoted band", () => {
  const quotedBands = [
    { id: "within-30", minimumMetres: 0, maximumMetres: 30_000, boundaryRule: "upper_inclusive" },
    { id: "over-30-to-50", minimumMetres: 30_000, maximumMetres: 50_000, boundaryRule: "upper_inclusive" },
    { id: "over-50-to-65", minimumMetres: 50_000, maximumMetres: 65_000, boundaryRule: "upper_inclusive" },
    { id: "over-65-to-75", minimumMetres: 65_000, maximumMetres: 75_000, boundaryRule: "upper_inclusive" },
    { id: "over-75", minimumMetres: 75_000, maximumMetres: null, boundaryRule: "upper_inclusive" }
  ];

  assert.equal(selectRateBand(quotedBands, 30_000).id, "within-30");
  assert.equal(selectRateBand(quotedBands, 30_001).id, "over-30-to-50");
  assert.equal(selectRateBand(quotedBands, 50_000).id, "over-30-to-50");
  assert.equal(selectRateBand(quotedBands, 50_001).id, "over-50-to-65");
  assert.equal(selectRateBand(quotedBands, 65_000).id, "over-50-to-65");
  assert.equal(selectRateBand(quotedBands, 65_001).id, "over-65-to-75");
  assert.equal(selectRateBand(quotedBands, 75_000).id, "over-65-to-75");
  assert.equal(selectRateBand(quotedBands, 75_001).id, "over-75");
});

test("F09 rate selection rejects rounded, negative, or otherwise invalid distances", () => {
  for (const distance of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "10000"]) {
    assert.throws(
      () => selectRateBand(VALID_BANDS, distance),
      (error) => error instanceof MbtError
        && error.status === 400
        && error.code === "MBT_RATE_DISTANCE_INVALID"
        && error.message === "Distance must be a non-negative integer number of metres."
    );
  }
});

test("F09 hardening: malformed boundaries report every applicable structural issue", () => {
  assert.deepEqual(validateRateBands(null), {
    valid: false,
    issues: [{
      code: "MBT_RATE_BANDS_EMPTY",
      message: "At least one rate band is required."
    }]
  });
  const cases = [
    {
      bands: [{ minimumMetres: 0, maximumMetres: 0 }],
      codes: ["MBT_RATE_BAND_RANGE", "MBT_RATE_BAND_FINAL_OPEN"]
    },
    {
      bands: [{ minimumMetres: 5, maximumMetres: 4 }],
      codes: ["MBT_RATE_BAND_RANGE", "MBT_RATE_BAND_START", "MBT_RATE_BAND_FINAL_OPEN"]
    },
    {
      bands: [{ minimumMetres: -1, maximumMetres: null }],
      codes: ["MBT_RATE_BAND_METRES", "MBT_RATE_BAND_START"]
    },
    {
      bands: [{ minimumMetres: 0, maximumMetres: -1 }],
      codes: ["MBT_RATE_BAND_METRES", "MBT_RATE_BAND_FINAL_OPEN"]
    },
    {
      bands: [{ minimumMetres: "0", maximumMetres: null }],
      codes: ["MBT_RATE_BAND_METRES", "MBT_RATE_BAND_START"]
    },
    {
      bands: [null],
      codes: ["MBT_RATE_BAND_METRES", "MBT_RATE_BAND_START", "MBT_RATE_BAND_FINAL_OPEN"]
    },
    {
      bands: [
        { minimumMetres: 0, maximumMetres: "10" },
        { minimumMetres: 10, maximumMetres: null }
      ],
      codes: ["MBT_RATE_BAND_METRES"]
    },
    {
      bands: [
        { minimumMetres: 0, maximumMetres: 10 },
        { minimumMetres: "10", maximumMetres: null }
      ],
      codes: ["MBT_RATE_BAND_METRES"]
    },
    {
      bands: [
        { minimumMetres: 0, maximumMetres: 10 },
        null,
        { minimumMetres: 10, maximumMetres: null }
      ],
      codes: ["MBT_RATE_BAND_METRES"]
    }
  ];
  for (const { bands, codes } of cases) {
    const result = validateRateBands(bands);
    assert.equal(result.valid, false, JSON.stringify(bands));
    assert.deepEqual(result.issues.map(({ code }) => code), codes, JSON.stringify(result));
  }
});

test("F09 hardening: invalid band sets fail selection with their structured evidence", () => {
  assert.throws(
    () => selectRateBand([{ minimumMetres: 0, maximumMetres: 0 }], 0),
    (error) => error instanceof MbtError
      && error.status === 400
      && error.code === "MBT_RATE_BANDS_INVALID"
      && error.details?.issues?.some(({ code }) => code === "MBT_RATE_BAND_RANGE")
  );
  const singleOpenBand = [{ id: "all-distance", minimumMetres: 0, maximumMetres: null }];
  assert.equal(selectRateBand(singleOpenBand, Number.MAX_SAFE_INTEGER).id, "all-distance");
});
