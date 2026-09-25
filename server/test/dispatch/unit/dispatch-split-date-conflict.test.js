import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import fc from "fast-check";
import { assignment, fixtureHarness, planFor } from "../../support/dispatch-split-date-conflict-harness.mjs";

const source = process.env.SPLIT_DATE_MUTANT ? fs.readFileSync(process.env.SPLIT_DATE_MUTANT, "utf8") : undefined;
const harness = rows => fixtureHarness(rows, source);
const sibling = assignment("SOA08404", "split_parent_alias", { plannedOrderRef: "SOA08404-S1" });
const candidate = planFor("SOA08404-S2", { parent: "SOA08404" });
const conflict = { orderRef: "SOA08404-S2", planId: "322", planDate: "2026-09-10", status: "confirmed" };

test("failed Sep-17 draft: S1's Sep-10 parent alias does not reserve S2", async () => {
  assert.deepEqual(await harness([sibling]).newlyPlanned({ id: "329", orders: [], trucks: [] }, candidate), []);
});

test("a grouped sibling's parent alias does not reserve another grouped split", async () => {
  assert.deepEqual(await harness([{ ...sibling, plannedOrderRef: "GO-EXISTING" }]).conflicts(planFor("SOA08404-S2", { grouped: true })), []);
});

test("exact split assignments remain conflicts for direct and grouped cargo", async () => {
  for (const kind of ["direct", "group_member"]) {
    assert.deepEqual(await harness([assignment("SOA08404-S2", kind)]).conflicts(candidate), [conflict]);
  }
});

test("whole parent assignments remain conflicts including grouped and unknown kinds", async () => {
  for (const kind of ["direct", "group_member", "", "future_kind"]) {
    assert.deepEqual(await harness([assignment("SOA08404", kind)]).conflicts(candidate), [conflict]);
  }
});

test("planning the whole parent remains blocked by a child's alias", async () => {
  assert.deepEqual(await harness([sibling]).conflicts(planFor("SOA08404")), [{ ...conflict, orderRef: "SOA08404" }]);
});

test("only the actual conflicting plan is reported when another plan owns a sibling", async () => {
  const real = assignment("SOA08404-S2", "direct", { planId: "328", planDate: "2026-09-16" });
  assert.deepEqual(await harness([sibling, real]).conflicts(candidate), [{ ...conflict, planId: "328", planDate: "2026-09-16" }]);
});

test("unassigned snapshot orders and existing same-plan/date exclusions stay nonconflicting", async () => {
  assert.deepEqual(await harness([assignment("SOA08404-S2")]).conflicts({ ...candidate, trucks: [] }), []);
  assert.deepEqual(await harness([assignment("SOA08404-S2", "direct", { planId: "329" })]).conflicts(candidate), []);
  assert.deepEqual(await harness([assignment("SOA08404-S2", "direct", { planDate: "2026-09-17" })]).conflicts(candidate), []);
});

test("properties: independent splits stay independent and exact/whole-order work stays protected", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 99999 }), fc.constantFrom("SO", "TO"), fc.boolean(), fc.boolean(),
    async (id, type, grouped, lower) => {
      const parent = `${type}P${id}`;
      const ref = `${parent}-S2`;
      const normal = text => lower ? text.toLowerCase() : text;
      const plan = planFor(ref, { type, parent: normal(parent), grouped });
      const alias = assignment(normal(parent), "split_parent_alias", { plannedOrderRef: `${parent}-S1` });
      const independent = harness([alias, assignment("UNRELATED")]);
      assert.deepEqual(await independent.conflicts(plan), []);
      const direct = assignment(normal(ref));
      const exact = await harness([alias, direct]).conflicts(plan);
      assert.equal(exact.length, 1);
      assert.equal(exact[0].orderRef, ref);
      for (const kind of ["direct", "group_member", "unknown"]) {
        const whole = await harness([assignment(normal(parent), kind)]).conflicts(plan);
        assert.equal(whole.length, 1);
        assert.equal(whole[0].orderRef, ref);
      }
      assert.equal((await harness([alias]).conflicts(planFor(parent))).length, 1);
    }
  ), { seed: 20260916, numRuns: 150 });
});
