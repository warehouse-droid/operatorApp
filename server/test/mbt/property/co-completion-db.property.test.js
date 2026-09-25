import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fc from 'fast-check';
import { closeDb, query, withTransaction } from '../../../src/db.js';
import { assertSalesDeliveryPlanningAllowed } from '../../../src/dispatch-fulfilled-so-repository.js';
import { seedCoFixture, insertCoJob, insertLegacyCoJob } from '../../support/co-completion-fixture.mjs';
after(closeDb);

test('generated retry counts and reference permutations preserve transfer and independent delivery identities', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.boolean(), fc.boolean(), async (retries, reverse, delivered) => {
    await withTransaction(async () => {
      const f = await seedCoFixture();
      const legacy = await insertLegacyCoJob(f);
      if (delivered) { await insertCoJob(f, { jobId: `${f.jobId}:customer`, stopId: 'customer-drop', refs: [f.members[0]] }); }
      for (let i = 0; i < retries; i++) {
        await query('UPDATE driver_job_records SET order_refs=$2::jsonb WHERE id=$1',
          [legacy.id, JSON.stringify(reverse ? [...f.members].reverse() : f.members)]);
      }
      assert.deepEqual((await query('SELECT order_refs FROM driver_job_records WHERE id=$1', [legacy.id])).rows[0].order_refs, [f.coRef]);
      assert.equal((await query('SELECT status FROM local_co_orders WHERE co_ref=$1', [f.coRef])).rows[0].status, 'completed');
      await assert.doesNotReject(() => assertSalesDeliveryPlanningAllowed([f.members[1]]));
      if (delivered) { await assert.rejects(() => assertSalesDeliveryPlanningAllowed([f.members[0]])); }
      else { await assert.doesNotReject(() => assertSalesDeliveryPlanningAllowed([f.members[0]])); }
      const effective = await query('SELECT count(*)::int AS n FROM dispatch_order_completion_status WHERE order_ref=ANY($1)', [f.members]);
      assert.equal(effective.rows[0].n, delivered ? 1 : 0);
      const correctJob = await insertCoJob(f, { jobId: `${f.jobId}:typed-co`, refs: [f.coRef] });
      assert.equal((await query('SELECT count(*)::int AS n FROM dispatch_order_completion_events WHERE completion_evidence_id=$1', [correctJob.job_id])).rows[0].n, 0);
    }, { rollback: true });
  }), { seed: 65316537, numRuns: 20 });
});
