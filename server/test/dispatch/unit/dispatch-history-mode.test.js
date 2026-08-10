import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchCompanyDate,
  historicalDispatchPlanDate
} from "../../../src/dispatch-history-mode.js";

test("history edit dates are strict past dates in the Dispatch company time zone", () => {
  const now = new Date("2026-08-10T03:30:00.000Z");
  assert.equal(dispatchCompanyDate(now), "2026-08-09");
  assert.equal(historicalDispatchPlanDate("2026-08-08", { today: "2026-08-09" }), "2026-08-08");
  assert.equal(historicalDispatchPlanDate("2026-08-09", { today: "2026-08-09" }), "");
  assert.equal(historicalDispatchPlanDate("2026-08-10", { today: "2026-08-09" }), "");
  assert.equal(historicalDispatchPlanDate("2026-02-30", { today: "2026-08-09" }), "");
  assert.equal(historicalDispatchPlanDate("not-a-date", { today: "2026-08-09" }), "");
});
