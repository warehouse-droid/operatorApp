import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {query,closeDb} from '../../../src/db.js';
import {config} from '../../../src/config.js';
import {submitRegularStockRequest} from '../../../src/regular-stock-request-service.js';
import {linkRegularStockSalesOrder} from '../../../src/regular-stock-handoff.js';
import {getScmStockRequest,convertSalesStockRequestLines} from '../../../src/stock-request-repository.js';
import {STOCK_REQUEST_YARDS} from '../../../src/stock-request-domain.js';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {refreshStockRequestItemsAvailability} from '../../../src/stock-request-service.js';
import {updateYardPrinter,rotateYardPrinterToken} from '../../../src/smart-scm-print-repository.js';

// Stub HTTP transport only. The real NetSuite adapters, transfer confirmation,
// mirroring, dependency repository and request transactions execute below.
const actor=`regular-external-${randomUUID()}`,itemId=1800000055;
const context={operatorId:actor,authorizedDestinationLocationIds:[28],allowOverAvailability:true};
const originalFetch=globalThis.fetch,oldNetSuite={...config.netsuite},oldLive=config.smartScm.liveExecutionEnabled;
let remote,token,server,base,authToken;
async function http(path,body,expectedStatus=200){
 const response=await originalFetch(`${base}${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(authToken?{Authorization:`Bearer ${authToken}`}:{})},body:JSON.stringify(body)});
 const data=await response.json();assert.equal(response.status,expectedStatus,JSON.stringify(data));return data;
}
const json=data=>new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
const rawLines=()=>remote.materials.map((line,index)=>({id:remote.id,tranid:remote.ref,status:'B',order_location_id:28,customer_id:42,
 line_id:remote.id*10+index+1,rest_line_id:index+1,item_id:line.itemId,item_name:`External fixture ${line.itemId}`,item_type:'InvtPart',
 quantity:-line.quantity,backordered_quantity:line.backorderedQuantity??150,stock_unit:'EA',location_id:line.locationId,fulfilled_quantity:0,billed_quantity:0,line_closed:'F',
 unit:'EA',netsuite_backordered_qty:150,netsuite_committed_qty:50,netsuite_received_qty:0,
 to_plt:100,to_pcs:1,item_weight:20,piece_qty:line.quantity}));
const transferHeader=()=>({id:remote.toId,tranid:`TO-${remote.toId}`,status:'B',status_text:'Pending Fulfillment',trandate:'2026-09-29',
 source_location_id:1,source_location:'3445',destination_location_id:28,destination_location:'2967',memo:remote.transfer?.memo});
function queryRows(sql){
 if(sql.includes('FROM location l'))return STOCK_REQUEST_YARDS.map(({locationId:id,yardCode:name})=>({id,name,fullname:name,subsidiary:1,isinactive:'F'}));
 if(sql.includes('AS rest_line_id'))return rawLines();
 if(sql.includes('MBBS-STOCK-REQUEST-TO:')){
   const marker=sql.match(/MBBS-STOCK-REQUEST-TO:\d+/)[0];
   const externalId=sql.match(/UPPER\(t\.externalid\) = '([^']+)'/)?.[1];
   const memo=remote.transfer?.memo?.toUpperCase()||'';
   return remote.transfer&&(memo.endsWith(marker)||memo.includes(marker+' |')||
     externalId&&remote.transfer.externalId.toUpperCase()===externalId)?[transferHeader()]:[];
 }
 if(sql.includes("t.type = 'TrnfrOrd'"))return [transferHeader()];
 if(sql.includes('FROM AggregateItemLocation'))return [1,28,7].map(location_id=>({item_id:itemId,item_name:'External fixture',stock_unit:'EA',to_pcs:1,to_plt:100,item_weight:20,location_id,quantity_available:800,quantity_on_hand:1000,quantity_on_order:0}));
 if(sql.includes('FROM transactionline tl')){
   if(sql.includes(`tl.transaction = ${remote.toId}`))return remote.transfer.item.items.flatMap((line,index)=>[1,28].map(location_id=>({
     line_id:remote.toId*10+index*2+(location_id===1?1:2),order_line_number:index+1,line_sequence_number:index+1,
     item_id:Number(line.item.id),item_name:Number(line.item.id)===itemId?'External fixture':'PALLET',item_type:'InvtPart',
     quantity:Number(line.quantity)*(location_id===1?-1:1),unit:'EA',location_id,to_plt:100,to_pcs:1,item_weight:20,netsuite_received_qty:0,piece_qty:Number(line.quantity)})));
   return rawLines();
 }
 if(sql.includes("t.type = 'SalesOrd'"))return [{id:remote.id,tranid:remote.ref,customer_id:42,customer:'External fixture customer',status:'B',status_text:'Pending Fulfillment',trandate:'2026-09-29',
   order_location_id:28,order_location:'2967',outbound_location_id:remote.materials[0].locationId,outbound_location:'2967',delivery_method_id:2,delivery_method:'Delivery'}];
 throw new Error(`Unexpected test NetSuite query: ${sql.slice(0,180)}`);
}
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 const operator=await createOperator({username:actor,displayName:actor,password:'Disposable-Regular-2026!',role:'sales',roles:['sales'],yardLocationIds:[28]});context.operatorId=operator.id;
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
 authToken=(await http('/api/auth/login',{username:actor,password:'Disposable-Regular-2026!'})).token;
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt,item_weight) VALUES($1,'External fixture','EA',1,100,20) ON CONFLICT DO NOTHING",[itemId]);
 await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_pcs,to_plt,item_weight) VALUES(1800000056,'PALLET','EA',1,1,50) ON CONFLICT DO NOTHING");
 await query("INSERT INTO inventory_balances(item_id,location_id,location,quantity_available,quantity_on_hand,synced_at) VALUES($1,1,'3445',1000,1000,now()) ON CONFLICT(item_id,location_id) DO UPDATE SET quantity_available=1000,synced_at=now()",[itemId]);
 token=(await query('SELECT * FROM netsuite_tokens WHERE id=1')).rows[0];
 await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'isolated-test-token',now()+interval '1 day') ON CONFLICT(id) DO UPDATE SET access_token='isolated-test-token',expires_at=now()+interval '1 day'");
 Object.assign(config.netsuite,{directAccessEnabled:true,restBaseUrl:'https://regular-workflow.invalid/services/rest',accountId:'REGULAR_TEST'});
 config.smartScm.liveExecutionEnabled=true;
 globalThis.fetch=async(url,options={})=>{
   const parsed=new URL(url);assert.equal(parsed.hostname,'regular-workflow.invalid','No real network requests are allowed');
   if(parsed.pathname==='/ticket'){
     remote.ticketReads=(remote.ticketReads||0)+1;
     return new Response(Buffer.from('%PDF-1.4\nIsolated transfer test document\n%%EOF'),{status:200,headers:{'content-type':'application/pdf'}});
   }
   if(parsed.pathname.includes('/query/v1/suiteql')){const items=queryRows(JSON.parse(options.body).q);return json({items,count:items.length,hasMore:false});}
   if(parsed.pathname.endsWith(`/salesOrder/${remote.id}`)){
     if(options.method==='PATCH'){
       const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body),['item']);
       for(const line of body.item.items){assert.deepEqual(Object.keys(line).sort(),['line','location']);remote.materials[line.line-1].locationId=Number(line.location.id);}
       remote.locationWrites++;
     }
     return json({location:{id:'28'},entity:{id:'42'},item:{items:remote.materials.map((line,index)=>({line:index+1,item:{id:String(line.itemId)},quantity:line.quantity,rate:10,location:{id:String(line.locationId)}}))}});
   }
   if(parsed.pathname.endsWith('/transferOrder')&&options.method==='POST'){
     remote.transfer=JSON.parse(options.body);remote.toWrites++;
     if(remote.loseCreateResponse)return new Response(null,{status:204});
     return new Response(null,{status:204,headers:{location:`https://regular-workflow.invalid/record/v1/transferOrder/${remote.toId}`}});
   }
   if(parsed.pathname.endsWith(`/transferOrder/${remote.toId}`)&&options.method==='PATCH')return new Response(null,{status:204});
   throw new Error(`Unexpected test NetSuite HTTP: ${options.method||'GET'} ${parsed.pathname}`);
 };
});

