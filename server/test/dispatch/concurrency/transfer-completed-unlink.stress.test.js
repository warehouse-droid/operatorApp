import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeDb, query } from "../../../src/db.js";
import { cancelOrderDependency } from "../../../src/order-dependency-repository.js";
import { executionEvidence, seedTransferDependency, seedTransferJob } from "../../support/transfer-unlink-fixture.mjs";

after(closeDb);

test("32 concurrent completed-TO unlinks retain all execution evidence and audit exactly once", async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, "1");
  const f = await seedTransferDependency();
  await seedTransferJob(f);
  await query("UPDATE order_dependency_lines SET loaded_quantity=10,delivered_quantity=10 WHERE dependency_id=$1", [f.dependencyId]);
  const before = await executionEvidence(f);
  const results = await Promise.all(Array.from({ length: 32 }, () => cancelOrderDependency(f.dependencyId, null, f.plan.planDate)));
  assert.equal(results.filter((result) => !result.alreadyCancelled).length, 1);
  assert.equal(results.filter((result) => result.alreadyCancelled).length, 31);
  assert.ok(results.every((result) => result.cancelled));
  assert.deepEqual(await executionEvidence(f), before);
  assert.equal(Number((await query("SELECT count(*) FROM dispatch_audit_log WHERE action='dispatch.order_dependency.unlinked' AND entity_id=$1", [String(f.dependencyId)])).rows[0].count), 1);
});
