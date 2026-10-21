import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {query,closeDb} from '../../src/db.js';
import {createBackorderUI} from '../../public/backorder-stock-requests.js';
try{
  assert.equal(typeof createBackorderUI,'function');
  assert.equal((await query("SELECT count(*)::int AS n FROM schema_migrations WHERE filename='269_backorder_line_routing.sql'")).rows[0].n,1);
  assert.equal((await query("SELECT count(*)::int AS n FROM sales_special_stock_lines line JOIN sales_special_stock_cases special ON special.request_id=line.request_id WHERE special.workflow_kind='backorder' AND line.backorder_destination_location_id IS NULL")).rows[0].n,0);
  const source=readFileSync('public/backorder-stock-requests.js','utf8');
  assert.ok(source.includes("const fulfillment={yard_pickup:'Pickup',mbt_delivery:'Delivery'}"));
  assert.ok(source.includes('data-sales-stock-field="destinationLocationId"'));assert.ok(source.includes('data-sales-stock-field="vendorName"'));assert.ok(source.includes('backorder-notes'));
  assert.ok(!source.includes('Unit sales price')&&!source.includes('Sales discount %'));
  for(const role of ['sales','scm']){const response=await fetch('http://127.0.0.1:3000/'+role+'/stock-requests');assert.equal(response.status,200);assert.ok((await response.text()).includes('backorder=20261007-v2'));}
  const response=await fetch('http://127.0.0.1:3000/backorder-stock-requests.js?v=20261007-v2');assert.equal(response.status,200);assert.equal(await response.text(),source);
  console.log(JSON.stringify({liveReadOnlyVerification:true,migration269:true,independentLineRouting:true,unpricedPickupDeliveryUI:true,cacheVersion:'20261007-v2'}));
}finally{await closeDb();}
