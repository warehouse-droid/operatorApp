// @ts-check

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const lifecycle = fs.readFileSync(new URL("../../../src/dispatch-co-lifecycle.js", import.meta.url), "utf8");
const repository = fs.readFileSync(new URL("../../../src/dispatch-repository.js", import.meta.url), "utf8");
const planRepository = fs.readFileSync(new URL("../../../src/dispatch-plan-repository.js", import.meta.url), "utf8");
const v2Repository = fs.readFileSync(new URL("../../../src/dispatch-planner-v2-repository.js", import.meta.url), "utf8");
const recovery = fs.readFileSync(new URL("../../../src/dispatch-co-recovery.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../../../src/server.js", import.meta.url), "utf8");

test("CO cancellation delegates to the global lifecycle guard under the shared planning lock", () => {
  assert.match(repository, /return cancelDispatchCoGlobally\(coRef, \{ requestedBy \}\)/u);
  assert.match(lifecycle, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/u);
  assert.match(lifecycle, /DISPATCH_FLEET_PLANNING_LOCK/u);
  assert.match(lifecycle, /DISPATCH_CO_ALREADY_PLANNED/u);
});

test("legacy save, restore, confirm, and V2 command writers reject inactive assigned COs", () => {
  assert.ok(
    planRepository.match(/await assertActiveDispatchCosForPlan\(/gu)?.length >= 3,
    "legacy plan save, restore, and confirm must all assert active CO rows"
  );
  assert.match(v2Repository, /await assertActiveDispatchCosForPlan\(result\.plan\)/u);
  assert.match(lifecycle, /DISPATCH_CO_NOT_ACTIVE/u);
  assert.ok(
    server.match(/status NOT IN \('received', 'loaded', 'completed'\)/gu)?.length >= 2,
    "stale assignment follow-ups must not rewrite a Driver-completed CO"
  );
});

test("the one-off recovery remains exact, audited, and cannot rewrite plan snapshots", () => {
  assert.match(recovery, /coRef: "CO-GOA-3464-3470-6922"/u);
  assert.match(recovery, /sourcePlanId: 48/u);
  assert.match(recovery, /sourcePlanRevision: 326/u);
  assert.match(recovery, /originalToLocationId: 26/u);
  assert.match(recovery, /originalToYard: "150"/u);
  assert.match(recovery, /action: "co_recovered_from_confirmed_plan"/u);
  assert.doesNotMatch(recovery, /UPDATE dispatch_plan(?:s|_snapshots)/u);
});