for(const loseCreateResponse of [false,true])test(`simple Delivery HTTP uses the SO memo and reuses one TO and print job (lost response: ${loseCreateResponse})`,async()=>{
 await approved(false,200);
 remote.loseCreateResponse=loseCreateResponse;
 const oldUrl=config.smartScm.pickingTicketRestletUrl;
 const originalPrinter=(await query('SELECT * FROM scm_yard_printers WHERE location_id=1')).rows[0];
 try{
  config.smartScm.pickingTicketRestletUrl='https://regular-workflow.invalid/ticket';
  await updateYardPrinter(1,{enabled:true,printers:[1,2].map(slot=>({slot,printerName:`Isolated TO Printer ${slot}`,printTransferOrders:true,printSalesOrders:false}))},context.operatorId);
  await rotateYardPrinterToken(1,context.operatorId);
  const body={deliveryMethod:'delivery',sourceLocationId:1,destinationLocationId:28,salesOrderRef:remote.ref};
  const preview=await http('/api/sales/stock-requests/delivery/preview',{salesOrderRef:remote.ref,sourceLocationId:1});
  assert.equal(preview.baseLocationId,28);assert.equal(preview.lines[0].salesQty,200);assert.equal(preview.palletQuantity,2);
  assert.equal(remote.toWrites,0);
  const done=await http('/api/sales/stock-requests',body,201);
  assert.equal(done.regular.handoffStatus,'complete');assert.equal(done.transfers.length,1);assert.equal(remote.toWrites,1);assert.equal(remote.locationWrites,0);
  assert.equal(remote.transfer.memo,remote.ref);
  assert.equal(Number(remote.transfer.item.items.find(line=>Number(line.item.id)===itemId).quantity),200);
  assert.equal(Number(remote.transfer.item.items.find(line=>Number(line.item.id)===1800000056).quantity),2);
  assert.equal(done.transfers[0].confirmationStatus,'complete');assert(done.transfers[0].printJobId);
  const job=(await query('SELECT * FROM scm_print_jobs WHERE id=$1',[done.transfers[0].printJobId])).rows[0];
  assert.equal(job.status,'queued');assert.equal(Number(job.location_id),1);assert.equal(Number(job.source_order_id),remote.toId);
  assert.deepEqual(job.printer_names,['Isolated TO Printer 1','Isolated TO Printer 2']);
  const again=await http('/api/sales/stock-requests',body,201);
  assert.equal(again.id,done.id);assert.equal(again.transfers[0].printJobId,done.transfers[0].printJobId);assert.equal(remote.toWrites,1);assert.equal(remote.ticketReads,1);
  assert.equal((await query('SELECT count(*)::int AS count FROM order_dependencies WHERE transfer_order_id=$1',[remote.toId])).rows[0].count,1);
 }finally{
  config.smartScm.pickingTicketRestletUrl=oldUrl;
  await query('UPDATE scm_yard_printers SET enabled=$2,printer_name=$3,settings=$4::jsonb,agent_token_hash=$5 WHERE location_id=$1',
   [1,originalPrinter.enabled,originalPrinter.printer_name,JSON.stringify(originalPrinter.settings),originalPrinter.agent_token_hash]);
 }
});
after(async()=>{
 globalThis.fetch=originalFetch;Object.assign(config.netsuite,oldNetSuite);config.smartScm.liveExecutionEnabled=oldLive;
 if(token)await query('UPDATE netsuite_tokens SET access_token=$1,refresh_token=$2,expires_at=$3 WHERE id=1',[token.access_token,token.refresh_token,token.expires_at]);
 else await query('DELETE FROM netsuite_tokens WHERE id=1');
 if(server)await new Promise(resolve=>server.close(resolve));await closeDb();
});
async function approved(mixed=false,quantity=200,deliveryMethod='delivery'){
 const request=await submitRegularStockRequest({destinationLocationId:28,deliveryMethod,arrivalDate:'2099-01-15',arrivalTime:'15:00',lines:[{itemId,sourceLocationId:1,pieces:quantity}]},context,
   {refreshAvailability:async()=>{},loadPolicies:async()=>[{itemId,sourceLocationId:1,availableQuantity:quantity+800,safetyQuantity:800}]});
 remote={id:1800000000+request.id,ref:`SO-REGULAR-${request.id}`,toId:1800100000+request.id,locationWrites:0,toWrites:0,
   materials:[{itemId,quantity,locationId:28},...(mixed?[{itemId:itemId+2,quantity:5,locationId:28}]:[])]};
 return request;
}
test('real SO HTTP adapter changes only selected line locations, refreshes the mirror and verifies retries',async()=>{
 const request=await approved();const input={salesOrderRef:remote.ref,expectedRevision:request.revision};
 await assert.rejects(()=>convertSalesStockRequestLines(request.id,{lineIds:[request.lines[0].id],expectedRevision:request.revision},context),/after Sales links/);
 const preview=await http(`/api/sales/stock-requests/${request.id}/sales-order/preview`,input);assert.deepEqual(preview.choices,[]);
 input.confirmationToken=preview.confirmationToken;
 const done=await http(`/api/sales/stock-requests/${request.id}/sales-order`,input);
 assert.equal(done.regular.handoffStatus,'complete');assert.equal(remote.locationWrites,1);assert.equal(remote.materials[0].locationId,1);
 const mirrored=(await query('SELECT quantity,location_id FROM sales_order_lines WHERE sales_order_id=$1',[remote.id])).rows;
 assert.equal(mirrored.length,1);assert.equal(Number(mirrored[0].quantity),200);assert.equal(Number(mirrored[0].location_id),1);
 await linkRegularStockSalesOrder(request.id,input,context);assert.equal(remote.locationWrites,1);
});
test('real TO confirmation and dependency linking complete despite an unavailable printer without duplicated orders',async()=>{
 const request=await approved(true);const input={salesOrderRef:remote.ref,expectedRevision:request.revision};
 input.confirmationToken=(await http(`/api/sales/stock-requests/${request.id}/sales-order/preview`,input)).confirmationToken;
 let refreshes=0;
 const boundary={refreshAvailability:async ids=>{if(refreshes++===0)throw Error('Transient refresh after TO and dependency committed');return refreshStockRequestItemsAvailability(ids);}};
 await assert.rejects(()=>linkRegularStockSalesOrder(request.id,input,context,boundary),/Transient refresh/);
 const done=await linkRegularStockSalesOrder(request.id,input,context,boundary);
 assert.equal(done.regular.handoffStatus,'complete');assert.equal(done.transfers.length,1);assert.equal(remote.toWrites,1);assert.equal(remote.locationWrites,0);
 assert.equal(remote.transfer.externalId,`MBBS_REGULAR_STOCK_${request.id}_${done.transfers[0].id}`);
 assert.equal(Number(remote.transfer.location.id),1);assert.equal(Number(remote.transfer.transferLocation.id),28);
 const dependencies=(await query('SELECT d.sales_order_id,d.dependency_mode,l.allocated_quantity FROM order_dependencies d JOIN order_dependency_lines l ON l.dependency_id=d.id WHERE d.transfer_order_id=$1',[remote.toId])).rows;
 assert.equal(dependencies.length,1);assert.equal(Number(dependencies[0].sales_order_id),remote.id);assert.equal(dependencies[0].dependency_mode,'yard_replenishment');assert.equal(Number(dependencies[0].allocated_quantity),150);
 assert.equal((await getScmStockRequest(request.id)).transfers[0].status,'pending_fulfillment');
 await linkRegularStockSalesOrder(request.id,input,context);assert.equal(remote.toWrites,1);
});

