import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {loadUpload} from "../../support/driver-upload-fixtures.mjs";

test("measured progress remains bounded and follows byte weights", () => {
  fc.assert(fc.property(
    fc.array(fc.integer({min: 1, max: 2 * 1024 * 1024}), {minLength: 1, maxLength: 8}),
    fc.integer({min: -200, max: 300}),
    (sizes, percentage) => {
      const progress = loadUpload().batchProgress(sizes.map(byteSize => ({byteSize})));
      const expected = Math.max(0, Math.min(100, percentage));
      let transferred = 0n;
      for (let index = 0; index < sizes.length; index += 1) {
        transferred += BigInt(sizes[index]) * BigInt(expected);
        const actual = progress(index, {phase: "uploading", percentage});
        assert.equal(actual.percentage, expected);
        assert.equal(actual.overallPercentage, Number(transferred / sizes.reduce((sum, size) => sum + BigInt(size), 0n)));
        assert.ok(actual.overallPercentage >= 0 && actual.overallPercentage <= 100);
      }
    }
  ), {seed: 20261013, numRuns: 500});
});

test("ordered measured progress cannot regress while the same photo transfers", () => {
  fc.assert(fc.property(fc.array(fc.integer({min: 0, max: 100}), {minLength: 1, maxLength: 100}), percentages => {
    const progress = loadUpload().batchProgress([{byteSize: 100}]);
    let previous = 0;
    for (const percentage of percentages.sort((left, right) => left - right)) {
      const actual = progress(0, {phase: "uploading", percentage});
      assert.ok(actual.overallPercentage >= previous);
      previous = actual.overallPercentage;
    }
  }), {seed: 20261013, numRuns: 200});
});
