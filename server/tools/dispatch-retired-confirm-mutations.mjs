import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";

assert.equal(process.env.MBT_MUTATION_EPHEMERAL, "1", "Mutations must run only in a disposable copied image");
const front = "test/dispatch/frontend/dispatch-retired-confirm.test.js";
const integration = "test/dispatch/integration/dispatch-retired-confirm.test.js";
const repair = "test/dispatch/integration/dispatch-retired-confirm-repair.test.js";
const timing = "test/dispatch/integration/dispatch-retired-confirm-timing.test.js";
const recordedPo = "test/dispatch/integration/dispatch-recorded-po-load.test.js";
const mutants = [
  { name: "travel freezes unstarted PO", file: "src/dispatch-recorded-po-projection.js", test: recordedPo, property: true,
    from: 'if (!["pick", "pickup", "drop", "dropoff"].includes(key(record.stop_type || record.stopType))) continue;', to: 'if (false) continue;' },
  { name: "queued jobs freeze PO", file: "src/dispatch-recorded-po-projection.js", test: recordedPo, property: true,
    from: 'if (!["in_progress", "complete"].includes(key(record.status))) continue;', to: 'if (false) continue;' },
  { name: "fresh residual survives recorded absence", file: "src/dispatch-recorded-po-projection.js", test: recordedPo, property: true,
    from: 'delete frozen.poRouteProjection;', to: 'void frozen.poRouteProjection;' },
  { name: "published residual not restored", file: "src/dispatch-recorded-po-projection.js", test: recordedPo, property: true,
    from: 'if (published !== undefined)', to: 'if (false)' },
  { name: "legacy stale projection survives", file: "src/dispatch-recorded-po-projection.js", test: recordedPo, property: true,
    from: 'delete frozen.po_route_projection;', to: 'void frozen.po_route_projection;' },
  { name: "physical SO treated as PO", file: "src/dispatch-recorded-po-projection.js", test: recordedPo, property: false,
    from: 'key(order.type) === "po" && startedRefs.has(key(order.id))', to: 'startedRefs.has(key(order.id))' },
  { name: "residual writer overwrites recorded PO", file: "src/scm-dependency-plan-reconciler.js", test: recordedPo, property: true,
    from: 'if (preservedPoOrderRefs.has(text(order.id).toLowerCase())) {return false;}', to: 'if (false) {return false;}' },
  { name: "executed drop edit accepted", file: "src/dispatch-executed-prefix-repository.js", test: recordedPo, property: false,
    from: 'if (!policy.allowed) throw dispatchExecutedPrefixConflictError(policy);', to: 'if (false) throw dispatchExecutedPrefixConflictError(policy);' },
  { name: "projection refresh erases executed schedule", file: "src/dispatch-plan-repository.js", test: timing, property: true,
    from: "return overlayLockedLoadDerivedSchedule(plan, reconciled, new Set(), { activityStatuses: activity.rows });",
    to: "return reconciled;" },
  { name: "canonical feed bypasses lifecycle authority", file: "src/server.js", test: integration, property: true,
    from: 'mergedPlanningOrders.filter((order) => visibleOrderRefs.has(String(order?.id || "").trim().toLowerCase()))',
    to: "mergedPlanningOrders" },
  { name: "global ownership metadata omitted", file: "src/server.js", test: integration, property: true,
    from: '"globalOrderDefinition", "globalOrderDefinitionKind", "globalOrderSourcePlanId",',
    to: '"ignoredGlobalDefinition", "globalOrderDefinitionKind", "globalOrderSourcePlanId",' },
  { name: "canonical pool records adopted by current plan", file: "public/dispatch.js", test: front, property: true,
    from: "if (canonicalSource && !order.planOwned && !order.transitCo) return false;",
    to: "if (false && canonicalSource && !order.planOwned && !order.transitCo) return false;" },
  { name: "active CO group accepted for repair", file: "tools/repair-dispatch-retired-confirm.mjs", test: repair, property: true,
    from: 'guard(group.active === false && group.order_type === "CO",', to: 'guard(group.order_type === "CO",' },
  { name: "stale repair fingerprint accepted", file: "tools/repair-dispatch-retired-confirm.mjs", test: repair, property: true,
    from: 'guard(expectedFingerprint === fingerprint, "state changed; rehearse again");', to: 'guard(true, "state changed; rehearse again");' },
  { name: "assigned canonical records dropped", file: "public/dispatch.js", test: front, property: true,
    from: "assignedIds.has(order.id) || isDispatchPlanOwnedOrder(order)", to: "false || isDispatchPlanOwnedOrder(order)" },
  { name: "explicit local ownership ignored", file: "public/dispatch.js", test: front, property: true,
    from: "if (canonicalSource && !order.planOwned && !order.transitCo) return false;",
    to: "if (canonicalSource) return false;" },
  { name: "retired snapshot protection bypassed", file: "src/dispatch-delivery-group-repository.js", test: integration, property: false,
    from: "if (rejectRetiredGlobalOrderRefs && blockedRetiredRefs.size)", to: "if (false && rejectRetiredGlobalOrderRefs && blockedRetiredRefs.size)" },
  { name: "explicit reactivation ignored", file: "src/dispatch-delivery-group-repository.js", test: integration, property: false,
    from: ".filter((ref) => !allowedReactivations.has(ref))", to: ".filter(() => true)" },
  { name: "unmaterialized active definition omitted", file: "src/server.js", test: integration, property: true,
    from: "byId.set(id, derived);\n      continue;", to: "continue;" }
];

for (const mutant of mutants) {
  const original = await fs.readFile(mutant.file, "utf8");
  assert.equal(original.split(mutant.from).length, 2, `Unique mutation anchor: ${mutant.name}`);
  try {
    await fs.writeFile(mutant.file, original.replace(mutant.from, mutant.to));
    for (const propertyOnly of mutant.property ? [false, true] : [false]) {
      const result = spawnSync(process.execPath, ["--test", ...(propertyOnly ? ["--test-name-pattern=^property:"] : []), mutant.test],
        { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(result.error, undefined, `Mutant timed out: ${mutant.name}`);
      assert.notEqual(result.status, 0, `Surviving mutant: ${mutant.name} propertyOnly=${propertyOnly}`);
      assert.match(result.stdout, /AssertionError|ERR_ASSERTION|Property failed|code: 'DISPATCH_DERIVED_ORDER_RETIRED'/u,
        `Mutant must fail an assertion or the explicitly tested lifecycle contract: ${result.stdout}\n${result.stderr}`);
      console.log(JSON.stringify({ mutant: mutant.name, propertyOnly, killed: true }));
    }
  } finally {
    await fs.writeFile(mutant.file, original);
    assert.equal(await fs.readFile(mutant.file, "utf8"), original);
  }
}
console.log(JSON.stringify({ mutantsKilled: mutants.length, propertyMutantsKilled: mutants.filter(mutant => mutant.property).length,
  propertyLimits: "Strict rejection and explicit reactivation also have direct DB regressions; the eligibility property alone does not model their command intent." }));