async function rejected(request,input){
 const response=await originalFetch(`${base}/api/sales/stock-requests/${request.id}/sales-order`,{method:'POST',headers:{Authorization:`Bearer ${authToken}`,'Content-Type':'application/json'},body:JSON.stringify(input)});
 const data=await response.json();assert.equal(response.status,409,JSON.stringify(data));return data;
}
async function noEffects(request){
 assert.equal(remote.locationWrites,0);assert.equal(remote.toWrites,0);
 assert.equal((await query('SELECT count(*)::int AS n FROM regular_stock_handoffs WHERE request_id=$1',[request.id])).rows[0].n,0);
 assert.equal((await getScmStockRequest(request.id)).revision,request.revision);
}
test('HTTP quantity mismatch is precise and creates no handoff or NetSuite writes',async()=>{
 const request=await approved(false,760);remote.materials[0].quantity=912;
 const input={salesOrderRef:remote.ref,expectedRevision:request.revision};
 const expected=`Quantity mismatch for External fixture: the stock request approves 760 EA, but ${remote.ref} has 912 EA. Quantities must match before linking the SO.`;
 assert.equal((await rejected(request,input)).error,expected);
 const preview=await originalFetch(`${base}/api/sales/stock-requests/${request.id}/sales-order/preview`,{method:'POST',headers:{Authorization:`Bearer ${authToken}`,'Content-Type':'application/json'},body:JSON.stringify(input)});
 assert.equal(preview.status,409);assert.equal((await preview.json()).error,expected);
 await noEffects(request);
});
test('preview needs explicit confirmation, detects changed SO routing, and saves the completed action',async()=>{
 const request=await approved();const input={salesOrderRef:remote.ref,expectedRevision:request.revision};
 const preview=await http(`/api/sales/stock-requests/${request.id}/sales-order/preview`,input);
 assert.equal(preview.action.mode,'location');assert.equal(preview.action.sourceName,'3445');assert.equal(preview.action.destinationName,'2967');assert.equal(preview.action.lineCount,1);
 assert.equal(typeof preview.confirmationToken,'string');await noEffects(request);
 assert.match((await rejected(request,input)).error,/Review and confirm/);await noEffects(request);
 remote.materials.push({itemId:itemId+2,quantity:5,locationId:28});
 assert.match((await rejected(request,{...input,confirmationToken:preview.confirmationToken})).error,/changed.*review.*confirm/i);await noEffects(request);
 const updated=await http(`/api/sales/stock-requests/${request.id}/sales-order/preview`,input);
 assert.equal(updated.action.mode,'transfer');assert.equal(updated.action.routes.length,1);assert.notEqual(updated.confirmationToken,preview.confirmationToken);
 const done=await http(`/api/sales/stock-requests/${request.id}/sales-order`,{...input,confirmationToken:updated.confirmationToken});
 assert.equal(done.regular.handoffStatus,'complete');assert.deepEqual(done.regular.routingAction,updated.action);
 assert.equal(done.regular.routingTransfers[0].reference,`TO-${remote.toId}`);assert.equal(done.regular.routingTransfers[0].sourceName,'3445');assert(done.regular.routingCompletedAt);
 const reopened=await http(`/api/sales/stock-requests/${request.id}`);assert.deepEqual(reopened.regular,done.regular);
 assert.equal(remote.toWrites,1);assert.equal(remote.locationWrites,0);
});

