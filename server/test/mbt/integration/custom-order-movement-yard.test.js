import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, {after} from 'node:test';
import fc from 'fast-check';
import {beginRollbackContext, closeDb, query} from '../../../src/db.js';
import {getYardMovementDetail, listYardMovementCsvRows, listYardMovements} from '../../../src/yard-movement-repository.js';

after(closeDb);
const day = '2097-10-22';
const range = {from: day, to: day, direction: 'outbound', orderType: 'custom_order'};
const yards = [
  [1, '3445', '3445 Kennedy Road, Toronto, ON'],
  [28, '2967', '2967 Kennedy Road, Toronto, ON'],
  [15, '12441', '12441 Woodbine Avenue, Whitchurch-Stouffville, ON'],
  [26, '150', '150 Clark Blvd, Brampton, ON L6T 4Y8, Canada']
];

async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const ref = `RP-PER-CAM-${crypto.randomUUID()}`;
      const result = await query(`INSERT INTO dispatch_custom_orders
        (ref_number,pickup_location,dropoff_location,order_details,weight_lbs,status,completed_at)
        VALUES($1,$2,'8375 5 Side Rd, Milton, ON L7J 0A1','Return Pallet',100,'completed',$3)
        RETURNING id`, [ref, yards[0][2], `${day}T12:28:53Z`]);
      const id = result.rows[0].id;
      for (const [index, stop, status, photos] of [[0,'pickup','complete',4], [1,'dropoff','complete',2], [2,'pickup','pending',4]]) {
        await query(`INSERT INTO driver_job_records(job_id,plan_date,driver_login,truck_id,truck_plate,
          load_id,load_name,stop_id,stop_type,order_refs,photo_data_urls,status,started_at,completed_at,job_details)
          VALUES($1,$2,'yard-test-driver','TEST-TRUCK','TEST-PLATE','TEST-LOAD','Load 1',$1,$3,$4,$5,$6,$7,$8,'{}')`,
        [`${ref}-${index}`, day, stop, JSON.stringify([ref]),
          JSON.stringify(Array.from({length: photos}, (_, n) => `data:image/png;base64,${Buffer.from(`${index}-${n}`).toString('base64')}`)),
          status, status === 'complete' ? `${day}T12:05:00Z` : null,
          status === 'complete' ? `${day}T12:${index === 0 ? '06' : '28'}:53Z` : null]);
      }
      const filters = {...range, search: ref};
      const detailFilters = {...range, orderId: id};
      const pickup = address => query('UPDATE dispatch_custom_orders SET pickup_location=$2 WHERE id=$1', [id, address]);
      await run({id, ref, filters, detailFilters, pickup});
    });
  } finally {
    await rollback.rollback();
  }
}

test('Y1: completed full-address Custom Order appears for 3445 with both stops and all photos', async () => fixture(async f => {
  const before = (await query('SELECT to_jsonb(o) AS row FROM dispatch_custom_orders o WHERE id=$1', [f.id])).rows;
  const rows = await listYardMovements({...f.filters, yard: '1'});
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].yard_location_id), 1);
  assert.equal(rows[0].driver_record_count, 2);
  assert.equal(rows[0].photo_count, 6);
  assert.equal(rows[0].movement_status, 'delivered');
  const detail = await getYardMovementDetail(f.detailFilters);
  assert.equal(detail.driverRecords.length, 2);
  assert.equal(detail.driverPhotos.length, 6);
  assert.equal(detail.order.tranid, f.ref);
  assert.deepEqual((await query('SELECT to_jsonb(o) AS row FROM dispatch_custom_orders o WHERE id=$1', [f.id])).rows, before);
  for (const filter of [{yard:'28'}, {direction:'inbound'}, {orderType:'sales_order'}, {from:'2097-10-23',to:'2097-10-23'}]) {
    assert.deepEqual(await listYardMovements({...f.filters, ...filter}), []);
  }
}));

