import assert from 'node:assert/strict';
const expected = [
 [5065607,2055,144,17.95,'Arcana MODENA 24 x 24 72.00SQFT/PLT','Arcana MODENA 24 x 24 \n72.00SQFT/PLT','PC'],
 [5065608,2055,162,17.95,'Arcana MODENA 18 x 24','Arcana MODENA 18 x 24\n54SQFT/PLT','PC'],
 [5065609,2055,108,17.95,'Arcana MODENA 12 x 24','Arcana MODENA 12 x 24\n36SQFT/PLT','PC'],
 [5065610,1784,8,40,'PALLET','PALLET','EACH'],
 [5065720,1987,1,235,'','','']
];
export function repairPlan({saved,canonical,remote}) {
 assert.deepEqual([remote.id,remote.ref,remote.customerId,remote.locationId],[1033108,'SOB121882',2008,1]);
 assert.equal(saved.length,4);assert.equal(canonical.length,5);assert.equal(remote.lines.length,5);
 const descriptions=[];
 for(const [remoteLineId,itemId,quantity,rate,before,after,uom] of expected){
  const rows=canonical.filter(l=>Number(l.lineId)===remoteLineId), live=remote.lines.filter(l=>l.remoteLineId===remoteLineId);
  assert.equal(rows.length,1);assert.equal(live.length,1);
  const row=rows[0],line=live[0];
  assert.deepEqual([Number(row.itemId),Number(row.quantity),row.description||'',row.uom||'',row.active],[itemId,quantity,after,uom,true]);
  assert.deepEqual([line.itemId,line.quantity,line.rate,line.open,line.locationId],[itemId,quantity,rate,true,1]);
  if(itemId!==1987){
   const original=saved.filter(l=>Number(l.remoteLineId)===remoteLineId);assert.equal(original.length,1);
   assert.deepEqual([Number(original[0].itemId),Number(original[0].quantity),Number(original[0].rate),original[0].description],[itemId,quantity,rate,before]);
   if(before!==after)descriptions.push({id:Number(original[0].id),remoteLineId,before,after});
  }
 }
 return {descriptions,delivery:{itemId:1987,remoteLineId:5065720,quantity:1,rate:235,uom:null,description:''}};
}

if(process.argv.includes('--read') || process.argv.includes('--apply')) {
 const {query,withTransaction,closeDb}=await import('../src/db.js');
 const {readRegularStockSalesOrderFromNetSuite}=await import('../src/netsuite.js');
 const {reconcileSpecialOrderWebhook}=await import('../src/special-stock-request-repository.js');
 const {writeFileSync}=await import('node:fs');
 try {
  const remote=await readRegularStockSalesOrderFromNetSuite('SOB121882');
  const apply=process.argv.includes('--apply');
  const result=await withTransaction(async()=>{
   await query("SET LOCAL lock_timeout='5s'");await query("SET LOCAL statement_timeout='30s'");
   const header=(await query(`SELECT r.request_ref,r.revision,c.* FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.id=95 FOR UPDATE OF r,c`)).rows[0];
   assert.equal(header.request_ref,'SPREQ-000024');assert.equal(Number(header.sales_order_netsuite_id),1033108);
   assert.equal(header.purchase_order_netsuite_id,null);assert.equal(header.close_status,'active');assert.equal(header.attention,true);
   assert.match(header.attention_reason,/exact reviewed item, quantity, UOM, and description/);
   assert.equal(header.sales_order_operation_status,'linked');assert.equal(header.purchase_order_operation_status,'idle');
   const raw=(await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=95 ORDER BY id FOR UPDATE')).rows;
   const canonical=(await query(`SELECT id,line_id AS "lineId",item_id AS "itemId",item_description AS description,quantity,unit AS uom,netsuite_active AS active FROM sales_order_lines WHERE sales_order_id=1033108 ORDER BY id FOR SHARE`)).rows;
   const saved=raw.filter(l=>l.order_kind==='sales_order').map(l=>({id:l.id,remoteLineId:l.remote_line_id,itemId:l.item_id,quantity:l.quantity,rate:l.unit_rate,description:l.description}));
   const plan=repairPlan({saved,canonical,remote});
   if(!apply)return {apply:false,revision:Number(header.revision),plan};
   writeFileSync('/tmp/special-delivery-fee-000024-before.json',JSON.stringify({header,raw,canonical,remote,plan},null,2),{mode:0o600});
   for(const change of plan.descriptions)await query('UPDATE sales_special_stock_order_lines SET description=$2,updated_at=now() WHERE request_id=95 AND id=$1',[change.id,change.after]);
   await query(`INSERT INTO sales_special_stock_order_lines(request_id,order_kind,ancillary,item_id,item_name,description,quantity,uom,unit_rate,remote_line_id) VALUES(95,'sales_order',true,1987,'Delivery Charge','',1,NULL,235,5065720)`);
   await query(`INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,details,audience) VALUES(95,'special_existing_delivery_charge_reconciled',NULL,$1::jsonb,'all')`,[JSON.stringify({source:'User requested reconciliation of existing NetSuite charge',salesOrderId:1033108,deliveryFee:235,descriptions:plan.descriptions,netsuiteWritten:false})]);
   const reconciled=await reconcileSpecialOrderWebhook({orderKind:'sales_order',orderId:1033108});assert.equal(reconciled.attention,false);
   const after=(await query('SELECT attention,attention_reason FROM sales_special_stock_cases WHERE request_id=95')).rows[0];assert.equal(after.attention,false);assert.equal(after.attention_reason,null);
   const purchase=(await query("SELECT * FROM sales_special_stock_order_lines WHERE request_id=95 AND order_kind='purchase_order' ORDER BY id")).rows;
   assert.deepEqual(purchase,raw.filter(l=>l.order_kind==='purchase_order'));
   return {apply:true,requestRef:'SPREQ-000024',salesOrderRef:'SOB121882',deliveryFee:235,attention:false,netsuiteWritten:false,purchaseLinesUnchanged:true};
  });
  console.log(JSON.stringify(result));
 }finally{await closeDb();}
}
