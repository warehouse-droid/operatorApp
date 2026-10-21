import assert from 'node:assert/strict';

const materials = [
  [36,59,60,5065607,144,'Arcana MODENA 24 x 24 \n72.00SQFT/PLT','Arcana MODENA 24 x 24 72.00SQFT/PLT'],
  [37,61,62,5065608,162,'Arcana MODENA 18 x 24\n54SQFT/PLT','Arcana MODENA 18 x 24'],
  [38,63,64,5065609,108,'Arcana MODENA 12 x 24\n36SQFT/PLT','Arcana MODENA 12 x 24']
];

export function specialUnitRepairPlan({header,lines,orders,canonical,remote,units}) {
  assert.deepEqual([header.request_ref,Number(header.sales_order_netsuite_id),header.purchase_order_netsuite_id,header.close_status],['SPREQ-000024',1033108,null,'active']);
  assert.deepEqual([header.sales_order_operation_status,header.purchase_order_operation_status,header.quantity_review],['linked','idle',{}]);
  assert.deepEqual([remote.id,remote.ref,remote.customerId,remote.locationId],[1033108,'SOB121882',2008,1]);
  assert.equal(lines.length,3);assert.equal(orders.length,8);assert.equal(canonical.length,5);assert.equal(remote.lines.length,5);assert.equal(units.length,5);
  const orderIds=[],caseLineIds=[];
  for(const [caseId,soId,poId,remoteId,quantity,soDescription,poDescription] of materials) {
    const line=lines.find(row=>Number(row.id)===caseId);assert.ok(line);
    assert.deepEqual([Number(line.requested_quantity),line.requested_uom,line.original_rate_uom,Number(line.original_unit_rate),Number(line.sales_package_quantity),Number(line.pieces_per_unit),line.sales_uom,line.purchase_uom,Number(line.sales_quantity),Number(line.purchase_quantity)],
      [quantity,'SQFT','SQFT',17.95,quantity,1,'PC','PC',quantity,quantity]);
    for(const [id,kind,description,rate,remoteLineId] of [[soId,'sales_order',soDescription,17.95,remoteId],[poId,'purchase_order',poDescription,null,null]]) {
      const saved=orders.find(row=>Number(row.id)===id);assert.ok(saved);
      assert.deepEqual([Number(saved.case_line_id),saved.order_kind,Number(saved.item_id),saved.description,Number(saved.quantity),saved.uom,saved.unit_rate==null?null:Number(saved.unit_rate),saved.unit_purchase_cost,saved.remote_line_id==null?null:Number(saved.remote_line_id)],
        [caseId,kind,2055,description,quantity,'PC',rate,null,remoteLineId]);orderIds.push(id);
    }
    caseLineIds.push(caseId);
    const row=canonical.find(row=>Number(row.line_id)===remoteId);assert.ok(row);
    assert.deepEqual([Number(row.item_id),row.item_description,Number(row.quantity),row.unit,row.netsuite_active],[2055,soDescription,quantity,'SQFT',true]);
  }
  for(const [remoteId,itemId,quantity,rate,uom] of [[5065607,2055,144,17.95,'SQFT'],[5065608,2055,162,17.95,'SQFT'],[5065609,2055,108,17.95,'SQFT'],[5065610,1784,8,40,'EACH'],[5065720,1987,1,235,null]]) {
    const live=remote.lines.find(row=>row.remoteLineId===remoteId),unit=units.find(row=>Number(row.line_id)===remoteId),row=canonical.find(row=>Number(row.line_id)===remoteId);
    assert.ok(live);assert.ok(unit);assert.ok(row);
    assert.deepEqual([live.itemId,live.quantity,live.rate,live.open,live.locationId],[itemId,quantity,rate,true,1]);
    assert.deepEqual([Number(unit.item),Number(unit.quantity),unit.uom||null],[itemId,quantity,uom]);
    assert.deepEqual([Number(row.item_id),Number(row.quantity),row.unit||null,row.netsuite_active],[itemId,quantity,uom,true]);
    if(itemId!==2055) {
      const saved=orders.find(row=>Number(row.remote_line_id)===remoteId);assert.ok(saved);
      assert.deepEqual([saved.order_kind,Number(saved.item_id),Number(saved.quantity),saved.uom,Number(saved.unit_rate)],[ 'sales_order',itemId,quantity,uom,rate]);
    }
  }
  return {orderIds,caseLineIds,from:'PC',to:'SQFT'};
}

