import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { query, closeDb, withTransaction } from '../../../src/db.js';
import { createDeliveryRequestService, prioritizeDeliveryOrders } from '../../../src/delivery-request-repository.js';
import { getDeliveryInstruction, saveDeliveryInstructionText } from '../../../src/delivery-instruction-repository.js';
import { pricing, window, sales, colleague, dispatcher, clock } from '../support/delivery-request-fixtures.js';
import {seedDeliveryRates} from '../support/delivery-request-database.js';

after(closeDb);
let seeded = false, instant = clock.now;
const notices = [];
async function setup() {
  const service = createDeliveryRequestService({ now: () => new Date(instant), emit: event => notices.push(event),
    resolveDistance: async input => ({ providerMetres: input.originYardCode === '2967' ? 50001 : 20000,
      routeHash: 'test-route', originSnapshot: { yardCode: input.originYardCode }, destinationSnapshot: {}, routeSnapshot: { provider: 'fixture' } }) });
  if (!seeded) {
    await query(await fs.readFile(new URL('../../../migrations/265_delivery_requests.sql', import.meta.url), 'utf8'));
    for (const actor of [sales, colleague, dispatcher, { ...sales, id: 'delivery-other', yardLocationIds: [28] }]) {
      await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles,active)
        VALUES($1,$1,$1,'test','test',$2,ARRAY[$2]::text[],true) ON CONFLICT(id) DO NOTHING`, [actor.id, actor.role]);
    }
    await seedDeliveryRates();
    for (const [id, ref, yard] of [[98700001,'SO123',1],[98700002,'SO124',1],[98700003,'SOOTHER',28]]) {
      await query(`INSERT INTO sales_orders(netsuite_id,tranid,trandate,customer,status,status_text,order_location_id,sales_order_type,netsuite_active,synced_at)
        VALUES($1,$2,current_date,'Delivery Test','Pending Fulfillment','Pending Fulfillment',$3,'Delivery',true,now()) ON CONFLICT(netsuite_id) DO NOTHING`, [id,ref,yard]);
    }
    seeded = true;
  }
  instant = clock.now;
  await service.setSettings(clock.settings, dispatcher);
  return service;
}
async function submit(service, patch = {}) {
  const input = { ...pricing(), ...patch };
  const quoted = await service.quote(input, sales);
  return service.create({ ...input, requestedWindow: window(), quoteId: quoted.id, operationId: crypto.randomUUID() }, sales);
}
const command = (row, patch = {}) => ({ expectedRevision: row.revision, operationId: crypto.randomUUID(), ...patch });

test('Dispatch counter: Sales decides the new secured window, with durable alerts, replay and planning',async()=>{
  const {service,row,ref,legacy}=await timeChangeFixture(71);
  const pending=await service.act(row.id,'request-time-change',command(row,{window:window({start:'13:00',end:'15:00'})}),sales,'sales');
  const input=command(pending,{window:window({start:'15:00',end:'17:00'}),message:'The afternoon truck is available at 3.'});
  const before=notices.length,counter=await service.act(row.id,'counter-time-change',input,dispatcher,'dispatch');
  assert.deepEqual(counter.confirmedWindow,legacy);assert.deepEqual(counter.salesOrderRefs,[ref]);assert.equal(counter.pendingWindowProposedBy,'dispatch');
  assert.equal((await service.alerts(sales,'sales')).requests.find(item=>item.id===row.id).action,'counter-time-change');
  assert.equal(counter.conversation.at(-1).message,input.message);assert.match(counter.history[0].message,/Counter-proposed time change/);
  assert.deepEqual(await service.act(row.id,'counter-time-change',input,dispatcher,'dispatch'),counter);assert.equal(notices.length,before+1);
  const original={id:ref,windowStart:'07:00',windowEnd:'10:00'},[held]=await prioritizeDeliveryOrders([original]);
  assert.equal(held.windowStart,'08:00');assert.equal(held.windowEnd,'09:00');
  await assert.rejects(service.act(row.id,'accept-time-change',command(counter),dispatcher,'dispatch'),{code:'DELIVERY_STATE_CONFLICT'});
  const accepted=await service.act(row.id,'accept-counter-time-change',command(counter),sales,'sales');
  const [planned]=await prioritizeDeliveryOrders([held]);assert.equal(planned.windowStart,'15:00');assert.equal(planned.windowEnd,'17:00');
  assert.equal(accepted.pendingWindow,null);assert.equal(accepted.pendingWindowProposedBy,null);assert.deepEqual(accepted.quote,row.quote);
  assert.equal((await service.alerts(dispatcher,'dispatch')).requests.find(item=>item.id===row.id).action,'accept-counter-time-change');
});
test('Dispatch counter: concurrent Sales acceptance and Dispatch revision have exactly one winner',async()=>{
  const {service,row,legacy,ref}=await timeChangeFixture(72);
  const pending=await service.act(row.id,'request-time-change',command(row,{window:window()}),sales,'sales');
  const counter=await service.act(row.id,'counter-time-change',command(pending,{window:window({start:'13:00',end:'15:00'})}),dispatcher,'dispatch');
  const replies=await Promise.allSettled([
    service.act(row.id,'accept-counter-time-change',command(counter),sales,'sales'),
    service.act(row.id,'counter-time-change',command(counter,{window:window({start:'15:00',end:'17:00'})}),dispatcher,'dispatch')]);
  assert.equal(replies.filter(reply=>reply.status==='fulfilled').length,1);
  assert.equal(replies.find(reply=>reply.status==='rejected').reason.code,'DELIVERY_STALE_REVISION');
  const saved=await service.get(row.id,sales,'sales');assert.equal(saved.revision,counter.revision+1);assert.deepEqual(saved.salesOrderRefs,[ref]);
  assert.deepEqual(saved.confirmedWindow,saved.lastAction==='accept-counter-time-change'?counter.pendingWindow:legacy);
  const before=notices.length;
  if(saved.pendingWindow) {
    await withTransaction(()=>service.act(row.id,'accept-counter-time-change',command(saved),sales,'sales'),{rollback:true});
    assert.deepEqual(await service.get(row.id,sales,'sales'),saved);assert.equal(notices.length,before);
  }
});
test('trip pricing: reverse routes and every multi-stop leg are quoted, saved and protected against changed inputs',async()=>{
  await setup();const routes=[];
  const service=createDeliveryRequestService({now:()=>new Date(clock.now),resolveDistance:async input=>{
    routes.push(input);return {providerMetres:input.originAddressText?50001:20000,originSnapshot:{addressText:input.originAddressText || 'Yard'},destinationSnapshot:{addressText:input.destinationAddressText}};
  }});
  const roundInput=pricing({tripType:'round_trip'}),roundQuote=await service.quote(roundInput,sales);
  assert.equal(roundQuote.totalAmountMinor,80500);assert.equal(routes.length,2);
  assert.equal(routes[1].originAddressText,roundInput.deliveryAddress);assert.equal(routes[1].destinationYardCode,'3445');
  assert.ok(routes[1].destinationAddressText);assert.notEqual(routes[1].destinationAddressText,roundInput.deliveryAddress);
  const round=await service.create({...roundInput,quoteId:roundQuote.id,operationId:crypto.randomUUID(),requestedWindow:window()},sales);
  assert.equal(round.tripType,'round_trip');assert.equal(round.quote.outbounds[1].legType,'return');
  const input=pricing({tripType:'multi_stop',tripLegs:[
    {pickupYardCode:'3445',dropoffAddress:'200 Dropoff Road',totalUnits:10},
    {pickupAddress:'200 Dropoff Road',dropoffYardCode:'2967',totalUnits:30}]});
  const quoted=await service.quote(input,sales);assert.equal(routes.length,4);
  assert.equal(routes[2].originYardCode,'3445');assert.equal(routes[3].destinationYardCode,'2967');
  for(const field of ['totalUnits','pickupYardCode','dropoffAddress']) {
    const tampered=structuredClone(input);tampered.tripLegs[0][field]=field==='totalUnits'?11:field==='pickupYardCode'?'2967':'Changed address';
    await assert.rejects(service.create({...tampered,quoteId:quoted.id,operationId:crypto.randomUUID(),requestedWindow:window()},sales),{code:'DELIVERY_QUOTE_CHANGED'});
  }
  const invalid=structuredClone(input);invalid.tripLegs[1]={pickupAddress:'200 Dropoff Road',dropoffAddress:'Any address',totalUnits:30};
  const beforeRoutes=routes.length;await assert.rejects(service.quote(invalid,sales),{code:'DELIVERY_REQUEST_INVALID'});assert.equal(routes.length,beforeRoutes);
  const saved=await service.create({...input,quoteId:quoted.id,operationId:crypto.randomUUID(),requestedWindow:window()},sales);
  assert.deepEqual(saved.tripLegs,input.tripLegs);assert.equal(saved.totalUnits,40);
  assert.equal((await service.get(saved.id,dispatcher,'dispatch')).tripType,'multi_stop');
  assert.deepEqual(saved.quote.outbounds.map(leg=>leg.totalUnits),[10,30]);
  const singleInput=pricing({tripType:'single'}),singleQuote=await service.quote(singleInput,sales);
  const changed=await service.act(saved.id,'edit',command(saved,{...singleInput,quoteId:singleQuote.id,requestedWindow:window()}),sales,'sales');
  assert.equal(changed.tripType,'single');assert.equal(changed.tripLegs,undefined);
});

async function timeChangeFixture(index) {
  const service=await setup(),ref=`SOTIME${index}`;
  await query(`INSERT INTO sales_orders(netsuite_id,tranid,trandate,customer,status,status_text,order_location_id,sales_order_type,netsuite_active,synced_at)
    VALUES($1,$2,current_date,'Time change','Pending Fulfillment','Pending Fulfillment',1,'Delivery',true,now())`,[98702000+index,ref]);
  const submitted=await submit(service),approved=await service.act(submitted.id,'confirm',command(submitted),dispatcher,'dispatch');
  const secured=await service.act(approved.id,'secure',command(approved,{salesOrderRefs:[ref]}),sales,'sales');
  const legacy=window({start:'08:00',end:'09:00',timeZone:'America/Toronto'});
  await query("UPDATE delivery_requests SET data=jsonb_set(data,'{confirmedWindow}',$2) WHERE id=$1",[secured.id,JSON.stringify(legacy)]);
  return {service,row:await service.get(secured.id,sales,'sales'),ref,legacy};
}
test('time change: pending planning retains approved time until accepted, with durable alerts, replay and audit',async()=>{
  const {service,row,ref,legacy}=await timeChangeFixture(1),windowNext=window({date:'2028-10-12',start:'13:00',end:'15:00'});
  const original={id:ref,expectedDeliveryDate:'2028-10-10',windowStart:'08:00',windowEnd:'22:00'};
  const input=command(row,{window:windowNext,message:'Customer asked for afternoon.'}),count=notices.length;
  const pending=await service.act(row.id,'request-time-change',input,sales,'sales');
  assert.equal(pending.status,'confirmed');assert.deepEqual(pending.confirmedWindow,legacy);assert.deepEqual(pending.quote,row.quote);
  assert.deepEqual(pending.salesOrderRefs,[ref]);assert.equal(pending.securedAt,row.securedAt);assert.equal(pending.approvalExpiresAt,null);
  const [held]=await prioritizeDeliveryOrders([original]);assert.equal(held.windowEnd,'09:00');assert.equal(held.deliveryApprovalPriority,true);
  assert.equal((await service.alerts(dispatcher,'dispatch')).requests.find(item=>item.id===row.id).action,'request-time-change');
  assert.equal((await service.act(row.id,'request-time-change',input,sales,'sales')).revision,pending.revision);assert.equal(notices.length,count+1);
  instant='2028-10-04T12:00:00Z';await service.tick();assert.equal((await service.get(row.id,sales,'sales')).status,'confirmed');
  const accepted=await service.act(row.id,'accept-time-change',command(pending),dispatcher,'dispatch');
  assert.deepEqual(accepted.confirmedWindow,{...windowNext,timeZone:'America/Toronto'});assert.equal(accepted.pendingWindow,null);
  const [changed]=await prioritizeDeliveryOrders([held]);
  assert.equal(changed.expectedDeliveryDate,'2028-10-12');assert.equal(changed.windowStart,'13:00');assert.equal(changed.windowEnd,'15:00');
  assert.deepEqual(changed.deliveryRequestOriginalWindow,held.deliveryRequestOriginalWindow);
  assert.match(accepted.history[0].message,/08:00.*09:00.*13:00.*15:00/);
  assert.equal((await service.alerts(sales,'sales')).requests.find(item=>item.id===row.id).action,'accept-time-change');
});
test('time change: rollback and competing decisions cannot partially change the approved time or links',async()=>{
  const {service,row,legacy}=await timeChangeFixture(2);
  const pending=await service.act(row.id,'request-time-change',command(row,{window:window({start:'13:00',end:'15:00'})}),sales,'sales');
  const count=notices.length;
  for(const action of ['accept-time-change','cancel']) {
    await withTransaction(()=>service.act(row.id,action,command(pending),dispatcher,'dispatch'),{rollback:true});
    const saved=await service.get(row.id,sales,'sales');assert.deepEqual(saved,pending);assert.equal(notices.length,count);
    assert.equal((await query('SELECT * FROM delivery_request_sales_orders WHERE request_id=$1',[row.id])).rowCount,1);
  }
  const results=await Promise.allSettled([
    service.act(row.id,'accept-time-change',command(pending),dispatcher,'dispatch'),
    service.act(row.id,'decline-time-change',command(pending),dispatcher,'dispatch')]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.code,'DELIVERY_STALE_REVISION');
  const saved=await service.get(row.id,sales,'sales');assert.equal(saved.pendingWindow,null);assert.equal(saved.revision,pending.revision+1);
  assert.deepEqual(saved.confirmedWindow,saved.lastAction==='accept-time-change'?pending.pendingWindow:legacy);
  assert.deepEqual(saved.salesOrderRefs,row.salesOrderRefs);assert.equal(notices.length,count+1);
});
test('time change: cancel releases associations, restores planning and permits the same SO on a new request',async()=>{
  const {service,row,ref}=await timeChangeFixture(3);
  const pending=await service.act(row.id,'request-time-change',command(row,{window:window()}),sales,'sales');
  const original={id:ref,windowStart:'08:00',windowEnd:'22:00'},[held]=await prioritizeDeliveryOrders([original]);
  const input=command(pending),cancelled=await service.act(row.id,'cancel',input,sales,'sales');
  assert.deepEqual(cancelled.salesOrderRefs,[]);assert.equal(cancelled.pendingWindow,null);assert.equal(cancelled.status,'cancelled');
  assert.equal((await query('SELECT * FROM delivery_request_sales_orders WHERE request_id=$1',[row.id])).rowCount,0);
  assert.deepEqual(await prioritizeDeliveryOrders([held]),[original]);assert.match(cancelled.history[0].message,new RegExp(`Released Sales Orders: ${ref}`));
  assert.equal((await service.act(row.id,'cancel',input,sales,'sales')).revision,cancelled.revision);
  await assert.rejects(service.act(row.id,'accept-time-change',command(cancelled),dispatcher,'dispatch'),{code:'DELIVERY_STATE_CONFLICT'});
  const submitted=await submit(service),approved=await service.act(submitted.id,'confirm',command(submitted),dispatcher,'dispatch');
  const linked=await service.act(approved.id,'secure',command(approved,{salesOrderRefs:[ref]}),sales,'sales');
  assert.deepEqual(linked.salesOrderRefs,[ref]);
  const rows=(await query('SELECT request_id FROM delivery_request_sales_orders WHERE order_ref=$1',[ref])).rows;
  assert.deepEqual(rows.map(item=>Number(item.request_id)),[linked.id]);
  const [active]=await prioritizeDeliveryOrders([held]);assert.equal(active.windowStart,'09:00');assert.equal(active.windowEnd,'12:00');
  assert.equal(active.deliveryApprovalPriority,true);
});
test('time change: cancellation racing with acceptance has one winner and a stale reply never restores released links',async()=>{
  const {service,row,legacy}=await timeChangeFixture(4);
  const pending=await service.act(row.id,'request-time-change',command(row,{window:window()}),sales,'sales');
  const results=await Promise.allSettled([
    service.act(row.id,'cancel',command(pending),sales,'sales'),
    service.act(row.id,'accept-time-change',command(pending),dispatcher,'dispatch')]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.code,'DELIVERY_STALE_REVISION');
  let saved=await service.get(row.id,sales,'sales');
  assert.equal(saved.pendingWindow,null);
  assert.deepEqual(saved.confirmedWindow,saved.status==='cancelled'?legacy:pending.pendingWindow);
  if(saved.status==='confirmed') {saved=await service.act(row.id,'cancel',command(saved),sales,'sales');}
  assert.deepEqual(saved.salesOrderRefs,[]);
  await assert.rejects(service.act(row.id,'accept-time-change',command(pending),dispatcher,'dispatch'),{code:'DELIVERY_STALE_REVISION'});
  assert.equal((await query('SELECT * FROM delivery_request_sales_orders WHERE request_id=$1',[row.id])).rowCount,0);
});

test('linkage: validated atomic exchange preserves approval, audits refs, updates priority and rejects stale concurrent edits',async()=>{
  const service=await setup();
  for(const [id,ref] of [[98700801,'SOLINK1'],[98700802,'SOLINK2'],[98700803,'SOLINK3']]) {
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,trandate,customer,status,status_text,order_location_id,sales_order_type,netsuite_active,synced_at)
      VALUES($1,$2,current_date,'Linkage Test','Pending Fulfillment','Pending Fulfillment',1,'Delivery',true,now())`,[id,ref]);
  }
  const submitted=await submit(service),approved=await service.act(submitted.id,'confirm',command(submitted),dispatcher,'dispatch');
  const secured=await service.act(approved.id,'secure',command(approved,{salesOrderRefs:['SOLINK1','SOLINK2']}),sales,'sales');
  const links=async()=> (await query('SELECT order_ref FROM delivery_request_sales_orders WHERE request_id=$1 ORDER BY order_ref',[secured.id])).rows.map(item=>item.order_ref);
  const before=notices.length;
  await assert.rejects(service.act(secured.id,'relink',command(secured,{salesOrderRefs:['SOLINK3','SOOTHER']}),sales,'sales'),{status:403});
  assert.deepEqual(await links(),['SOLINK1','SOLINK2']);assert.equal(notices.length,before);
  assert.equal((await service.get(secured.id,sales,'sales')).revision,secured.revision);
  const input=command(secured,{salesOrderRefs:['SOLINK2','SOLINK3']});
  const changed=await service.act(secured.id,'relink',input,colleague,'sales');
  assert.deepEqual(await links(),['SOLINK2','SOLINK3']);
  assert.deepEqual(changed.confirmedWindow,secured.confirmedWindow);assert.equal(changed.securedAt,secured.securedAt);
  assert.deepEqual(changed.quote,secured.quote);assert.equal(changed.approvalExpiresAt,null);assert.equal(changed.status,'confirmed');
  assert.match(changed.history[0].message,/SOLINK1.*SOLINK2.*SOLINK2.*SOLINK3/);
  assert.equal(changed.history[0].action,'relink');assert.equal(notices.length,before+1);
  assert.equal((await service.act(secured.id,'relink',input,colleague,'sales')).revision,changed.revision);
  assert.equal(notices.length,before+1);
  assert.equal((await service.alerts(dispatcher,'dispatch')).requests.find(item=>item.id===secured.id).revision,changed.revision);
  const projected=await prioritizeDeliveryOrders(['SOLINK1','SOLINK2','SOLINK3'].map(id=>({id,type:'SO',windowStart:'08:00',windowEnd:'22:00'})));
  assert.equal(projected.find(order=>order.id==='SOLINK1').deliveryApprovalPriority,undefined);
  assert.equal(projected.find(order=>order.id==='SOLINK3').windowEnd,secured.confirmedWindow.end);
  const race=await Promise.allSettled(['SOLINK2','SOLINK3'].map(ref=>service.act(secured.id,'relink',command(changed,{salesOrderRefs:[ref]}),sales,'sales')));
  assert.equal(race.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(race.find(result=>result.status==='rejected').reason.code,'DELIVERY_STALE_REVISION');
  const final=await service.get(secured.id,sales,'sales');assert.equal((await links()).length,1);
  await assert.rejects(service.act(final.id,'relink',command(final,{salesOrderRefs:[]}),sales,'sales'),{code:'DELIVERY_REQUEST_INVALID'});
  assert.deepEqual(await links(),final.salesOrderRefs);
});

