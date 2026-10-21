// Run through docker exec on stdin in /app. All operations are reads.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { config } from './src/config.js';
import { query, closeDb } from './src/db.js';
import { suiteqlAll } from './src/netsuite.js';
import { getNetSuiteM2mAccessToken } from './src/netsuite-m2m-runtime.js';
import { matchSpecialOrderCoverage } from './src/special-stock-request-domain.js';

try {
  const reps=await suiteqlAll("SELECT id, entityid AS name FROM employee WHERE issalesrep='T' AND isinactive='F' ORDER BY entityid, id");
  assert.ok(reps.length>0 && reps.every(rep=>Number(rep.id)>0 && rep.name));
  const special=(await query('SELECT sales_order_netsuite_id,sales_order_ref,purchase_order_netsuite_id,purchase_order_submission_started_at FROM sales_special_stock_cases WHERE request_id=67')).rows[0];
  assert.equal(special.sales_order_ref,'SOM06738');
  const expected=(await query("SELECT id,case_line_id,item_id,item_name,description,quantity,uom,remote_line_id FROM sales_special_stock_order_lines WHERE request_id=67 AND order_kind='sales_order' ORDER BY id")).rows;
  const canonical=(await query('SELECT id,line_id,item_id,item_type,item_name,item_description AS description,quantity,unit AS uom,netsuite_active AS active FROM sales_order_lines WHERE sales_order_id=$1 AND item_id IS NOT NULL ORDER BY id',[special.sales_order_netsuite_id])).rows;
  const nonMaterial = r => [10716,-2].includes(Number(r.item_id)) || ['DISCOUNT','SUBTOTAL'].includes(String(r.item_type||'').toUpperCase());
  const mappings=matchSpecialOrderCoverage(expected.map(r=>({id:Number(r.id),caseLineId:Number(r.case_line_id),itemId:Number(r.item_id),itemName:r.item_name,description:r.description,quantity:Number(r.quantity),uom:r.uom,remoteLineId:r.remote_line_id?Number(r.remote_line_id):null})),
    canonical.filter(r=>!nonMaterial(r)).map(r=>({id:Number(r.id),lineId:Number(r.line_id),itemId:Number(r.item_id),itemName:r.item_name,description:r.description,quantity:Number(r.quantity),uom:r.uom,active:r.active})),{orderKind:'sales_order'});
  const token=await getNetSuiteM2mAccessToken();
  const response=await fetch(config.netsuite.restBaseUrl+'/record/v1/salesOrder/'+Number(special.sales_order_netsuite_id)+'?expandSubResources=true',{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});
  assert.equal(response.status,200);
  const record=await response.json();
  const financial={discountItem:record.discountItem,discountRate:record.discountRate,
    salesRep:record.salesRep,item:record.item?.items?.map(l=>({line:l.line,item:l.item,quantity:l.quantity,rate:l.rate,amount:l.amount,units:l.units,description:l.description}))};
  console.log(JSON.stringify({readOnly:true,salesRepCount:reps.length,request:'SPREQ-000011',salesOrder:'SOM06738',
    materialsMatched:mappings.length,ignoredDiscountAndSubtotalRows:canonical.filter(nonMaterial).length,
    poSubmitted:Boolean(special.purchase_order_submission_started_at),poLinked:Boolean(special.purchase_order_netsuite_id),
    soFinancialHash:createHash('sha256').update(JSON.stringify(financial)).digest('hex')}));
} finally { await closeDb(); }
