import assert from "node:assert/strict";
import { beginRollbackContext, closeDb, query } from "./db.js";
import {
  approveInitialScmReconciliationRun,
  createScmReconciliationRun,
  finishScmReconciliationRun,
  getScmReconciliationSettings
} from "./scm-reconciliation-repository.js";

const rollback = await beginRollbackContext();
try {
  await rollback.run(async () => {
    await query(
      `UPDATE scm_reconciliation_runs
          SET status = 'interrupted', completed_at = now(), updated_at = now()
        WHERE status IN ('queued', 'running')`
    );
    await query(
      `UPDATE scm_reconciliation_settings
          SET initial_dry_run_approved_at = TIMESTAMPTZ '2099-01-01 00:00:00+00',
              initial_dry_run_approved_by = 'existing-po-approval',
              so_initial_dry_run_approved_at = NULL,
              so_initial_dry_run_approved_by = NULL,
              auto_apply_unambiguous = false
        WHERE singleton_id = 1`
    );

    const soRun = await createScmReconciliationRun({
      triggerSource: "manual",
      scope: "SO",
      dryRun: true,
      requestedBy: "so-policy-harness"
    });
    await finishScmReconciliationRun(soRun.id, { status: "awaiting_approval" });
    await approveInitialScmReconciliationRun(soRun.id, "so-policy-harness");
    const afterSoApproval = await getScmReconciliationSettings();
    assert.ok(afterSoApproval.soInitialDryRunApprovedAt);
    assert.equal(afterSoApproval.soInitialDryRunApprovedBy, "so-policy-harness");
    assert.equal(afterSoApproval.initialDryRunApprovedBy, "existing-po-approval");
    assert.equal(
      afterSoApproval.autoApplyUnambiguous,
      false,
      "SO-only approval must not silently enable company-wide auto-apply."
    );

    await query(
      `UPDATE scm_reconciliation_settings
          SET initial_dry_run_approved_at = NULL,
              initial_dry_run_approved_by = NULL,
              so_initial_dry_run_approved_at = NULL,
              so_initial_dry_run_approved_by = NULL,
              auto_apply_unambiguous = false
        WHERE singleton_id = 1`
    );
    const allRun = await createScmReconciliationRun({
      triggerSource: "manual",
      scope: "all",
      dryRun: true,
      requestedBy: "all-policy-harness"
    });
    await finishScmReconciliationRun(allRun.id, { status: "awaiting_approval" });
    await approveInitialScmReconciliationRun(allRun.id, "all-policy-harness");
    const afterAllApproval = await getScmReconciliationSettings();
    assert.ok(afterAllApproval.initialDryRunApprovedAt);
    assert.ok(afterAllApproval.soInitialDryRunApprovedAt);
    assert.equal(afterAllApproval.initialDryRunApprovedBy, "all-policy-harness");
    assert.equal(afterAllApproval.soInitialDryRunApprovedBy, "all-policy-harness");
    assert.equal(afterAllApproval.autoApplyUnambiguous, true);
  });
  console.log("Sales-order reconciliation approval policy harness passed.");
} finally {
  await rollback.rollback();
  await closeDb();
}
