import assert from "node:assert/strict";
import test from "node:test";

import {
  SPECIAL_STOCK_REQUEST_FLAG_KEY,
  assertSpecialStockRequestEnabled,
  getSpecialStockRequestPolicy,
  projectSpecialStockCase
} from "../../../src/special-stock-request-policy.js";

const detail = {
  id: 1,
  scmInternalNote: "header secret",
  lines: [{ id: 2, unitPurchaseCost: 12.5, scmInternalNote: "line secret", salesVisibleNote: "visible" }]
};

test("feature policy is a named fail-closed gate", () => {
  assert.equal(SPECIAL_STOCK_REQUEST_FLAG_KEY, "special_stock_request_workflow");
  assert.throws(() => assertSpecialStockRequestEnabled({ enabled: false }), (error) => error?.code === "SPECIAL_STOCK_DISABLED");
  assert.doesNotThrow(() => assertSpecialStockRequestEnabled({ enabled: true }));
});

test("feature policy materializes existing and missing rows without failing open", async () => {
  const updatedAt = new Date("2026-08-21T12:00:00.000Z");
  const enabled = await getSpecialStockRequestPolicy({
    queryFn: async (_sql, values) => {
      assert.deepEqual(values, [SPECIAL_STOCK_REQUEST_FLAG_KEY]);
      return { rows: [{ enabled: true, revision: "7", updated_at: updatedAt }] };
    }
  });
  assert.deepEqual(enabled, { enabled: true, revision: 7, updatedAt: updatedAt.toISOString() });
  assert.deepEqual(await getSpecialStockRequestPolicy({ queryFn: async () => ({ rows: [] }) }), {
    enabled: false, revision: null, updatedAt: null
  });
});

test("Sales and Dispatch projections cannot see SCM-only cost or internal notes", () => {
  for (const audience of ["sales", "dispatch"]) {
    const projected = projectSpecialStockCase(detail, audience);
    assert.equal(Object.hasOwn(projected, "scmInternalNote"), false);
    assert.equal(Object.hasOwn(projected.lines[0], "unitPurchaseCost"), false);
    assert.equal(Object.hasOwn(projected.lines[0], "scmInternalNote"), false);
    assert.equal(projected.lines[0].salesVisibleNote, "visible");
  }
  assert.equal(projectSpecialStockCase(detail, "scm").lines[0].unitPurchaseCost, 12.5);
  assert.equal(projectSpecialStockCase(detail, "admin").lines[0].unitPurchaseCost, 12.5);
  assert.equal(projectSpecialStockCase(null, "sales"), null);
  assert.deepEqual(projectSpecialStockCase({ id: 1, lines: null }, "sales").lines, []);
});