test('SCM Stocking HTTP authenticates search and conversion, issues the real TO adapter without SO and preserves its snapshot',async()=>{
 const request=await approved(false,25,'stocking');
 const input={expectedRevision:request.revision,lines:[{id:request.lines[0].id,itemId,sourceLocationId:1,pieces:30}],palletQuantities:{1:1}};
 for(const [path,body] of [['/api/scm/stock-request-items?search=External'],[`/api/scm/stock-request-items/${itemId}/availability/refresh`,{}],
  [`/api/scm/stock-requests/${request.id}/pickup-preview`,input],[`/api/scm/stock-requests/${request.id}/pickup-convert`,input]]){
  const response=await originalFetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${authToken}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal(response.status,403);assert.equal(remote.toWrites,0);
 }
 const salesToken=authToken,scmName='pickup-scm-'+randomUUID();
 await createOperator({username:scmName,displayName:scmName,password:'Disposable-Regular-2026!',role:'scm',roles:['scm']});
 authToken=(await http('/api/auth/login',{username:scmName,password:'Disposable-Regular-2026!'})).token;
 try {
  assert((await http('/api/scm/stock-request-items?search=External')).items.some(item=>item.itemId===itemId));
  assert.equal((await http(`/api/scm/stock-request-items/${itemId}/availability/refresh`,{})).item.itemId,itemId);
  const preview=await http(`/api/scm/stock-requests/${request.id}/pickup-preview`,input);
  assert.equal(preview.action.mode,'pickup');assert.equal(preview.lines[0].salesQty,30);assert.equal(remote.toWrites,0);
  const done=await http(`/api/scm/stock-requests/${request.id}/pickup-convert`,{...input,confirmationToken:preview.confirmationToken});
  assert.equal(done.regular.pickupTransfer.status,'complete');assert.equal(remote.toWrites,1);assert.equal(remote.locationWrites,0);
  assert.equal(remote.transfer.externalId,`MBBS_REGULAR_PICKUP_${request.id}_${done.transfers[0].id}`);
  assert.equal(Number(remote.transfer.location.id),1);assert.equal(Number(remote.transfer.transferLocation.id),28);
  assert.equal(Number(remote.transfer.item.items.find(line=>Number(line.item.id)===itemId).quantity),30);
  assert.equal((await query('SELECT 1 FROM regular_stock_handoffs WHERE request_id=$1',[request.id])).rowCount,0);
  assert.equal((await query('SELECT 1 FROM order_dependencies WHERE transfer_order_id=$1',[remote.toId])).rowCount,0);
  const snapshot=done.lines[0].approvalEvidence;
  await query('UPDATE inventory_balances SET quantity_available=123 WHERE item_id=$1',[itemId]);
  const reopened=await http(`/api/scm/stock-requests/${request.id}/evidence`,{});
  assert.deepEqual(reopened.lines[0].approvalEvidence,snapshot);assert.equal(reopened.currentEvidence,undefined);
  const resumed=await http(`/api/scm/stock-requests/${request.id}/pickup-preview`,{});
  await http(`/api/scm/stock-requests/${request.id}/pickup-convert`,{confirmationToken:resumed.confirmationToken});assert.equal(remote.toWrites,1);
  const invalid=await originalFetch(`${base}/api/scm/stock-requests/${request.id}/pickup-convert`,{method:'POST',headers:{Authorization:`Bearer ${authToken}`,'Content-Type':'application/json'},body:'{}'});
  assert.equal(invalid.status,409);assert.match((await invalid.json()).error,/Review and confirm/);
 } finally {authToken=salesToken;}
 assert((await http('/api/sales/stock-requests/alerts')).requests.some(row=>row.id===request.id));
 const salesView=await http(`/api/sales/stock-requests/${request.id}`);assert.equal(salesView.regular.pickupTransfer.status,'complete');
});
