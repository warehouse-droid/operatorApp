// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import { dispatchPlanV2Summary } from "../../../src/dispatch-plan-repository.js";

const MIGRATED_AT = "2042-03-04T05:06:07.000Z";

test("V2 summary markers preserve arbitrary summary fields and are idempotent", () => {
  fc.assert(fc.property(
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 24 })
        .filter((key) => key !== "dispatchPlanFormat" && key !== "ownYardCodes"),
      fc.jsonValue()
    ),
    (summary) => {
      const marked = dispatchPlanV2Summary(summary, {
        source: "property-test",
        migratedAt: MIGRATED_AT,
        ownYardCodes: ["3445", "2967", "3445"]
      });
      assert.equal(marked.dispatchPlanFormat.version, 2);
      assert.equal(marked.dispatchPlanFormat.source, "property-test");
      assert.equal(marked.dispatchPlanFormat.migratedAt, MIGRATED_AT);
      assert.deepEqual(marked.ownYardCodes, ["3445", "2967"]);
      assert.deepEqual(
        JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(marked)
          .filter(([key]) => key !== "dispatchPlanFormat" && key !== "ownYardCodes")))),
        JSON.parse(JSON.stringify(summary))
      );

      const repeated = dispatchPlanV2Summary(marked, {
        source: "must-not-replace-existing-marker",
        migratedAt: "2099-01-01T00:00:00.000Z"
      });
      assert.deepEqual(repeated, marked);
    }
  ), { seed: 20260813, numRuns: 500 });
});
