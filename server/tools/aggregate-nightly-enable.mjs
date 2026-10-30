import assert from 'node:assert/strict';
import { getScmReconciliationSettings, updateScmReconciliationSettings, listScmReconciliationBroadExcludedSources } from '../src/scm-reconciliation-repository.js';
import { listPendingAggregateReconciliationSources } from '../src/aggregate-reconciliation-repository.js';
import { isBilledSalesOrderIdentifier } from '../src/sales-order-reconciliation-repository.js';
import { listDeliveryOrders } from '../src/delivery-repository.js';
import { writeAudit } from '../src/auth-repository.js';
import { closeDb } from '../src/db.js';
try {
  const before = await getScmReconciliationSettings();
  assert.equal(before.nightlyEnabled, false, 'Do not enable the broad nightly job');
  assert.ok(before.soInitialDryRunApprovedAt);
  const sources = await listPendingAggregateReconciliationSources();
  const excluded = new Set((await listScmReconciliationBroadExcludedSources({ kind: 'SO' })).map(row => `${row.kind}:${row.id}`));
  const eligible = sources.filter(row => !excluded.has(`${row.kind}:${row.id}`));
  const billed = await isBilledSalesOrderIdentifier('SOB122244');
  assert.equal(billed, true);
  const pending = await listDeliveryOrders({ locationId: 1 });
  assert.equal(pending.some(row => row.tranid === 'SOB122244'), false);
  const settings = await updateScmReconciliationSettings({ aggregateNightlyEnabled: true, aggregateNightlyTime: '21:30' }, 'maintenance:aggregate-nightly-20261022');
  assert.equal(settings.nightlyEnabled, false);
  await writeAudit({ actorType: 'system', source: 'maintenance', action: 'aggregate_nightly.enabled', details: {
    scope: 'Pending Fulfillment SOs containing bulk/bagged aggregate materials', time: '21:30', timeZone: 'America/Toronto',
    eligibleOrders: eligible.length, broadNightlyEnabled: false, fifteenMinuteRefreshEnabled: false
  } });
  console.log(JSON.stringify({ enabledAt: new Date().toISOString(), settings,
    locallyPendingAggregateOrders: sources.length, eligibleOrders: eligible.length,
    sob122244: { recognizedBilled: billed, absentFromPendingOperatorOrders: true } }));
} finally { await closeDb(); }
