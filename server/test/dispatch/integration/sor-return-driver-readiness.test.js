import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {query, withTransaction, closeDb} from '../../../src/db.js';
import {startDriverJob, recordDriverJobPhotos} from '../../../src/driver-repository.js';
import {getSorReturnReadiness, assertSorReturnReady} from '../../../src/sor-return-readiness.js';
import {sanitizeDriverOfflineJob} from '../../../src/driver-offline-repository.js';

after(closeDb);

async function fixture(parent = 'SOR992225') {
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,sales_order_type,netsuite_active,status_text)
    VALUES(992225,'SOR992225','Delivery',true,'Pending Fulfillment')`);
  const ref = `${parent}-Return`;
  await query(`INSERT INTO dispatch_custom_orders(ref_number,pickup_location,dropoff_location,order_details,
    weight_lbs,order_kind,system_managed,parent_sales_order_id,parent_order_ref,line_snapshot,billing_disposition)
    VALUES($1,'77 Test Site Road','3445','Isolated rental return',0,'sor_rental_return',true,992225,$2,'[]','linked_parent_no_charge')`,
  [ref, parent]);
  return {jobId: `test-${ref}`, driverLogin: 'sor-return-test', planDate: '2026-01-01',
    stopType: 'pickup', stopId: 'sor-return-pickup', status: 'pending', orderRefs: [ref], requiredPhotos: 2};
}

for (const parent of ['SOR992225', 'SOR992225-S1']) {
  test(`${parent}: return can start without a planned or completed delivery`, async () => withTransaction(async () => {
    const job = await fixture(parent);
    const readiness = await getSorReturnReadiness(job.orderRefs);
    assert.deepEqual(readiness, [{orderRef: job.orderRefs[0], parentOrderRef: parent, allowed: true, code: '', message: ''}]);
    const offlineJob = sanitizeDriverOfflineJob({...job, sorReturnReadiness: readiness});
    assert.equal(offlineJob.sorReturnReadiness[0].allowed, true);
    const started = await startDriverJob(job.driverLogin, job.jobId, {job});
    assert.equal(started.status, 'in_progress');
    assert.equal((await query("SELECT count(*)::int AS n FROM driver_job_records WHERE stop_type='dropoff' AND order_refs @> $1::jsonb",
      [JSON.stringify([parent])])).rows[0].n, 0);
  }, {rollback: true}));
}

test('return completion without an earlier start or delivery still records required photos', async () => withTransaction(async () => {
  const job = await fixture();
  await assert.rejects(recordDriverJobPhotos(job.driverLogin, job.jobId, {job}), /2 photos are required/);
  const photos = ['r2://driver/return-test/photo-1.jpg', 'r2://driver/return-test/photo-2.jpg'];
  const completed = await recordDriverJobPhotos(job.driverLogin, job.jobId, {job, photoDataUrls: photos});
  assert.equal(completed.status, 'complete');
  assert.deepEqual(completed.photo_data_urls, photos);
  assert.equal((await query("SELECT count(*)::int AS n FROM driver_job_records WHERE stop_type='dropoff' AND order_refs @> '[\"SOR992225\"]'::jsonb")).rows[0].n, 0);
}, {rollback: true}));

for (const [label, change, message] of [
  ['cancelled return', "status='cancelled'", /not an open rental return/],
  ['Dispatch review', "sor_review_reason='Quantity changed'", /needs Dispatch review/],
  ['missing address', "pickup_location=''", /needs a customer pickup address/]
]) {
  test(`${label} remains blocked`, async () => withTransaction(async () => {
    const job = await fixture();
    await query(`UPDATE dispatch_custom_orders SET ${change} WHERE ref_number=$1`, job.orderRefs);
    await assert.rejects(assertSorReturnReady(job), error => error.code === 'SOR_RETURN_NOT_READY' && message.test(error.message));
    await assert.rejects(startDriverJob(job.driverLogin, job.jobId, {job}), message);
    assert.equal((await query('SELECT 1 FROM driver_job_records WHERE job_id=$1', [job.jobId])).rowCount, 0);
  }, {rollback: true}));
}