test('Y2: all four configured addresses and generated case/whitespace variants retain their yard identity', async () => fixture(async f => {
  for (const [id, , address] of yards) {
    await f.pickup(address);
    const rows = await listYardMovements({...f.filters, yard: String(id)});
    assert.equal(rows.length, 1, address);
    assert.equal(Number(rows[0].yard_location_id), id);
  }
  await fc.assert(fc.asyncProperty(fc.constantFrom(...yards), fc.boolean(), fc.integer({min:1,max:4}),
    fc.constantFrom(' ', '\t', '\n'), async ([id, , address], upper, repeats, whitespace) => {
      const variant = whitespace + (upper ? address.toUpperCase() : address.toLowerCase()).replaceAll(' ', whitespace.repeat(repeats)) + whitespace;
      await f.pickup(variant);
      const rows = await listYardMovements({...f.filters, yard: String(id)});
      assert.equal(rows.length, 1, JSON.stringify(variant));
      assert.equal(Number(rows[0].yard_location_id), id);
    }), {seed:20261026,numRuns:16});
}));

test('Y3: exact bare yard codes retain their established mappings', async () => fixture(async f => {
  for (const [id, code] of yards) {
    await f.pickup(` ${code} `);
    const rows = await listYardMovements({...f.filters, yard:String(id)});
    assert.equal(rows.length, 1, code);
    assert.equal(Number(rows[0].yard_location_id), id);
  }
}));

test('Y4: offsite and hostile addresses never acquire a yard from a shared street number', async () => fixture(async f => {
  const addresses = ['150 Main St, Toronto ON', '13445 Kennedy Road, Toronto, ON',
    '3445 Kennedy Road, Toronto, ON unit 2', 'Near 3445 Kennedy Road, Toronto, ON',
    '2967 Other Street', '12441 Other Street', "3445' OR 1=1 --", 'Unknown pickup'];
  for (const address of addresses) {
    await f.pickup(address);
    const rows = await listYardMovements(f.filters);
    assert.equal(rows.length, 1, address);
    assert.equal(rows[0].yard_location_id, null, address);
    assert.deepEqual(await listYardMovements({...f.filters, allowedSalesStoreLocationIds:[1,28,15,26]}), []);
  }
}));

test('Y5: list, detail and CSV honor permitted, wrong and empty yard scopes for full addresses', async () => fixture(async f => {
  for (const key of ['allowedYardLocationIds', 'allowedSalesStoreLocationIds']) {
    assert.equal((await listYardMovements({...f.filters, [key]:[1]})).length, 1);
    assert.equal((await getYardMovementDetail({...f.detailFilters, [key]:[1]})).driverPhotos.length, 6);
    const csv = await listYardMovementCsvRows({...f.filters, [key]:[1]});
    assert(csv.length > 0);
    assert(csv.every(row => row.order_ref === f.ref));
    for (const scope of [[], [28], [15,26]]) {
      assert.deepEqual(await listYardMovements({...f.filters, [key]:scope}), []);
      assert.equal(await getYardMovementDetail({...f.detailFilters, [key]:scope}), null);
      assert.deepEqual(await listYardMovementCsvRows({...f.filters, [key]:scope}), []);
    }
  }
}));

test('Y6: inactive configured yards retain historical address identity', async () => fixture(async f => {
  await query('UPDATE mbt_yards SET active=false WHERE dispatch_location_id=1');
  const rows = await listYardMovements({...f.filters, yard:'1'});
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].yard_location_id), 1);
}));

test('Y7: ambiguous configured addresses cannot grant either yard', async () => fixture(async f => {
  await query('UPDATE mbt_yards SET address_line_1=$1 WHERE dispatch_location_id=28', [yards[0][2]]);
  const rows = await listYardMovements(f.filters);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].yard_location_id, null);
  assert.deepEqual(await listYardMovements({...f.filters, allowedSalesStoreLocationIds:[1,28]}), []);
}));

test('Y8: address matching follows configured master data and rejects blank addresses', async () => fixture(async f => {
  const address = '42 Configured Lane, Test City, ON';
  await query('UPDATE mbt_yards SET address_line_1=$1 WHERE dispatch_location_id=1', [address]);
  await f.pickup(address);
  assert.equal((await listYardMovements({...f.filters, yard:'1'})).length, 1);
  await query("UPDATE mbt_yards SET address_line_1='' WHERE dispatch_location_id=1");
  await f.pickup('\t');
  assert.equal((await listYardMovements(f.filters))[0].yard_location_id, null);
}));
