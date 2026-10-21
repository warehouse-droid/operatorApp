import assert from "node:assert/strict";
import test from "node:test";
import { assertPlanningAccess, planningDate, planningText, assertPlanningSchedule } from "../../../src/mbt/bin-planning-repository.js";
test("date, role and whole-day validation reject missing or malformed planning data", () => {
  for (const value of [undefined, "", "not-a-date", "2025-02-29", "2026-13-01"]) {
    assert.throws(() => planningDate(value), e => e.status === 400);
  }
  assert.equal(planningDate("2024-02-29"), "2024-02-29");
  assert.equal(planningText(123, "ID"), "123");
  assert.throws(() => planningText(null, "ID"), e => e.status === 400);
  for (const boundary of [undefined, {}, { capability: {} }]) {
    assert.throws(() => assertPlanningAccess({}, boundary), e => e.status === 409);
  }
  const boundary = { capability: { environmentEnabled: true, databaseEnabled: true, pilotAuthorized: true } };
  for (const actor of [undefined, {}, { operatorId: "one" }, { operatorId: "one", roles: ["driver"] }]) {
    assert.throws(() => assertPlanningAccess({ actor }, boundary, true), e => e.status === 403);
  }
  assert.doesNotThrow(() => assertPlanningAccess({ actor: { operatorId: "one", roles: ["admin"] } }, boundary, true));
  assert.throws(() => assertPlanningSchedule({ trucks: [{ id: "1", loads: [{ id: "one", stops: [{ type: "BIN", mbt: { visitId: "v" } }] }] }] }),
    e => e.code === "MBT_BIN_LOAD_TIME_REQUIRED");
});
