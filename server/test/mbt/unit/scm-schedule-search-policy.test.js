import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { canSearchAcrossScmScheduleOrders, filterSearchableScmScheduleOrders } from "../../../src/scm-order-visibility.js";

test("the broad search policy requires a nonblank term, authorized role and supported surface", () => {
  assert.equal(canSearchAcrossScmScheduleOrders(), false);
  for (const search of ["", " ", "\t\n", null]) {
    for (const role of ["dispatcher", "sales", "admin", "scm"]) {
      assert.equal(canSearchAcrossScmScheduleOrders({ role }, { search, surface: "dispatch" }), false);
    }
  }
  const cases = [
    [{ role: "SALES" }, "sales", true], [{ role: "sales" }, "dispatch", false],
    [{ role: "admin" }, "sales", true], [{ role: "admin" }, "dispatch", true],
    [{ role: "scm-staff" }, "dispatch", true], [{ role: "scm" }, "scm", false],
    [{ role: "dispatcher" }, "scm", true], [{ role: "operator", roles: ["Dispatcher"] }, "dispatch", true],
    [{ role: "yard_manager" }, "dispatch", false], [null, "sales", false], [{}, "dispatch", false]
  ];
  for (const [operator, surface, expected] of cases) {
    assert.equal(canSearchAcrossScmScheduleOrders(operator, { search: "PO123", surface }), expected);
  }
});

test("final-response filtering excludes Hold from calculated, reconciliation, nested and intake statuses", () => {
  const held = [
    { status: " Hold " }, { status: "Queued", calculatedStatus: "HOLD" },
    { status: "Queued", calculated_status: "Hold" },
    { reconciliationApplicationStatus: "Hold" }, { scm: { status: "Hold" } },
    { initialScmStatus: "Hold" }, { initial_scm_status: "Hold" }
  ];
  assert.deepEqual(filterSearchableScmScheduleOrders(held), []);
  const visible = [{ status: "Completed" }, { status: "Cancelled" }, { status: "Queued", isBlanket: true },
    { status: "Queued", initialScmStatus: "Hold" }];
  assert.deepEqual(filterSearchableScmScheduleOrders(visible), visible);
  assert.deepEqual(filterSearchableScmScheduleOrders(), []);
  assert.deepEqual(filterSearchableScmScheduleOrders(null), []);
});

test("property: normalized multi-role authorization agrees with the explicit role/surface matrix", () => {
  const roles = ["sales", "dispatcher", "admin", "scm", "scm_staff", "yard_manager", "operator"];
  fc.assert(fc.property(fc.array(fc.constantFrom(...roles), { maxLength: 5 }),
    fc.constantFrom("sales", "dispatch", "scm"), fc.boolean(), (granted, surface, nonblank) => {
      const operator = { role: "operator", roles: granted.map((role) => role.toUpperCase().replaceAll("_", " ")) };
      const expected = nonblank && (granted.includes("dispatcher")
        || (surface === "sales" && granted.some((role) => ["sales", "admin"].includes(role)))
        || (surface === "dispatch" && granted.some((role) => ["admin", "scm", "scm_staff"].includes(role))));
      assert.equal(canSearchAcrossScmScheduleOrders(operator, { search: nonblank ? " PO123 " : " \t ", surface }), expected);
    }), { numRuns: 200, seed: 20261014 });
});
