import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fc from 'fast-check';
import { closeDb } from '../../../src/db.js';
import { priorityScenario, backgroundScenario } from '../../support/netsuite-priority-queue-fixture.mjs';

after(closeDb);
test('four shared slots prioritize Operator requests ahead of background and recover after failure', async () => {
  await priorityScenario(4, 3, 1);
});
test('background-only traffic remains serialized even with spare capacity', async () => { await backgroundScenario(); });
test('property: priority, both concurrency bounds, FIFO, exact outcomes and eventual background progress', async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 7 }), fc.integer({ min: 1, max: 4 }),
    fc.nat({ max: 7 }), async (operators, background, failAt) => {
      await priorityScenario(operators, background, failAt % operators);
      await backgroundScenario(background + 1);
    }),
  { seed: 240925, numRuns: 24, endOnFailure: true });
});
