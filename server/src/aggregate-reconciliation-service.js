import { claimAggregateNightlyRun } from './aggregate-reconciliation-repository.js';
import { executeScmReconciliationRun } from './scm-reconciliation-service.js';

let tickInProgress = false;
export async function aggregateReconciliationNightlyTick({ now = new Date(), operationalSyncRunning = () => false } = {}) {
  if (tickInProgress) { return { started: false, reason: 'tick_in_progress' }; }
  tickInProgress = true;
  try {
    if (await operationalSyncRunning()) { return { started: false, reason: 'operational_sync_running' }; }
    const claimed = await claimAggregateNightlyRun({ now });
    if (!claimed.started) { return claimed; }
    return { started: true, run: await executeScmReconciliationRun(claimed.run, { operationalSyncRunning }) };
  } catch (error) {
    if (error.status === 409) { return { started: false, reason: 'reconciliation_active' }; }
    throw error;
  } finally { tickInProgress = false; }
}
