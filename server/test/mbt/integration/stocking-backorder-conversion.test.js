import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {app} from '../../../src/server.js';
import {query,withTransaction,closeDb} from '../../../src/db.js';
import {createOperator} from '../../../src/auth-repository.js';

const nativeFetch=globalThis.fetch,users={},requests=[],sku=88999801,other=88999802,run=randomUUID();
let server,base,outbound=0;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
  await query("INSERT INTO inventory_items(item_id,item_name,display_name,item_description,stock_unit,vendor,vendor_id,to_pcs,to_plt) VALUES($1,'CONVERT-STOCK-A','Material A','Saved A <script>literal</script>','EA','Vendor A',331,1,100),($2,'CONVERT-STOCK-B','Material B','Saved B','BAG','Vendor B',332,1,20)",[sku,other]);
  for(const item of [sku,other])for(const yard of [1,28,26])await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,$2,$3,1000,1000,now())",[item,yard,String(yard)]);
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,status_text,netsuite_active) VALUES(88999803,'CONVERT-PO','Closed',false)");
  server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));base=`http://127.0.0.1:${server.address().port}`;
  for(const [name,role,yards] of [['sales','sales',[26]],['foreign','sales',[15]],['destination','sales',[28]],['scm','scm',[]],['driver','dispatcher',[]]]){
    const username=`stocking-backorder-${name}-${run}`,password=randomUUID();users[name]=await createOperator({username,password,displayName:name,role,roles:[role],yardLocationIds:yards});
    const login=await http(null,'/api/auth/login',{username,password});assert.equal(login.status,200);users[name].token=login.body.token;
  }
  globalThis.fetch=async()=>{outbound++;throw Error('No external services during conversion');};
});
after(async()=>{
  globalThis.fetch=nativeFetch;server?.closeAllConnections();if(server)await new Promise(done=>server.close(done));
  await query('DELETE FROM regular_stock_so_line_owners WHERE request_id=ANY($1::bigint[])',[requests]);
  await query('DELETE FROM regular_stock_purchase_demands WHERE request_line_id IN (SELECT id FROM sales_stock_request_lines WHERE request_id=ANY($1::bigint[]))',[requests]);
  await query('DELETE FROM sales_stock_requests WHERE id=ANY($1::bigint[])',[requests]);
  await closeDb();
});
async function http(role,path,body){
  const r=await nativeFetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(role?{authorization:'Bearer '+users[role].token}:{}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await r.text();let payload;try{payload=JSON.parse(text);}catch{payload={text};}return {status:r.status,body:payload};
}
async function create(type='purchase',extra={}){
  const r=await http('sales','/api/sales/stock-requests',{workflowVersion:2,deliveryMethod:'stocking',stockingType:type,destinationLocationId:28,customerName:'Customer <b>literal</b>',remarks:'Preserve request remark',
    lines:[{itemId:sku,...(type==='transfer'?{sourceLocationId:1}:{}),pieces:23},{itemId:other,...(type==='transfer'?{sourceLocationId:1}:{}),pieces:7.25}],...extra});
  assert.equal(r.status,201,JSON.stringify(r.body));requests.push(r.body.id);return r.body;
}
const path=d=>`/api/scm/stock-requests/${d.id}/backorder-conversion`;
const convert=(d,extra={})=>http('scm',path(d),{expectedRevision:d.revision,fulfillmentMethod:'yard_pickup',requiredDate:'2099-10-08',...extra});
async function snapshot(id){const tables=['sales_stock_requests','sales_stock_request_lines','sales_stock_request_events','sales_special_stock_cases','sales_special_stock_lines','sales_special_stock_events'];const result={};for(const table of tables)result[table]=(await query(`SELECT * FROM ${table} WHERE ${table==='sales_stock_requests'?'id':'request_id'}=$1 ORDER BY ${table==='sales_special_stock_cases'?'request_id':'id'}`,[id])).rows;return result;}

test('SCM converts the entire Stocking Transfer or Purchase in place with original identity and audit history',async()=>{
  for(const type of ['transfer','purchase']){
    const source=await create(type),before=await snapshot(source.id),calls=outbound;
    const preview=await http('scm',path(source));assert.equal(preview.status,200,JSON.stringify(preview.body));assert.equal(preview.body.revision,source.revision);
    assert.deepEqual(preview.body.lines.map(line=>[line.stockingLineId,line.quantity,line.uom,line.vendorName,line.destinationLocationId]),source.lines.map((line,index)=>[line.id,line.salesQty,line.salesUom,index?'Vendor B':'Vendor A',line.destinationLocationId]));
    const r=await convert(source);assert.equal(r.status,200,JSON.stringify(r.body));const d=r.body;
    assert.equal(d.id,source.id);assert.equal(d.requestRef,source.requestRef);assert.equal(d.requestedBy,source.requestedBy);assert.equal(d.createdAt,source.createdAt);assert.equal(d.revision,source.revision+1);
    assert.equal(d.workflowKind,'backorder');assert.equal(d.regular.deliveryMethod,'backorder');assert.equal(d.stage,'new_enquiry');assert.equal(d.customerName,source.regular.customerName);assert.equal(d.remarks,source.remarks);
    assert.equal(d.storeLocationId,26);assert.deepEqual(d.lines.map(line=>[line.itemId,line.quantity,line.uom,line.destinationLocationId]),source.lines.map(line=>[line.itemId,line.salesQty,line.salesUom,line.destinationLocationId]));
    assert.deepEqual(d.lines.map(line=>line.detailSpec),source.lines.map(line=>line.itemDescription));assert.deepEqual(d.lines.map(line=>line.salesDecision),['pending','pending']);assert.ok(d.lines.every(line=>!line.stockCheckedAt));
    assert.equal(d.salesOrderId,null);assert.equal(d.purchaseOrderId,null);assert.equal(d.palletTotal,null);assert.equal(d.deliveryFeeRate,null);assert.deepEqual(d.transfers,[]);assert.ok(d.lines.every(line=>line.originalRate===null));
    const after=await snapshot(source.id);assert.deepEqual(after.sales_stock_request_events,before.sales_stock_request_events);assert.ok(after.sales_special_stock_lines.every(line=>line.original_unit_rate===null));
    for(const [index,row] of after.sales_stock_request_lines.entries()){const original=before.sales_stock_request_lines[index];assert.equal(row.status,'cancelled');for(const key of Object.keys(original).filter(key=>!['status','updated_at'].includes(key)))assert.deepEqual(row[key],original[key],key);}
    assert.deepEqual(after.sales_stock_requests[0].regular_details.stockingConversion.originalRegular,before.sales_stock_requests[0].regular_details);
    assert.ok(d.events.some(event=>event.eventType==='backorder_converted_from_stocking'));for(const event of before.sales_stock_request_events)assert.ok(d.events.some(row=>row.eventType===event.event_type));
    assert.equal(outbound,calls);assert.equal((await query('SELECT count(*)::int AS n FROM sales_stock_requests WHERE request_ref=$1',[source.requestRef])).rows[0].n,1);
    for(const role of ['sales','scm']){const list=await http(role,`/api/${role}/stock-requests?type=backorder&search=${source.requestRef}`);assert.equal(list.status,200);assert.ok(list.body.requests.some(row=>row.id===source.id));}
  }
});
test('conversion preserves saved quantities and UOM after item conversion factors or descriptions change',async()=>{
  const source=await create();await query("UPDATE inventory_items SET stock_unit='BAG',to_pcs=9,to_plt=200,item_description='New description' WHERE item_id=$1",[sku]);
  try{const r=await convert(source);assert.equal(r.status,200);assert.equal(r.body.lines[0].quantity,source.lines[0].salesQty);assert.equal(r.body.lines[0].uom,'EA');assert.equal(r.body.lines[0].detailSpec,source.lines[0].itemDescription);assert.equal(r.body.lines[0].pieceQty,source.lines[0].pieces);}finally{await query("UPDATE inventory_items SET stock_unit='EA',to_pcs=1,to_plt=100,item_description='Saved A <script>literal</script>' WHERE item_id=$1",[sku]);}
});
test('Sales can revise a converted material while preserving its existing receiving yard outside the inquiry store',async()=>{
  const source=await create(),r=await convert(source);assert.equal(r.status,200);const d=r.body,line=d.lines[0];
  const beforeSales=(await http('sales','/api/sales/stock-requests/'+d.id)).body;
  const sibling=(await query('SELECT * FROM sales_special_stock_lines WHERE id=$1',[d.lines[1].id])).rows[0];
  const saved=await http('sales',`/api/sales/stock-requests/${d.id}/backorder/lines/${line.id}/edit`,{expectedRevision:d.revision,quantity:line.quantity+1,destinationLocationId:28});
  assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.lines[0].quantity,line.quantity+1);assert.equal(saved.body.lines[0].destinationLocationId,28);assert.deepEqual(saved.body.lines[1],beforeSales.lines[1]);assert.deepEqual((await query('SELECT * FROM sales_special_stock_lines WHERE id=$1',[d.lines[1].id])).rows[0],sibling);
  const forbidden=await http('sales',`/api/sales/stock-requests/${d.id}/backorder/lines/${line.id}/edit`,{expectedRevision:saved.body.revision,quantity:30,destinationLocationId:15});assert.equal(forbidden.status,403);
});
test('only SCM can convert and original Sales yard retains access independently of receiving yard',async()=>{
  const d=await create(),before=await snapshot(d.id);
  for(const role of [null,'sales','foreign','driver']){assert.ok([401,403].includes((await http(role,path(d),{expectedRevision:d.revision,fulfillmentMethod:'yard_pickup'})).status));assert.ok([401,403].includes((await http(role,path(d))).status));assert.deepEqual(await snapshot(d.id),before);}
  const r=await convert(d);assert.equal(r.status,200);
  assert.equal((await http('sales','/api/sales/stock-requests/'+d.id)).status,200);for(const role of ['foreign','destination'])assert.equal((await http(role,'/api/sales/stock-requests/'+d.id)).status,403);
  const edit=await http('sales',`/api/sales/stock-requests/${d.id}/backorder/header`,{expectedRevision:r.body.revision,customerName:'Updated customer'});assert.equal(edit.status,200);assert.equal(edit.body.customerName,'Updated customer');
});
test('invalid revision, delivery details and material vendor input leave Stocking rows unchanged',async()=>{
  const d=await create(),before=await snapshot(d.id);
  for(const revision of [undefined,null,true,[],{},0,-1,1.5,'1e0',d.revision+1]){const r=await convert(d,{expectedRevision:revision});assert.ok([400,409].includes(r.status),JSON.stringify(r));assert.deepEqual(await snapshot(d.id),before);}
  for(const input of [{fulfillmentMethod:'vendor_pickup'},{fulfillmentMethod:'mbt_delivery',deliveryAddress:''},{vendors:[{stockingLineId:999,vendorName:'Unknown'}]},{vendors:[{stockingLineId:d.lines[0].id,vendorName:''}]},{vendors:[{stockingLineId:d.lines[0].id,vendorName:'x'.repeat(201)}]},{requiredDate:'2020-01-01'}]){assert.ok([400,409].includes((await convert(d,input)).status));assert.deepEqual(await snapshot(d.id),before);}
});
test('Delivery conversion carries fulfillment details and confirmed per-line vendors without prices or generated orders',async()=>{
  const d=await create();const r=await convert(d,{fulfillmentMethod:'mbt_delivery',deliveryAddress:'100 Test Road',deliveryContactName:'Contact',deliveryContactPhone:'555-1234',deliveryDate:'2099-10-08',windowStart:'09:00',windowEnd:'13:00',deliveryInstructions:'Call before delivery',vendors:[{stockingLineId:d.lines[0].id,vendorName:'Alternate vendor'}]});
  assert.equal(r.status,200);assert.equal(r.body.fulfillmentMethod,'mbt_delivery');assert.equal(r.body.deliveryAddress,'100 Test Road');assert.equal(r.body.windowStart,'09:00');assert.equal(r.body.windowEnd,'13:00');assert.equal(r.body.deliveryInstructions,'Call before delivery');assert.equal(r.body.lines[0].vendorName,'Alternate vendor');assert.equal(r.body.lines[0].vendorId,null);assert.equal(r.body.lines[1].vendorName,'Vendor B');
});
test('conversion rejects terminal, partially resolved, rejected and already committed Stocking requests without writes',async()=>{
  for(const kind of ['completed','cancelled','closed-line','rejected-line','resolution','pickupTransfer','handoffStatus','purchase-demand','so-owner','existing-case']){
    let d=await create();
    if(['completed','cancelled'].includes(kind))await query('UPDATE sales_stock_requests SET status=$2 WHERE id=$1',[d.id,kind]);
    else if(kind.endsWith('-line'))await query('UPDATE sales_stock_request_lines SET status=$2 WHERE id=$1',[d.lines[0].id,kind==='closed-line'?'closed':'rejected']);
    else if(['resolution','pickupTransfer','handoffStatus'].includes(kind))await query('UPDATE sales_stock_requests SET regular_details=regular_details||$2::jsonb WHERE id=$1',[d.id,JSON.stringify({[kind]:kind==='handoffStatus'?'running':{status:'complete'}})]);
    else if(kind==='purchase-demand')await query(`INSERT INTO regular_stock_purchase_demands(request_line_id,vendor_yard_id,vendor_id,policy_snapshot,requested_quantity,reviewed_quantity,approved_quantity,to_plt,accepted_by) VALUES($1,331,331,'{}',23,23,100,100,$2)`,[d.lines[0].id,users.scm.id]);
    else if(kind==='so-owner')await query('INSERT INTO regular_stock_so_line_owners(sales_order_id,remote_line_id,request_id) VALUES($1,1,$2)',[d.id+8000000,d.id]);
    else {const existing=await convert(d);assert.equal(existing.status,200);d=existing.body;}
    const before=await snapshot(d.id);assert.equal((await convert(d)).status,409,kind);assert.deepEqual(await snapshot(d.id),before);
  }
});
test('two simultaneous conversions produce one success, one conflict and one case on the original request',async()=>{
  const d=await create(),responses=await Promise.all([convert(d),convert(d)]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  assert.equal((await query('SELECT count(*)::int AS n FROM sales_special_stock_cases WHERE request_id=$1',[d.id])).rows[0].n,1);assert.equal((await query('SELECT count(*)::int AS n FROM sales_special_stock_lines WHERE request_id=$1',[d.id])).rows[0].n,d.lines.length);
  const saved=await snapshot(d.id);assert.equal((await convert(responses.find(r=>r.status===200).body)).status,409);assert.deepEqual(await snapshot(d.id),saved);
});
test('a concurrent Stocking commitment is retained and conversion checks it after obtaining the request lock',async()=>{
  const d=await create();let started,release;const locked=new Promise(resolve=>started=resolve),allowCommit=new Promise(resolve=>release=resolve);
  const commitment=withTransaction(async()=>{await query('SELECT id FROM sales_stock_requests WHERE id=$1 FOR UPDATE',[d.id]);started();await allowCommit;await query('INSERT INTO regular_stock_so_line_owners(sales_order_id,remote_line_id,request_id) VALUES($1,1,$2)',[d.id+9000000,d.id]);});
  await locked;const response=convert(d);release();await commitment;const before=await snapshot(d.id);assert.equal((await response).status,409);assert.deepEqual(await snapshot(d.id),before);
});
test('a database failure after creating Backorder materials rolls back the whole conversion',async()=>{
  const d=await create(),before=await snapshot(d.id);
  await query(`CREATE FUNCTION fail_stocking_conversion_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id=${d.id} AND NEW.event_type='backorder_converted_from_stocking' THEN RAISE EXCEPTION 'Injected conversion failure'; END IF; RETURN NEW; END $$`);
  await query('CREATE TRIGGER fail_stocking_conversion_test BEFORE INSERT ON sales_special_stock_events FOR EACH ROW EXECUTE FUNCTION fail_stocking_conversion_test()');
  try{assert.equal((await convert(d)).status,500);assert.deepEqual(await snapshot(d.id),before);}finally{await query('DROP TRIGGER fail_stocking_conversion_test ON sales_special_stock_events');await query('DROP FUNCTION fail_stocking_conversion_test()');}
});
test('previous Stocking notification reads cannot suppress new Backorder review or PO-linked notifications',async()=>{
  for(let n=0;n<5;n++)await create();let d=await create();
  const replied=await http('scm',`/api/scm/stock-requests/${d.id}/reply`,{lineId:d.lines[0].id,expectedRevision:d.revision,message:'Stocking instruction already read'});assert.equal(replied.status,200);d=replied.body;
  const seen=await http('sales',`/api/sales/stock-requests/${d.id}/decisions/read`,{eventId:d.manualDecisionEventId});assert.equal(seen.status,200);
  const oldReads=(await query('SELECT * FROM regular_stock_decision_reads WHERE request_id=$1',[d.id])).rows;assert.equal(oldReads.length,1);
  const converted=await convert(d);assert.equal(converted.status,200);d=converted.body;assert.ok(Number(oldReads[0].event_id)>d.revision);
  for(const line of d.lines){const r=await http('scm',`/api/scm/stock-requests/${d.id}/backorder/lines/${line.id}/response`,{expectedRevision:d.revision,supplyStatus:'production',availabilityMode:'dated',availableDate:'2099-10-08',vendorId:331,vendorName:'Vendor A',vendorYard:'Vendor yard'});assert.equal(r.status,200);d=r.body;}
  assert.ok((await http('sales','/api/sales/stock-requests/alerts')).body.requests.some(row=>row.id===d.id));
  for(const line of d.lines){const r=await http('sales',`/api/sales/stock-requests/${d.id}/backorder/lines/${line.id}/decision`,{expectedRevision:d.revision,decision:'accepted'});assert.equal(r.status,200);d=r.body;}
  const linked=await http('scm',`/api/scm/stock-requests/${d.id}/backorder/purchase-order/link`,{expectedRevision:d.revision,purchaseOrderRef:'CONVERT-PO'});assert.equal(linked.status,200);d=linked.body;
  const notice=(await http('sales','/api/sales/stock-requests/alerts')).body.requests.find(row=>row.id===d.id);assert.ok(notice);assert.equal(notice.purchaseOrderRef,'CONVERT-PO');
  const original=(await query('SELECT regular_details FROM sales_stock_requests WHERE id=$1',[d.id])).rows[0].regular_details.stockingConversion.originalDecisionReads;assert.deepEqual(JSON.parse(JSON.stringify(original)),JSON.parse(JSON.stringify(oldReads)));
});
test('old Stocking actions cannot mutate a converted Backorder and it follows the standard Backorder review sequence',async()=>{
  const d=await create(),converted=await convert(d);assert.equal(converted.status,200);let back=converted.body;const before=await snapshot(d.id);
  for(const [action,input] of [['line-decisions',{lineIds:[d.lines[0].id],decision:'reject',reason:'Old action'}],['resolve',{lineId:d.lines[0].id,purchaseOrderRef:'PO-OLD',eta:'2099-10-08'}],['reply',{lineId:d.lines[0].id,message:'Old reply'}],['purchase-proposals',{lines:[{lineId:d.lines[0].id,reviewedSalesQty:10}]}],['pickup-convert',{}]]){assert.equal((await http('scm',`/api/scm/stock-requests/${d.id}/${action}`,{expectedRevision:back.revision,...input})).status,409,action);assert.deepEqual(await snapshot(d.id),before);}
  for(const line of back.lines){const r=await http('scm',`/api/scm/stock-requests/${d.id}/backorder/lines/${line.id}/response`,{expectedRevision:back.revision,supplyStatus:'production',availabilityMode:'dated',availableDate:'2099-10-08',vendorId:331,vendorName:'Vendor A',vendorYard:'Vendor yard'});assert.equal(r.status,200);back=r.body;}
  for(const line of back.lines){const r=await http('sales',`/api/sales/stock-requests/${d.id}/backorder/lines/${line.id}/decision`,{expectedRevision:back.revision,decision:'accepted'});assert.equal(r.status,200);back=r.body;}
  assert.equal(back.stage,'confirmed');assert.equal((await query('SELECT stage FROM special_stock_workflow_stages WHERE request_id=$1',[d.id])).rows[0].stage,'confirmed');
});
