import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import fc from 'fast-check';
import {beginRollbackContext, query, closeDb} from '../../../src/db.js';
import {createSpecialStockCase, listSpecialStockCases} from '../../../src/special-stock-request-repository.js';
import {createSalesStockRequest, listSalesStockRequests, listScmStockRequests} from '../../../src/stock-request-repository.js';
after(closeDb);

async function fixture(run) {
  const tx = await beginRollbackContext();
  try { await tx.run(async () => {
    await query("INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,yard_location_ids) VALUES('yard-selection-test','yard-selection-test','TEST','hash','salt','sales',ARRAY['sales'],ARRAY[1,28,15]) ON CONFLICT DO NOTHING");
    const special = [];
    for (const yard of [1,28,15]) special.push(await createSpecialStockCase({storeLocationId:yard,inquiryDate:'2099-01-01',customerName:'TEST Multiple Yard Selection',vendorName:'TEST vendor',fulfillmentMethod:'yard_pickup',lines:[{productName:'TEST item',quantity:2,uom:'PCS',rate:100,requiredDate:'2099-02-01'}]}, {operatorId:'yard-selection-test',authorizedStoreLocationIds:[1,28,15]}));
    await run(special);
  }); } finally { await tx.rollback(); }
}
const search = 'TEST Multiple Yard Selection';
const ids = rows => rows.map(row => row.id).sort((a,b) => a-b);

test('Special multiple yards filter exactly and retain the Sales authorization intersection', () => fixture(async cases => {
  assert.deepEqual(ids(await listSpecialStockCases({search,storeLocationIds:'1,28'})), ids(cases.slice(0,2)));
  assert.deepEqual(ids(await listSpecialStockCases({search,audience:'sales',authorizedStoreLocationIds:[1,15],storeLocationIds:[1,28]})), ids(cases.slice(0,1)));
  assert.deepEqual(await listSpecialStockCases({search,authorizedStoreLocationIds:[],storeLocationIds:[1,28]}), []);
  assert.deepEqual(ids(await listSpecialStockCases({search,storeLocationIds:[]})), ids(cases));
  assert.deepEqual(ids(await listSpecialStockCases({search,storeLocationId:28,storeLocationIds:'1,28'})), ids([cases[1]]));
  for (const storeLocationIds of ['bad','1,',[-1],[1.5],{},[true],['1,28'],Array(65).fill(1)]) {
    await assert.rejects(listSpecialStockCases({search,storeLocationIds}), {status:400});
  }
}));

test('property: selected yards never widen Sales scope, including duplicate and empty filters', () => fixture(async cases => {
  await fc.assert(fc.asyncProperty(fc.subarray([1,28,15]),fc.array(fc.constantFrom(1,28,15),{maxLength:6}),async (allowed,selected) => {
    const actual = await listSpecialStockCases({search,audience:'sales',authorizedStoreLocationIds:allowed,storeLocationIds:selected});
    assert.deepEqual(ids(actual), ids(cases.filter(row => allowed.includes(row.storeLocationId) && (!selected.length || selected.includes(row.storeLocationId)))));
  }),{seed:270927,numRuns:25});
}));

test('Regular source and destination selections combine without widening Sales access', () => fixture(async () => {
  const itemId = 9900927001;
  await query("INSERT INTO inventory_items(item_id,item_name,item_description,stock_unit) VALUES($1,'MULTI-YARD-TEST','TEST Multiple Yard Selection','EA')",[itemId]);
  for (const yard of [1,28,15]) await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_on_hand,quantity_available,synced_at) VALUES($1,$2,$3,100,100,now())",[itemId,yard,String(yard)]);
  const cases=[];
  for (const [destination,source] of [[1,28],[1,15],[28,15]]) cases.push(await createSalesStockRequest({destinationLocationId:destination,lines:[{itemId,sourceLocationId:source,salesQty:1}]},{operatorId:'yard-selection-test',authorizedDestinationLocationIds:[1,28]}));
  assert.deepEqual(ids(await listScmStockRequests({search,sourceLocationIds:[28]})),ids([cases[0]]));
  assert.deepEqual(ids(await listScmStockRequests({search,sourceLocationIds:'15,28',destinationLocationIds:'1'})),ids(cases.slice(0,2)));
  assert.deepEqual(ids(await listScmStockRequests({search,sourceLocationIds:[15],destinationLocationIds:[1,28]})),ids(cases.slice(1)));
  assert.deepEqual(ids(await listSalesStockRequests({search,authorizedDestinationLocationIds:[1],sourceLocationIds:[15,28]})),ids(cases.slice(0,2)));
  assert.deepEqual(ids(await listSalesStockRequests({search,authorizedDestinationLocationIds:[1],sourceLocationIds:[15]})),ids([cases[1]]));
  assert.deepEqual(ids(await listScmStockRequests({search,sourceLocationId:28,sourceLocationIds:[15,28]})),ids([cases[0]]));
  assert.deepEqual(ids(await listScmStockRequests({search,destinationLocationId:28,destinationLocationIds:[1,28]})),ids([cases[2]]));
  for (const selection of ['nope',[999999],[''],[0]]) await assert.rejects(listScmStockRequests({search,sourceLocationIds:selection}), {status:400});
  await assert.rejects(listScmStockRequests({search,destinationLocationIds:[999999]}),{status:400});
}));
