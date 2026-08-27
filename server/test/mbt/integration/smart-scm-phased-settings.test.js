import assert from "node:assert/strict";
import test, { after } from "node:test";

import { beginRollbackContext, closeDb, query } from "../../../src/db.js";
import { getSmartScmSettings, updateSmartScmSettings } from "../../../src/smart-scm-repository.js";

after(closeDb);

test("skip-12441 and phased inventory planning persist as independent settings", async () => {
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      await query(
        `UPDATE scm_smart_settings
            SET skip_12441_enabled = false,
                inventory_planning_mode = 'integrated'
          WHERE id = 1`
      );

      const initial = await getSmartScmSettings();
      assert.equal(initial.skip12441Enabled, false);
      assert.equal(initial.inventoryPlanningMode, "integrated");

      const skipEnabled = await updateSmartScmSettings({ skip12441Enabled: true });
      assert.equal(skipEnabled.skip12441Enabled, true);
      assert.equal(skipEnabled.inventoryPlanningMode, "integrated");

      const phased = await updateSmartScmSettings({ inventoryPlanningMode: "po_then_transfer" });
      assert.equal(phased.skip12441Enabled, true);
      assert.equal(phased.inventoryPlanningMode, "po_then_transfer");

      await assert.rejects(
        () => updateSmartScmSettings({ inventoryPlanningMode: "unsafe_combined_mode" }),
        (error) => error?.status === 400
          && /integrated or PO then Transfer/.test(error.message)
      );
      assert.deepEqual(
        await getSmartScmSettings().then(({ skip12441Enabled, inventoryPlanningMode }) => ({
          skip12441Enabled,
          inventoryPlanningMode
        })),
        { skip12441Enabled: true, inventoryPlanningMode: "po_then_transfer" }
      );
    });
  } finally {
    await rollback.rollback();
  }
});
