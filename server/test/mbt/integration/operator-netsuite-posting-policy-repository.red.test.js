// @ts-check

import assert from "node:assert/strict";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { getOperatorNetSuitePostingPolicy } from "../../../src/operator-netsuite-posting-policy-repository.js";

after(async () => {
  await closeDb();
});

test("G2/G3/G5 policy reads one live cell, respects the deployment ceiling, and fails closed", async () => {
  const context = await beginRollbackContext();
  try {
    await context.run(async () => {
      await query(
        `UPDATE mbt_feature_flags
            SET enabled = false,
                revision = revision + 1,
                updated_at = now()
          WHERE flag_key LIKE 'operator_netsuite_%'`
      );
      const before = await getOperatorNetSuitePostingPolicy({
        functionKey: "delivery_prep",
        locationId: 15,
        directAccessEnabled: true
      });
      assert.equal(before.configured, false);
      assert.equal(before.effective, false);

      await query(
        `UPDATE mbt_feature_flags
            SET enabled = true,
                revision = revision + 1,
                updated_at = now()
          WHERE flag_key = 'operator_netsuite_delivery_prep_if_12441'`
      );
      const live = await getOperatorNetSuitePostingPolicy({
        functionKey: "delivery_prep",
        locationId: 15,
        directAccessEnabled: true
      });
      assert.equal(live.gateKey, "operator_netsuite_delivery_prep_if_12441");
      assert.equal(live.configured, true);
      assert.equal(live.effective, true);
      assert.equal(live.revision, before.revision + 1);

      const otherCell = await getOperatorNetSuitePostingPolicy({
        functionKey: "receiving",
        locationId: 15,
        directAccessEnabled: true
      });
      assert.equal(otherCell.effective, false);

      const ceilingClosed = await getOperatorNetSuitePostingPolicy({
        functionKey: "delivery_prep",
        locationId: 15,
        directAccessEnabled: false
      });
      assert.equal(ceilingClosed.configured, true);
      assert.equal(ceilingClosed.environmentAllowed, false);
      assert.equal(ceilingClosed.effective, false);

      await query(
        `DELETE FROM mbt_feature_flags
          WHERE flag_key = 'operator_netsuite_customer_pickup_if_3445'`
      );
      const missing = await getOperatorNetSuitePostingPolicy({
        functionKey: "customer_pickup",
        locationId: 1,
        directAccessEnabled: true
      });
      assert.equal(missing.present, false);
      assert.equal(missing.effective, false);
      assert.equal(missing.revision, null);
    });
  } finally {
    await context.rollback();
  }
});
