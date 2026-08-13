import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";

import { deriveMemoDeliveryInstruction } from "../../../src/delivery-instruction-domain.js";

test("unclassified memo lines are never lost around randomized planned fields", () => {
  fc.assert(fc.property(
    fc.array(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .#_-]{0,60}$/), { minLength: 1, maxLength: 20 }),
    (lines) => {
      const unique = [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
      fc.pre(unique.length > 0);
      const memo = [
        "Delivery Address: 10 Test Road, Toronto, ON M1M 1M1",
        ...unique,
        "Delivery Date: 2026-08-15"
      ].join("\n");
      const result = deriveMemoDeliveryInstruction(memo);
      for (const line of unique) {
        assert(result.text.includes(line), `lost memo line: ${line}`);
      }
    }
  ), { numRuns: 500 });
});
