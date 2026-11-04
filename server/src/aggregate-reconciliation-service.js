import { claimAggregateNightlyRun } from './aggregate-reconciliation-repository.js';
import { executeScmReconciliationRun } from './scm-reconciliation-service.js';
import { refreshOpenSpecialVendorPickupOrders } from './special-vendor-pickup-refresh.js';

/** Customer pickup at a vendor yard has no webhook or local completion; refresh it once per night.
 * A refresh failure is reported without failing the aggregate run. */
async function nightlySpecialVendorPickupRefresh() {
  try { return await refreshOpenSpecialVendorPickupOrders(); }
  catch (error) { return { error: String(error instanceof Error ? error.message : error) }; }
}

let tickInProgress = false;
export async function aggregateReconciliationNightlyTick({ now = new Date(), operationalSyncRunning = () => false } = {}) {
  if (tickInProgress) { return { started: false, reason: 'tick_in_progress' }; }
  tickInProgress = true;
  try {
    if (await operationalSyncRunning()) { return { started: false, reason: 'operational_sync_running' }; }
    const claimed = await claimAggregateNightlyRun({ now });
    if (!claimed.started) { return claimed; }
    const execution = await executeScmReconciliationRun(claimed.run, { operationalSyncRunning })
      .then(run => ({ run, error: null }), error => ({ run: null, error }));
    const specialVendorPickup = await nightlySpecialVendorPickupRefresh();
    if (execution.error) { throw execution.error; }
    return { started: true, run: execution.run, specialVendorPickup };
  } catch (error) {
    if (error.status === 409) { return { started: false, reason: 'reconciliation_active' }; }
    throw error;
  } finally { tickInProgress = false; }
}
