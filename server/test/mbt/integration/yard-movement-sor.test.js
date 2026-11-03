import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, {after} from 'node:test';
import {beginRollbackContext, closeDb, query} from '../../../src/db.js';
import {getYardMovementDetail, listYardMovementCsvRows, listYardMovements} from '../../../src/yard-movement-repository.js';

after(closeDb);
const day = '2097-11-03';
const range = {from: day, to: day, yard: 'all'};
const rentalYard = '3445 Kennedy Road, Toronto, ON';
const photo = text => `data:image/png;base64,${Buffer.from(text).toString('base64')}`;
const keyOf = row => `${row.direction}:${row.order_type}:${row.order_id}`;

async function driverJob({jobId, stopType, orderRefs = [], details = {}, at}) {
  await query(`INSERT INTO driver_job_records(job_id,plan_date,driver_login,truck_id,truck_plate,load_id,load_name,
    stop_id,stop_type,order_refs,photo_data_urls,status,started_at,completed_at,job_details)
    VALUES($1,$2,'sor-record-driver','SOR-TRUCK','SOR-PLATE','SOR-LOAD','SOR Load',$1,$3,$4,$5,'complete',$6,$6,$7)`,
  [jobId, day, stopType, JSON.stringify(orderRefs), JSON.stringify([photo(jobId)]), at, JSON.stringify(details)]);
}

