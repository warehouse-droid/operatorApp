import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {query,closeDb} from '../../src/db.js';
import {convertStockingToBackorder,previewStockingBackorderConversion} from '../../src/stocking-backorder-conversion.js';
import {getBackorderRequest} from '../../src/backorder-request-service.js';
import {canConvertStockingToBackorder,stockingBackorderMaterials} from '../../public/stocking-backorder-conversion.js';

try {
  assert.equal(typeof convertStockingToBackorder,'function');assert.equal(typeof previewStockingBackorderConversion,'function');
  const source={requestType:'regular',workflowVersion:2,status:'submitted',regular:{deliveryMethod:'stocking'},lines:[{id:1,status:'submitted'},{id:2,status:'approved'}]};
  assert.equal(canConvertStockingToBackorder(source),true);assert.equal(canConvertStockingToBackorder({...source,status:'completed'}),false);
  const material=stockingBackorderMaterials([{id:1,item_id:999,item_name:'Saved SKU',item_description:'Saved description',sales_qty:7.25,sales_uom:'EA',destination_location_id:28}],new Map([[999,{vendor:'Saved vendor',vendor_id:331,to_pcs:999,stock_unit:'Changed unit'}]]),{requiredDate:'2099-10-08'});
  assert.equal(material[0].quantity,7.25);assert.equal(material[0].uom,'EA');assert.equal(material[0].destinationLocationId,28);
  for(const method of ['GET','POST']){const response=await fetch('http://127.0.0.1:3000/api/scm/stock-requests/0/backorder-conversion',{method,...(method==='POST'?{headers:{'content-type':'application/json'},body:'{}'}:{})});assert.ok([401,403].includes(response.status));}
  for(const name of ['stocking-backorder-conversion.js','stocking-backorder-conversion-ui.js','backorder-stock-requests.js','scm-stock-requests.js']){const response=await fetch('http://127.0.0.1:3000/'+name+'?v=20261007-v4');assert.equal(response.status,200);assert.equal(await response.text(),readFileSync('public/'+name,'utf8'));}
  for(const role of ['sales','scm']){const response=await fetch('http://127.0.0.1:3000/'+role+'/stock-requests');assert.equal(response.status,200);assert.ok((await response.text()).includes('backorder=20261007-v4'));}
  const rows=(await query("SELECT s.request_id,w.stage FROM sales_special_stock_cases s JOIN special_stock_workflow_stages w ON w.request_id=s.request_id WHERE s.workflow_kind='backorder' ORDER BY s.request_id")).rows;
  for(const row of rows)assert.equal((await getBackorderRequest(row.request_id,{audience:'scm'})).stage,row.stage);
  console.log(JSON.stringify({liveReadOnlyVerification:true,conversionRoutesAuthenticated:true,servedConversionFilesVerified:true,liveBackordersVerified:rows.length,cacheVersion:'20261007-v4',productionRequestsConvertedDuringValidation:0}));
}finally{await closeDb();}
