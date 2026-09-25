import assert from 'node:assert/strict';
import { suiteql } from './src/netsuite.js';
import { closeDb } from './src/db.js';
import { withOperatorNetSuitePriority, withBackgroundNetSuitePriority } from './src/operator-netsuite-request-pool.js';
import { operatorPostingTelemetry } from './src/operator-netsuite-posting-telemetry.js';

// Run over stdin from /app in the chosen live container. This is a read of the
// already-completed incident IF, never a fulfillment/receipt/return submission.
const priority = process.argv[2];
assert.ok(['operator', 'background'].includes(priority));
const withPriority = priority === 'operator' ? withOperatorNetSuitePriority : withBackgroundNetSuitePriority;
const started = performance.now();
try {
  const result = await operatorPostingTelemetry.context({ commandId: `priority-release-probe-${priority}`, stage: 'read_only_probe' },
    () => withPriority(() => suiteql('SELECT id FROM transaction WHERE id = 1014665', [], { limit: 1 })));
  assert.equal(String(result.items?.[0]?.id), '1014665');
  console.log(JSON.stringify({ readOnlyNetSuiteProbe: true, priority, foundExistingIF: true,
    durationMs: Math.round((performance.now() - started) * 100) / 100 }));
} finally {
  await closeDb();
}