async function fixture(run) {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  assert.equal(new URL(process.env.DATABASE_URL).hostname, 'db');
  const rollback = await beginRollbackContext();
  try {
    await rollback.run(async () => {
      const base = 9_300_000_000 + crypto.randomInt(100_000_000);
      const sorRef = `SOR${base}`, returnRef = `${sorRef}-Return`, soRef = `SOB${base}`;
      const sku = `RENTAL-LIFT-${base}`, customer = `SOR Customer ${base}`;
      const sorId = base, soId = base + 1;
      for (const [id, ref] of [[sorId, sorRef], [soId, soRef]]) {
        await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,outbound_location_id,outbound_location,netsuite_active)
          VALUES($1,$2,$3,1,'3445',true)`, [id, ref, customer]);
      }
      const sorLine = (await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_description,
        quantity,unit,to_plt,to_lyr,to_sec,to_pcs,loaded_qty,loaded_uom,fulfilled_piece_qty,netsuite_active)
        VALUES($1,1,$2,'Scissor Lift','${sku}','Rental scissor lift',2,'EA',0,0,0,1,2,'EA',2,true) RETURNING id`,
      [sorId, base])).rows[0].id;
      await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_description,
        quantity,unit,loaded_qty,loaded_uom,netsuite_active) VALUES($1,1,$2,'Brick','BRICK-${base}','Brick',5,'EA',5,'EA',true)`,
      [soId, base + 1]);
      for (const [id, ref, loadedSku] of [[sorId, sorRef, sku], [soId, soRef, `BRICK-${base}`]]) {
        await query(`INSERT INTO operator_load_records(order_id,order_ref,order_family,load_type,line_snapshot,photo_data_urls,created_at)
          VALUES($1,$2,'sales_order','sales_order_delivery_load',$3,$4,$5)`,
        [id, ref, JSON.stringify([{lineId: 1, sku: loadedSku, itemName: loadedSku, loadedQty: 2, loadedUom: 'EA'}]),
          JSON.stringify([photo(`yard-${ref}`)]), `${day}T09:00:00Z`]);
      }
      const snapshot = [{lineRowId: sorLine, lineId: 1, itemId: base, itemName: 'Scissor Lift', sku,
        description: 'Rental scissor lift', quantity: 2, unit: 'EA', pieces: 2}];
      const returnId = (await query(`INSERT INTO dispatch_custom_orders(ref_number,pickup_location,dropoff_location,order_details,
        weight_lbs,order_kind,system_managed,parent_sales_order_id,parent_order_ref,line_snapshot,sales_qty,piece_qty,
        billing_disposition,sor_customer,status,created_by,updated_by)
        VALUES($1,'100 Customer Site Rd, Toronto, ON',$2,$3,0,'sor_rental_return',true,$4,$5,$6,2,2,
          'linked_parent_no_charge',$7,'completed','sor-test','sor-test') RETURNING id`,
      [returnRef, rentalYard, `Rental equipment return for ${sorRef}`, sorId, sorRef, JSON.stringify(snapshot), customer])).rows[0].id;
      const customRef = `CUSTOM-${base}`;
      const customId = (await query(`INSERT INTO dispatch_custom_orders(ref_number,pickup_location,dropoff_location,order_details,weight_lbs)
        VALUES($1,$2,'8375 5 Side Rd, Milton, ON L7J 0A1','Return Pallet',100) RETURNING id`, [customRef, rentalYard])).rows[0].id;
      await driverJob({jobId: `${base}-sor-drop`, stopType: 'dropoff', orderRefs: [sorRef], at: `${day}T11:00:00Z`});
      await driverJob({jobId: `${base}-return-pick`, stopType: 'pickup', orderRefs: [returnRef], at: `${day}T13:00:00Z`});
      await driverJob({jobId: `${base}-return-drop`, stopType: 'dropoff', orderRefs: [returnRef], at: `${day}T14:00:00Z`});
      await driverJob({jobId: `${base}-custom-pick`, stopType: 'pickup', orderRefs: [customRef], at: `${day}T15:00:00Z`});
      // Real SOR rentals: NetSuite location "Rental" (not a yard), driver-only, nothing yard-loaded.
      const rentalId = base + 2, rentalRef = `SOR${base + 2}-S1`, rentalSku = `RENTAL-BOOM-${base}`;
      const offYardId = base + 3, offYardRef = `SOM${base + 3}`;
      for (const [id, ref] of [[rentalId, rentalRef], [offYardId, offYardRef]]) {
        await query(`INSERT INTO sales_orders(netsuite_id,tranid,customer,outbound_location_id,outbound_location,netsuite_active)
          VALUES($1,$2,$3,50,'Rental',true)`, [id, ref, customer]);
      }
      for (const [lineId, lineSku, quantity, active] of [[1, rentalSku, 1, true], [2, `REMOVED-${base}`, 3, false], [3, `ZERO-${base}`, 0, true]]) {
        await query(`INSERT INTO sales_order_lines(sales_order_id,line_id,item_id,item_name,sku,item_description,quantity,unit,
          to_plt,to_lyr,to_sec,to_pcs,piece_qty,loaded_qty,netsuite_active)
          VALUES($1,$2,$3,'Boom Lift',$4,'Rental boom lift',$5,'EA',0,0,0,1,$5,0,$6)`,
        [rentalId, lineId, base + 10 + lineId, lineSku, quantity, active]);
      }
      await query(`INSERT INTO operator_load_records(order_id,order_ref,order_family,load_type,line_snapshot,photo_data_urls,created_at)
        VALUES($1,$2,'sales_order','sales_order_delivery_load','[]','[]',$3)`, [offYardId, offYardRef, `${day}T09:30:00Z`]);
      await driverJob({jobId: `${base}-rental-drop`, stopType: 'dropoff', orderRefs: [rentalRef], at: `${day}T10:00:00Z`});
      await run({base, sorRef, returnRef, soRef, customRef, sorId, soId, returnId, customId, sku, customer,
        rentalId, rentalRef, rentalSku, offYardId, offYardRef});
    });
  } finally {
    await rollback.rollback();
  }
}

test('SOR deliveries have their own outbound type and keep sales-order history', async () => fixture(async f => {
  const sor = await listYardMovements({...range, direction: 'outbound', orderType: 'sor_order', search: f.sorRef});
  assert.deepEqual(sor.map(keyOf), [`outbound:sor_order:${f.sorId}`]);
  assert.equal(sor[0].tranid, f.sorRef);
  assert.equal(sor[0].yard_activity_count, 1);
  assert.equal(sor[0].driver_activity_count, 1);
  assert.equal(sor[0].movement_status, 'delivered');
  const so = await listYardMovements({...range, direction: 'outbound', orderType: 'sales_order', search: String(f.base)});
  assert.deepEqual(so.map(keyOf).sort(), [`outbound:sales_order:${f.soId}`, `outbound:sales_order:${f.offYardId}`].sort(),
    'SO tab must exclude SOR deliveries');
  const detail = await getYardMovementDetail({...range, direction: 'outbound', orderType: 'sor_order', orderId: f.sorId});
  assert.equal(detail.order.order_type, 'sor_order');
  assert.deepEqual(detail.lines.map(line => line.sku), [f.sku]);
  assert.equal(detail.photos.length, 1);
  assert.equal(detail.driverRecords.length, 1);
  assert.equal(detail.driverPhotos.length, 1);
  assert.equal(await getYardMovementDetail({...range, direction: 'outbound', orderType: 'sales_order', orderId: f.sorId}), null);
  assert(detail.lines.every(line => line.quantity_basis === 'processed'), 'Yard-loaded SOR lines keep loaded quantities');
}));

test('driver-only SOR rentals at the Rental location ship from the 3445 yard with their ordered lines', async () => fixture(async f => {
  const key = `outbound:sor_order:${f.rentalId}`;
  const filters = {...range, direction: 'outbound', orderType: 'sor_order', search: f.rentalRef};
  const [row] = await listYardMovements(filters);
  assert.equal(keyOf(row), key);
  assert.equal(Number(row.yard_location_id), 1);
  assert.equal(row.yard_location, '3445');
  assert.equal(row.driver_only, true);
  assert.deepEqual((await listYardMovements({...filters, yard: '1'})).map(keyOf), [key]);
  assert.deepEqual((await listYardMovements({...filters, allowedYardLocationIds: [1]})).map(keyOf), [key]);
  assert.deepEqual((await listYardMovements({...filters, allowedSalesStoreLocationIds: [1]})).map(keyOf), [key]);
  for (const scope of [{yard: '28'}, {allowedYardLocationIds: [28]}, {allowedSalesStoreLocationIds: [28]}]) {
    assert.deepEqual(await listYardMovements({...filters, ...scope}), [], JSON.stringify(scope));
  }
  assert.deepEqual((await listYardMovements({...range, itemSearch: f.rentalSku})).map(keyOf), [key]);
  assert.deepEqual(await listYardMovements({...range, itemSearch: `REMOVED-${f.base}`}), [], 'Inactive lines are not searchable');
  const detail = await getYardMovementDetail({...range, direction: 'outbound', orderType: 'sor_order', orderId: f.rentalId,
    allowedYardLocationIds: [1]});
  assert.deepEqual(detail.lines.map(line => [line.sku, Number(line.processed_qty), line.quantity_basis]), [[f.rentalSku, 1, 'ordered']]);
  const csv = await listYardMovementCsvRows(filters);
  assert.deepEqual(csv.map(line => [line.sku, line.attempt_quantity_basis]), [[f.rentalSku, 'ordered']]);
  const [offYard] = await listYardMovements({...range, search: f.offYardRef});
  assert.equal(keyOf(offYard), `outbound:sales_order:${f.offYardId}`);
  assert.equal(Number(offYard.yard_location_id), 50, 'Only SOR deliveries move to the rental yard');
}));

test('SOR returns are inbound to the rental yard with their returned equipment', async () => fixture(async f => {
  const rows = await listYardMovements({...range, direction: 'inbound', orderType: 'sor_return', search: f.returnRef});
  assert.deepEqual(rows.map(keyOf), [`inbound:sor_return:${f.returnId}`]);
  assert.equal(Number(rows[0].yard_location_id), 1);
  assert.equal(rows[0].party, f.customer);
  assert.equal(rows[0].driver_record_count, 2);
  assert.equal(rows[0].photo_count, 2);
  assert.equal(rows[0].driver_only, true);
  assert.equal(rows[0].movement_status, 'delivered');
  const detail = await getYardMovementDetail({...range, direction: 'inbound', orderType: 'sor_return', orderId: f.returnId});
  assert.equal(detail.order.tranid, f.returnRef);
  assert.equal(detail.driverRecords.length, 2);
  assert.equal(detail.lines.length, 1);
  assert.equal(detail.lines[0].sku, f.sku);
  assert.equal(Number(detail.lines[0].processed_qty), 2);
  assert.equal(detail.lines[0].processed_uom, 'EA');
  assert.equal(Number(detail.lines[0].processed_piece_qty), 2);
  assert.equal(Number(detail.lines[0].to_pcs), 1, 'Returned lines keep the source line conversion');
  for (const filter of [{direction: 'outbound'}, {orderType: 'custom_order'}, {yard: '28'}]) {
    assert.deepEqual(await listYardMovements({...range, search: f.returnRef, ...filter}), [], JSON.stringify(filter));
  }
  const custom = await listYardMovements({...range, direction: 'outbound', orderType: 'custom_order', search: String(f.base)});
  assert.deepEqual(custom.map(keyOf), [`outbound:custom_order:${f.customId}`], 'Ordinary custom orders are unchanged');
}));

test('global order and item searches find the SOR delivery and its return', async () => fixture(async f => {
  const byOrder = await listYardMovements({...range, search: f.sorRef.toLowerCase()});
  assert.deepEqual(byOrder.map(keyOf).sort(), [`inbound:sor_return:${f.returnId}`, `outbound:sor_order:${f.sorId}`].sort());
  const byCustomer = await listYardMovements({...range, search: f.customer});
  assert.deepEqual(byCustomer.map(keyOf).sort(),
    [`inbound:sor_return:${f.returnId}`, `outbound:sales_order:${f.soId}`, `outbound:sales_order:${f.offYardId}`,
      `outbound:sor_order:${f.sorId}`, `outbound:sor_order:${f.rentalId}`].sort());
  const byItem = await listYardMovements({...range, itemSearch: f.sku});
  assert.deepEqual(byItem.map(keyOf).sort(), [`inbound:sor_return:${f.returnId}`, `outbound:sor_order:${f.sorId}`].sort());
}));

test('BIN transport cargo legs count as SOR activity; empty-bin legs do not', async () => fixture(async f => {
  const mbt = (actionCode, sourceRef) => ({mbt: {schemaVersion: 1, transportTripId: `trip-${f.base}`, sourceRef, actionCode}});
  await driverJob({jobId: `${f.base}-bin-collect`, stopType: 'pickup', details: mbt('collect_empty_bin', f.returnRef), at: `${day}T16:00:00Z`});
  await driverJob({jobId: `${f.base}-bin-cargo`, stopType: 'pickup', details: mbt('cargo_pickup_1', ` ${f.returnRef.toLowerCase()} `), at: `${day}T16:30:00Z`});
  await driverJob({jobId: `${f.base}-bin-other`, stopType: 'pickup', details: mbt('cargo_pickup_1', f.customRef), at: `${day}T17:00:00Z`});
  const [row] = await listYardMovements({...range, direction: 'inbound', orderType: 'sor_return', search: f.returnRef});
  assert.equal(row.driver_record_count, 3);
  const detail = await getYardMovementDetail({...range, direction: 'inbound', orderType: 'sor_return', orderId: f.returnId});
  assert.equal(detail.driverRecords.length, 3);
  assert(detail.driverRecords.every(record => !String(record.job_id).endsWith('bin-collect')));
  const [custom] = await listYardMovements({...range, direction: 'outbound', orderType: 'custom_order', search: f.customRef});
  assert.equal(custom.driver_record_count, 1, 'Non-SOR BIN transport sources are not reinterpreted');
}));

test('Sales, Dispatch and CSV scopes place SOR records in the rental yard', async () => fixture(async f => {
  const sorKeys = [`inbound:sor_return:${f.returnId}`, `outbound:sor_order:${f.sorId}`].sort();
  const scoped = async scope => (await listYardMovements({...range, search: f.sorRef, ...scope})).map(keyOf).sort();
  assert.deepEqual(await scoped({allowedSalesStoreLocationIds: [1]}), sorKeys);
  assert.deepEqual(await scoped({allowedYardLocationIds: [1]}), sorKeys);
  for (const scope of [{allowedSalesStoreLocationIds: [28]}, {allowedSalesStoreLocationIds: []}, {allowedYardLocationIds: [26]}]) {
    assert.deepEqual(await scoped(scope), [], JSON.stringify(scope));
    assert.equal(await getYardMovementDetail({...range, direction: 'inbound', orderType: 'sor_return', orderId: f.returnId, ...scope}), null);
  }
  assert.equal((await getYardMovementDetail({...range, direction: 'outbound', orderType: 'sor_order', orderId: f.sorId,
    allowedSalesStoreLocationIds: [1]})).order.tranid, f.sorRef);
  const csv = await listYardMovementCsvRows({...range, search: f.sorRef, allowedSalesStoreLocationIds: [1]});
  assert.deepEqual([...new Set(csv.map(row => `${row.order_type}:${row.order_ref}:${row.sku}`))].sort(),
    [`sor_order:${f.sorRef}:${f.sku}`, `sor_return:${f.returnRef}:${f.sku}`].sort());
}));