if(process.argv.includes('--read')||process.argv.includes('--apply')) {
  const {query,withTransaction,closeDb}=await import('../src/db.js');
  const {suiteqlAll,readRegularStockSalesOrderFromNetSuite}=await import('../src/netsuite.js');
  const {reconcileSpecialOrderWebhook}=await import('../src/special-stock-request-repository.js');
  const {writeFileSync}=await import('node:fs');
  try {
    const remote=await readRegularStockSalesOrderFromNetSuite('SOB121882');
    const units=await suiteqlAll("SELECT tl.uniquekey AS line_id,tl.item,ABS(tl.quantity) AS quantity,BUILTIN.DF(tl.units) AS uom FROM TransactionLine tl WHERE tl.transaction=1033108 AND tl.mainline='F' AND tl.item IN (2055,1784,1987) ORDER BY tl.uniquekey");
    const apply=process.argv.includes('--apply');
    const result=await withTransaction(async()=>{
      await query("SET LOCAL lock_timeout='5s'");await query("SET LOCAL statement_timeout='30s'");
      const header=(await query('SELECT r.request_ref,r.revision,c.* FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.id=95 FOR UPDATE OF r,c')).rows[0];
      const lines=(await query('SELECT * FROM sales_special_stock_lines WHERE request_id=95 ORDER BY id FOR UPDATE')).rows;
      const orders=(await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=95 ORDER BY id FOR UPDATE')).rows;
      const canonical=(await query('SELECT id,line_id,item_id,item_description,quantity,unit,netsuite_active FROM sales_order_lines WHERE sales_order_id=1033108 ORDER BY id FOR SHARE')).rows;
      const plan=specialUnitRepairPlan({header,lines,orders,canonical,remote,units});
      if(!apply)return {apply:false,revision:Number(header.revision),plan};
      writeFileSync('/tmp/special-unit-000024-before.json',JSON.stringify({header,lines,orders,canonical,remote,units,plan},null,2),{mode:0o600});
      await query("UPDATE sales_special_stock_order_lines SET uom='SQFT',updated_at=now() WHERE request_id=95 AND id=ANY($1::bigint[])",[plan.orderIds]);
      await query("UPDATE sales_special_stock_lines SET sales_uom='SQFT',purchase_uom='SQFT',updated_at=now() WHERE request_id=95 AND id=ANY($1::bigint[])",[plan.caseLineIds]);
      await query("INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,details,audience) VALUES(95,'special_unit_corrected',NULL,$1::jsonb,'all')",[JSON.stringify({source:'User requested SQFT correction after NetSuite unit change',salesOrderId:1033108,...plan,netsuiteWritten:false})]);
      const reconciled=await reconcileSpecialOrderWebhook({orderKind:'sales_order',orderId:1033108});assert.equal(reconciled.attention,false);
      const after=(await query('SELECT attention,attention_reason FROM sales_special_stock_cases WHERE request_id=95')).rows[0];assert.equal(after.attention,false);assert.equal(after.attention_reason,null);
      const changed=(await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=95 ORDER BY id')).rows;
      const strip=row=>{const {updated_at:time,...rest}=row;void time;return rest;};
      assert.deepEqual(changed.map(strip),orders.map(row=>strip({...row,...(plan.orderIds.includes(Number(row.id))?{uom:'SQFT'}:{})})));
      return {apply:true,requestRef:'SPREQ-000024',unit:'SQFT',materialOrderLines:6,caseLines:3,attention:false,deliveryFee:235,netsuiteWritten:false};
    });console.log(JSON.stringify(result));
  }finally{await closeDb();}
}
