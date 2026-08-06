import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import {
  canonicalJson,
  canonicalSha256
} from "../../../src/mbt/canonical-json.js";
import {
  selectRateBand,
  validateRateBands
} from "../../../src/mbt/rate-bands.js";

const NUM_RUNS = 1_000;
const SEED = 2_026_080_301;

function buildBands(widths) {
  let minimumMetres = 0;
  return widths.map((width, index) => {
    const maximumMetres = index === widths.length - 1
      ? null
      : minimumMetres + width;
    const band = {
      id: `band-${index}`,
      minimumMetres,
      maximumMetres
    };
    minimumMetres += width;
    return band;
  });
}

test("F04 property: canonical JSON and hash ignore every object-key insertion order", () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.tuple(fc.string(), fc.jsonValue()), {
      minLength: 1,
      maxLength: 20,
      selector: ([key]) => key
    }),
    fc.integer(),
    (entries, salt) => {
      const rotatedBy = Math.abs(salt) % entries.length;
      const rotated = entries.slice(rotatedBy).concat(entries.slice(0, rotatedBy));
      const forward = Object.fromEntries(entries);
      const reordered = Object.fromEntries(rotated.reverse());

      assert.equal(canonicalJson(forward), canonicalJson(reordered));
      assert.equal(canonicalSha256(forward), canonicalSha256(reordered));
    }
  ), { numRuns: NUM_RUNS, seed: SEED });
});

test("F04 property: canonical JSON is stable after a JSON round trip", () => {
  fc.assert(fc.property(fc.jsonValue(), (value) => {
    const encoded = canonicalJson(value);
    assert.equal(canonicalJson(JSON.parse(encoded)), encoded);
  }), { numRuns: NUM_RUNS, seed: SEED + 1 });
});

test("F04 property: changing a JSON scalar type changes its idempotency hash", () => {
  fc.assert(fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (value) => {
    assert.notEqual(
      canonicalSha256({ value }),
      canonicalSha256({ value: String(value) })
    );
  }), { numRuns: NUM_RUNS, seed: SEED + 2 });
});

test("F09 property: generated contiguous bands validate for at least 1,000 cases", () => {
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 12 }),
    (widths) => {
      assert.deepEqual(validateRateBands(buildBands(widths)), { valid: true, issues: [] });
    }
  ), { numRuns: NUM_RUNS, seed: SEED + 3 });
});

test("F09 property: every exact finite boundary obeys [minimum, maximum)", () => {
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 2, maxLength: 12 }),
    (widths) => {
      const bands = buildBands(widths);

      for (let index = 0; index < bands.length - 1; index += 1) {
        const band = bands[index];
        const next = bands[index + 1];
        assert.equal(selectRateBand(bands, band.minimumMetres).id, band.id);
        assert.equal(selectRateBand(bands, band.maximumMetres - 1).id, band.id);
        assert.equal(selectRateBand(bands, band.maximumMetres).id, next.id);
      }
    }
  ), { numRuns: NUM_RUNS, seed: SEED + 4 });
});