test('mandatory quote, same-yard visibility and customer-free submission use durable route/rate evidence', async () => {
  const service = await setup(), row = await submit(service);
  assert.equal(row.quote.totalAmountMinor, 47000); assert.equal(row.customerName, '');
  assert.equal((await service.get(row.id, colleague, 'sales')).id, row.id);
  await assert.rejects(service.get(row.id, { ...sales, id:'delivery-other', yardLocationIds:[28] }, 'sales'), { status:403 });
  await assert.rejects(service.get(row.id, { ...sales, publicSales:true }, 'sales'), { status:403 });
  await assert.rejects(service.create({ ...pricing(), requestedWindow:window(), operationId:crypto.randomUUID() }, sales), { code:'DELIVERY_QUOTE_REQUIRED' });
  assert.equal(row.quote.outbounds[0].routeHash, 'test-route');
});
test('tampered, stale and reused quote tickets fail; multi-yard amounts come from the server', async () => {
  const service = await setup(), quote = await service.quote(pricing(), sales);
  await assert.rejects(service.create({ ...pricing({ totalUnits:1 }), requestedWindow:window(), quoteId:quote.id,operationId:crypto.randomUUID() }, sales), { code:'DELIVERY_QUOTE_CHANGED' });
  instant = '2028-10-01T12:10:00.000Z';
  await assert.rejects(service.create({ ...pricing(), requestedWindow:window(), quoteId:quote.id,operationId:crypto.randomUUID() }, sales), { code:'DELIVERY_QUOTE_EXPIRED' });
  instant = clock.now;
  const row = await submit(service, { outbounds:[{originYardCode:'3445',totalUnits:27},{originYardCode:'2967',totalUnits:1}], totalUnits:28 });
  assert.equal(row.quote.totalAmountMinor,47000);
  await assert.rejects(service.create({ ...pricing(), requestedWindow:window(), quoteId:row.quote.id,operationId:crypto.randomUUID() }, sales), { code:'DELIVERY_QUOTE_USED' });
});
test('concurrent replies allow one winner; operation retries emit once and mismatched retries fail', async () => {
  const service = await setup(), row = await submit(service), input = command(row);
  const count = notices.length;
  const results = await Promise.allSettled([service.act(row.id,'confirm',input,dispatcher,'dispatch'),service.act(row.id,'propose',command(row,{window:window({start:'10:00'})}),dispatcher,'dispatch')]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.filter(result=>result.status==='rejected')[0].reason.code,'DELIVERY_STALE_REVISION');
  const first = results[0].status === 'fulfilled' ? results[0].value : null;
  if (first) {
    const replay = await service.act(row.id,'confirm',input,dispatcher,'dispatch');
    assert.equal(replay.revision,first.revision); assert.equal(notices.length,count+1);
    await assert.rejects(service.act(row.id,'cancel',input,dispatcher,'dispatch'), { code:'DELIVERY_OPERATION_CONFLICT' });
  }
});
test('approval snapshots settings, reminds once, expires atomically and re-raises the same request', async () => {
  const service = await setup(), submitted = await submit(service);
  const row = await service.act(submitted.id,'confirm',command(submitted),dispatcher,'dispatch');
  await service.setSettings({ ...clock.settings, approvalHours:6 },dispatcher);
  assert.equal(row.approvalExpiresAt,'2028-10-01T15:00:00.000Z');
  instant = row.reminderAt;
  await service.tick(); const reminded = await service.get(row.id,sales,'sales');
  const revision = reminded.revision;
  await service.tick(); assert.equal((await service.get(row.id,sales,'sales')).revision,revision);
  instant = row.approvalExpiresAt;
  await assert.rejects(service.act(row.id,'secure',command(reminded,{salesOrderRefs:['SO123']}),sales,'sales'), { code:'DELIVERY_APPROVAL_EXPIRED' });
  const expired = await service.get(row.id,sales,'sales'); assert.equal(expired.status,'expired');
  const quote = await service.quote(pricing(),sales);
  const raised = await service.act(row.id,'reraise',command(expired,{ ...pricing(),requestedWindow:window(),quoteId:quote.id }),sales,'sales');
  assert.equal(raised.id,row.id); assert.equal(raised.requestRef,row.requestRef); assert.equal(raised.status,'submitted');
  assert.ok(raised.history.some(event=>event.action==='expire'));
  await assert.rejects(service.act(row.id,'secure',command(raised,{salesOrderRefs:['SO123']}),sales,'sales'), { code:'DELIVERY_STATE_CONFLICT' });
});
test('securing at least one authorized SO stops expiry and prioritizes orders without changing other ties', async () => {
  const service = await setup(), row = await submit(service);
  const approved = await service.act(row.id,'confirm',command(row),dispatcher,'dispatch');
  await assert.rejects(service.act(row.id,'secure',command(approved,{salesOrderRefs:[]}),sales,'sales'), { code:'DELIVERY_REQUEST_INVALID' });
  await assert.rejects(service.act(row.id,'secure',command(approved,{salesOrderRefs:['SOOTHER']}),sales,'sales'), { status:403 });
  const secured = await service.act(row.id,'secure',command(approved,{salesOrderRefs:['SO123','SO124']}),colleague,'sales');
  assert.equal(secured.status,'confirmed'); assert.equal(secured.approvalExpiresAt,null);
  instant = '2028-10-03T12:00:00Z'; await service.tick();
  assert.equal((await service.get(row.id,sales,'sales')).status,'confirmed');
  const orders = [{id:'SOZ',type:'SO'},{id:'SO123',type:'SO'},{id:'TO1',type:'TO'},{id:'SO124',type:'SO'}];
  const sorted = await prioritizeDeliveryOrders(orders);
  assert.deepEqual(sorted.map(order=>order.id),['SO123','SO124','SOZ','TO1']);
  assert.deepEqual(orders.map(order=>order.id),['SOZ','SO123','TO1','SO124']);
});
test('unread receipts are private and revision bounded; read races preserve new updates', async () => {
  const service = await setup(), row = await submit(service);
  assert.ok((await service.alerts(dispatcher,'dispatch')).requests.some(item=>item.id===row.id));
  assert.ok(!(await service.alerts(sales,'sales')).requests.some(item=>item.id===row.id));
  await service.markRead(row.id,row.revision,colleague,'sales');
  const changed = await service.act(row.id,'confirm',command(row),dispatcher,'dispatch');
  await service.markRead(row.id,row.revision,colleague,'sales');
  assert.equal((await service.alerts(colleague,'sales')).requests.find(item=>item.id===row.id).revision,changed.revision);
  await assert.rejects(service.markRead(row.id,changed.revision+1,colleague,'sales'), { code:'DELIVERY_REQUEST_INVALID' });
});
test('transaction rollback leaves no request or notifications and migration is idempotent', async () => {
  const service = await setup(), beforeCount = notices.length;
  let id;
  await withTransaction(async()=>{ id = (await submit(service)).id; },{rollback:true});
  assert.equal(notices.length,beforeCount);
  await assert.rejects(service.get(id,sales,'sales'), { status:404 });
  await query(await fs.readFile(new URL('../../../migrations/265_delivery_requests.sql',import.meta.url),'utf8'));
  assert.equal((await service.getSettings()).approvalHours,3);
});
test('secured requests reuse order instruction revisions and receive durable media/text update alerts', async () => {
  const service = await setup(), row = await submit(service);
  const approved = await service.act(row.id,'confirm',command(row),dispatcher,'dispatch');
  const secured = await service.act(row.id,'secure',command(approved,{salesOrderRefs:['SO124']}),sales,'sales');
  const old = await getDeliveryInstruction('SO124',{authorizedOrderingLocationIds:[1]});
  const saved = await saveDeliveryInstructionText('SO124',{expectedRevision:old.revision,additionalText:'Use the rear gate.'},{operatorId:sales.id,source:'sales',authorizedOrderingLocationIds:[1]});
  await service.instructionChanged(saved.orderRef,sales.id);
  assert.equal((await service.get(secured.id,dispatcher,'dispatch')).revision,secured.revision+1);
  assert.equal(saved.additionalText,'Use the rear gate.');
  await assert.rejects(saveDeliveryInstructionText('SO124',{expectedRevision:old.revision,additionalText:'stale'},{operatorId:sales.id,source:'sales',authorizedOrderingLocationIds:[1]}), { status:409 });
});
test('inactive BIN sizes cannot be quoted through direct API inputs',async()=>{
  const service=await setup();
  await withTransaction(async()=>{
    await query("UPDATE mbt_bin_types SET active=false WHERE type_code='14YD'");
    assert.equal((await service.options(sales,'sales')).binTypes.some(bin=>bin.code==='14YD'),false);
    await assert.rejects(service.quote(pricing({loadType:'bin',totalUnits:1,binTypeCode:'14YD'}),sales),{code:'DELIVERY_QUOTE_UNAVAILABLE'});
  },{rollback:true});
});
test('canonical instruction updates notify secured split orders once per request',async()=>{
  const service=await setup();
  const familyId=98700005,familyRef='SODELFAMILY',children=[[-98700006,'SODELFAMILY-S1'],[-98700007,'SODELFAMILY-S2']];
  for(const [id,ref] of [[familyId,familyRef],...children]) {
    await query(`INSERT INTO sales_orders(netsuite_id,tranid,trandate,customer,status,status_text,order_location_id,sales_order_type,netsuite_active,synced_at)
      VALUES($1,$2,current_date,'Split Delivery Test','Pending Fulfillment','Pending Fulfillment',1,'Delivery',true,now())`,[id,ref]);
  }
  for(const [id,ref] of children) {
    await query(`INSERT INTO dispatch_scm_so_splits(source_so_id,source_so_ref,split_so_id,split_so_ref,status,created_by,details)
      VALUES($1,$2,$3,$4,'active',$5,'{}')`,[familyId,familyRef,id,ref,dispatcher.id]);
  }
  const submitted=await submit(service),approved=await service.act(submitted.id,'confirm',command(submitted),dispatcher,'dispatch');
  const secured=await service.act(approved.id,'secure',command(approved,{salesOrderRefs:children.map(child=>child[1])}),sales,'sales');
  await service.markRead(secured.id,secured.revision,dispatcher,'dispatch');
  const old=await getDeliveryInstruction(children[0][1],{authorizedOrderingLocationIds:[1]});
  const saved=await saveDeliveryInstructionText(children[0][1],{expectedRevision:old.revision,additionalText:'Unload both split orders through the rear gate.'},
    {operatorId:sales.id,source:'sales',authorizedOrderingLocationIds:[1]});
  assert.equal(saved.orderRef,familyRef);
  await service.instructionChanged(saved.orderRef,sales.id);
  const updated=await service.get(secured.id,dispatcher,'dispatch');
  assert.equal(updated.revision,secured.revision+1);
  assert.deepEqual(updated.salesOrderRefs,children.map(child=>child[1]));
  assert.equal(updated.history.filter(event=>event.action==='instructions').length,1);
  assert.equal((await service.alerts(dispatcher,'dispatch')).requests.find(item=>item.id===secured.id).revision,updated.revision);
  assert.equal((await service.alerts(sales,'sales')).requests.some(item=>item.id===secured.id),false);
});
test('consolidation resolves every independent route concurrently and preserves cheapest-leg evidence',async()=>{
  await setup();
  await query("UPDATE mbt_yards SET address_line_1='Fixture Yard Road',city='Toronto',region='ON',country_code='CA',active=true WHERE yard_code=ANY($1::text[])",[['3445','12441']]);
  const calls=[];let release;
  const barrier=new Promise(resolve=>{release=resolve;});
  const routeService=createDeliveryRequestService({now:()=>new Date(instant),resolveDistance:async input=>{
    calls.push(input);await barrier;
    const yard=(await query('SELECT revision FROM mbt_yards WHERE yard_code=$1',[input.originYardCode])).rows[0];
    return {providerMetres:input.originYardCode==='12441' && !input.destinationYardCode?80000:20000,
      routeHash:`${input.originYardCode}>${input.destinationYardCode || 'customer'}`,
      originSnapshot:{yardCode:input.originYardCode,revision:Number(yard.revision)},destinationSnapshot:{}};
  }});
  const input=pricing({outbounds:[{originYardCode:'12441',totalUnits:1},{originYardCode:'3445',totalUnits:26}]});
  const task=routeService.quote(input,sales);
  let started;
  try {
    const deadline=Date.now()+1000;
    while(calls.length<4 && Date.now()<deadline) {await new Promise(resolve=>setTimeout(resolve,10));}
    started=calls.length;
  } finally {release();}
  const quote=await task;
  assert.equal(started,4,'all transfer and customer routes start before awaiting one result');
  assert.equal(quote.consolidationYardCode,'3445');assert.equal(quote.totalAmountMinor,70500);
  assert.equal(quote.transferLegs[0].destinationSnapshot.yardCode,'3445');
  assert.equal(Object.keys(quote.routeEvidence).length,4);
  await query("UPDATE mbt_yards SET revision=revision+1 WHERE yard_code='12441'");
  await assert.rejects(routeService.create({...input,requestedWindow:window(),quoteId:quote.id,operationId:crypto.randomUUID()},sales),{code:'DELIVERY_QUOTE_CHANGED'});
});
test('additive migration rollback preserves existing requests, Sales Orders and settings',async()=>{
  const service=await setup(),row=await submit(service);
  const beforeOrders=(await query('SELECT count(*) AS count FROM sales_orders')).rows[0].count;
  const beforeSettings=await service.getSettings();
  await withTransaction(async()=>{
    await query('DROP TABLE delivery_request_sales_orders,delivery_request_operations,delivery_request_reads,delivery_request_events,delivery_requests,delivery_request_quotes,delivery_request_settings');
    await query(await fs.readFile(new URL('../../../migrations/265_delivery_requests.sql',import.meta.url),'utf8'));
    assert.equal((await service.list(sales,'sales')).requests.length,0);
    assert.equal((await query('SELECT count(*) AS count FROM sales_orders')).rows[0].count,beforeOrders);
  },{rollback:true});
  assert.equal((await service.get(row.id,sales,'sales')).requestRef,row.requestRef);
  assert.deepEqual(await service.getSettings(),beforeSettings);
  assert.equal((await query('SELECT count(*) AS count FROM sales_orders')).rows[0].count,beforeOrders);
});
test('inactive or unconfigured consolidation yards fail before paid route requests',async()=>{
  await setup();let calls=0;
  const service=createDeliveryRequestService({resolveDistance:async()=>{calls++;return {providerMetres:20000,originSnapshot:{},destinationSnapshot:{}};}});
  const legInput=pricing({outbounds:[{originYardCode:'3445',totalUnits:1},{originYardCode:'12441',totalUnits:1}]});
  await withTransaction(async()=>{
    const beforeTickets=(await query('SELECT count(*) AS count FROM delivery_request_quotes')).rows[0].count;
    await query("UPDATE mbt_yards SET active=false WHERE yard_code='12441'");
    await assert.rejects(service.quote(legInput,sales),{code:'DELIVERY_QUOTE_UNAVAILABLE'});
    await query("UPDATE mbt_yards SET active=true,address_line_1='' WHERE yard_code='12441'");
    await assert.rejects(service.quote(legInput,sales),{code:'DELIVERY_QUOTE_UNAVAILABLE'});
    assert.equal((await query('SELECT count(*) AS count FROM delivery_request_quotes')).rows[0].count,beforeTickets);
  },{rollback:true});
  assert.equal(calls,0,'all consolidation yards must be configured before paid routing begins');
});
test('changed capacity invalidates earlier quotes and stale settings updates cannot overwrite newer settings',async()=>{
  const service=await setup(),quote=await service.quote(pricing(),sales),settings=await service.getSettings();
  const changed=await service.setSettings({...settings,pos:50,expectedRevision:settings.revision},dispatcher);
  assert.equal(changed.pos,50);assert.equal(changed.revision,settings.revision+1);
  await assert.rejects(service.setSettings({...settings,pos:10,expectedRevision:settings.revision},dispatcher),{code:'DELIVERY_STALE_REVISION'});
  await assert.rejects(service.create({...pricing(),requestedWindow:window(),quoteId:quote.id,operationId:crypto.randomUUID()},sales),{code:'DELIVERY_QUOTE_CHANGED'});
  const refreshed=await service.quote(pricing(),sales);assert.equal(refreshed.totalAmountMinor,23500);
  assert.equal((await service.create({...pricing(),requestedWindow:window(),quoteId:refreshed.id,operationId:crypto.randomUUID()},sales)).quote.capacityPerTrip,50);
});
