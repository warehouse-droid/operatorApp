import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { before, after } from 'node:test';
import { app } from '../../../src/server.js';
import { query, closeDb, withTransaction } from '../../../src/db.js';
import { assertOperatorUploadYard, assertOperatorOrderYard } from '../../../src/operator-yard-authorization.js';
import { createOperator, loginOperator } from '../../../src/auth-repository.js';
import { listReceivingOrders, listReceivingVendors, searchReceivingItems, getReceivingOrder,
  getReceivableReceivingOrder, buildItemReceiptPayload, recordReceivingReceipt } from '../../../src/receiving-repository.js';
import { createOperatorNetSuitePostingTargetResolver } from '../../../src/operator-netsuite-posting-targets.js';

const poId = 8899301728;
let server, base, yard3445, yard2967, foreign, multi;
const lineIds = [];
const yard1Items = ['XP Bond 28oz', 'MAXX Grey', 'MAXX Ivory', 'Supersand Grey'];

async function account(grants) {
  const username = `receiving-multiyard-${crypto.randomUUID()}`;
  const password = crypto.randomUUID();
  await createOperator({ username, password, displayName: 'Receiving multi-yard test', role: 'operator', operatorYardLocationIds: grants });
  return loginOperator(username, password);
}

async function request(session, suffix, method = 'GET', body) {
  const response = await fetch(`${base}/api/receiving/${suffix}`, { method,
    headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}

before(async () => {
  assert.equal(process.env.MBT_TEST_ISOLATED, '1');
  [yard3445, yard2967, foreign, multi] = await Promise.all([[1], [28], [15], [1, 28]].map(account));
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,vendor_id,vendor,status,status_text,
    destination_location_id,destination_location,netsuite_active) VALUES($1,'POB-MULTIYARD','SN-MULTIYARD',889930,'Multi-yard vendor','B','Pending Receipt',28,'2967',true)`, [poId]);
  const data = [[28,'XP Bond 28oz',720,1],[1,'XP Bond 28oz',720,1],[28,'MAXX Grey',70,1],
    [28,'Supersand Grey',140,2],[1,'MAXX Grey',70,1],[1,'MAXX Ivory',70,1],[1,'Supersand Grey',140,2]];
  for (const [index, [yard, item, quantity, pallets]] of data.entries()) {
    const inserted = await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,
      item_type,quantity,unit,location_id,location,pallet_qty,to_plt,netsuite_active)
      VALUES($1,$2,$3,$4,'InvtPart',$5,'EACH',$6,$7,$8,$9,true) RETURNING id`,
    [poId,index+1,889930+yard1Items.indexOf(item),item,quantity,yard,yard===1?'3445':'2967',pallets,quantity/pallets]);
    lineIds.push(inserted.rows[0].id);
  }
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {await new Promise(resolve => server.close(resolve));}
  await query('DELETE FROM receiving_receipt_records WHERE order_id=ANY($1::bigint[])',[[poId,poId+1]]);
  await query('DELETE FROM purchase_order_lines WHERE purchase_order_id=ANY($1::bigint[])',[[poId,poId+1]]);
  await query('DELETE FROM purchase_orders WHERE netsuite_id=ANY($1::bigint[])',[[poId,poId+1]]);
  await closeDb();
});

test('SN1401728 shape is discoverable by order vendor and own-yard item with scoped counts', async () => {
  for (const [yard, count] of [[1,4],[28,3]]) {
    const listed = await listReceivingOrders({ orderType:'purchase_order',destinationLocationId:yard,search:'SN-MULTIYARD' });
    assert.equal(listed.length,1);
    assert.equal(listed[0].line_count,count);
    assert.ok((await listReceivingVendors({destinationLocationId:yard})).some(row=>row.vendor==='Multi-yard vendor'));
    assert.equal((await searchReceivingItems({orderType:'purchase_order',destinationLocationId:yard,search:'MAXX'})).length,yard===1?2:1);
  }
  assert.equal((await listReceivingOrders({orderType:'purchase_order',destinationLocationId:28,itemSearch:'Ivory'})).length,0);
  assert.equal((await listReceivingOrders({orderType:'purchase_order',destinationLocationId:15,search:'SN-MULTIYARD'})).length,0);
});

test('detail and legacy one-yard requests expose only the selected yard lines', async () => {
  for (const [session,yard,count] of [[yard3445,1,4],[yard2967,28,3],[multi,1,4],[multi,28,3]]) {
    const result = await request(session,`orders/${poId}?orderType=purchase_order&locationId=${yard}`);
    assert.equal(result.status,200,JSON.stringify(result.data));
    assert.equal(Number(result.data.destination_location_id),yard);
    assert.equal(result.data.lines.length,count);
    assert.ok(result.data.lines.every(line=>Number(line.location_id)===yard));
  }
  const legacy = await request(yard3445,`orders/${poId}?orderType=purchase_order`);
  assert.equal(legacy.status,200);
  assert.equal(legacy.data.lines.length,4);
});

test('refresh reports only the selected yard lines without changing received drafts', async () => {
  const beforeRows=(await query('SELECT id,received_pallet_qty,confirmed_at FROM purchase_order_lines WHERE purchase_order_id=$1 ORDER BY id',[poId])).rows;
  const result=await request(yard3445,`orders/${poId}/sync`,'POST',{locationId:1,orderType:'purchase_order'});
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.synced.lines,4);
  assert.deepEqual((await query('SELECT id,received_pallet_qty,confirmed_at FROM purchase_order_lines WHERE purchase_order_id=$1 ORDER BY id',[poId])).rows,beforeRows);
});

test('foreign lines and bulk requests are denied before draft changes', async () => {
  await assert.rejects(assertOperatorOrderYard(foreign.operator,poId,{receiving:true,destinationLocationId:1}),{status:403});
  const beforeRows=(await query('SELECT id,received_pallet_qty,confirmed_at FROM purchase_order_lines WHERE purchase_order_id=$1 ORDER BY id',[poId])).rows;
  for(const [tail,method,body] of [
    ['', 'GET'], ['/sync','POST',{locationId:15}],
    [`/lines/${lineIds[0]}/confirm`,'POST',{locationId:1,pallets:1}],
    [`/lines/${lineIds[0]}/unconfirm`,'POST',{locationId:1}],
    ['/lines/confirm-page','POST',{locationId:1,lines:[{lineId:lineIds[1],values:{pallets:1}},{lineId:lineIds[0],values:{pallets:1}}]}],
    ['/receive','POST',{locationId:15}]
  ]) {
    const actor=tail.includes('/lines/')?yard3445:foreign;
    const response=await request(actor,`orders/${poId}${tail}`,method,body);
    assert.equal(response.status,403,JSON.stringify(response));
  }
  assert.deepEqual((await query('SELECT id,received_pallet_qty,confirmed_at FROM purchase_order_lines WHERE purchase_order_id=$1 ORDER BY id',[poId])).rows,beforeRows);
});

test('confirm unconfirm page confirmation and recovery retain the selected receiving yard', async () => {
  const path=`orders/${poId}/lines/${lineIds[1]}`;
  const confirmed=await request(yard3445,`${path}/confirm`,'POST',{locationId:1,pallets:1,orderType:'purchase_order'});
  assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.lines.length,4);
  const unconfirmed=await request(yard3445,`${path}/unconfirm`,'POST',{locationId:1,orderType:'purchase_order'});
  assert.equal(unconfirmed.status,200);
  assert.equal(unconfirmed.data.lines.length,4);
  const ids=[1,4,5,6].map(index=>lineIds[index]);
  const page=await request(yard3445,`orders/${poId}/lines/confirm-page`,'POST',
    {locationId:1,orderType:'purchase_order',lines:ids.map((lineId,index)=>({lineId,values:{pallets:index===3?2:1}}))});
  assert.equal(page.status,200,JSON.stringify(page.data));
  assert.equal(page.data.confirmed,4);
  assert.equal(page.data.order.lines.length,4);
  const recovery=await request(yard3445,`orders/${poId}/posting-status?locationId=1`);
  assert.equal(recovery.status,200,JSON.stringify(recovery.data));
  assert.equal(recovery.data.order.destination_location_id,1);
  assert.equal(await assertOperatorUploadYard(multi.operator,{recordType:'operator-receiving-photo',orderId:poId,locationId:1}),1);
  await assert.rejects(assertOperatorUploadYard(foreign.operator,{recordType:'operator-receiving-photo',orderId:poId,locationId:15}),{status:403});
});

test('receipt and posting target select five pallets at 3445 and explicitly skip 2967', async () => {
  // Confirmed draft values at another yard must not enter this receipt.
  await query('UPDATE purchase_order_lines SET received_pallet_qty=pallet_qty,confirmed_at=now() WHERE purchase_order_id=$1 AND location_id=1',[poId]);
  await query('UPDATE purchase_order_lines SET received_pallet_qty=1,confirmed_at=now() WHERE id=$1',[lineIds[0]]);
  const order=await getReceivableReceivingOrder(poId,{destinationLocationId:1});
  assert.equal(order.receivableLines.length,4);
  const payload=buildItemReceiptPayload(order,order.receivableLines);
  assert.deepEqual(payload.item.items.filter(item=>item.itemReceive).map(item=>item.orderLine),[2,5,6,7]);
  assert.deepEqual(payload.item.items.filter(item=>!item.itemReceive).map(item=>item.orderLine),[1,3,4]);
  assert.ok(payload.item.items.filter(item=>item.itemReceive).every(item=>item.location===1));
  const resolve=createOperatorNetSuitePostingTargetResolver({getDeliveryOrder:async()=>null,
    getReceivableReceivingOrder:()=>getReceivableReceivingOrder(poId),
    resolveRealSource:async()=>({sourceOrderKind:'PO',sourceNetSuiteId:poId,sourceOrderRef:'POB-MULTIYARD',
      lineMap:Object.fromEntries(Array.from({length:7},(_,index)=>[index+1,index+1])),
      availableLines:order.lines.map(line=>({orderLine:Number(line.line_id),itemId:Number(line.item_id),quantity:Number(line.original_quantity),remainingQuantity:Number(line.quantity),location:Number(line.location_id)}))})});
  await assert.rejects(resolve({functionKey:'receiving',orderId:poId,clientLocationId:15}),
    {code:'OPERATOR_NETSUITE_POSTING_LOCATION_MISMATCH'});
  const target=await resolve({functionKey:'receiving',orderId:poId,clientLocationId:1});
  assert.equal(target.canonicalLocationId,1);
  assert.deepEqual(target.targets[0].selectedLines.map(line=>line.orderLine),[2,5,6,7]);
  assert.ok(target.targets[0].selectedLines.every(line=>line.location===1));
});

test('a skipped line without a location retains its original header yard',()=>withTransaction(async()=>{
  await query('UPDATE purchase_order_lines SET location_id=NULL WHERE id=$1',[lineIds[0]]);
  const order=await getReceivableReceivingOrder(poId,{destinationLocationId:1});
  const payload=buildItemReceiptPayload(order,order.receivableLines);
  const inherited=payload.item.items.find(item=>item.orderLine===1);
  assert.equal(inherited.itemReceive,false);
  assert.equal(inherited.location,28);
},{rollback:true}));

test('the real receive route records only the selected yard and keeps the receipt job accessible',async()=>{
  const clone=poId+1;
  await query(`INSERT INTO purchase_orders(netsuite_id,tranid,dispatch_ref,status,status_text,destination_location_id,destination_location,netsuite_active)
    VALUES($1,'POB-MULTIYARD-HTTP','SN-MULTIYARD-HTTP','B','Pending Receipt',28,'2967',true)`,[clone]);
  await query(`INSERT INTO purchase_order_lines(purchase_order_id,line_id,item_id,item_name,item_type,quantity,unit,
    location_id,location,pallet_qty,to_plt,netsuite_active,received_pallet_qty,confirmed_at)
    SELECT $1,line_id,item_id,item_name,item_type,quantity,unit,location_id,location,pallet_qty,to_plt,
      netsuite_active,received_pallet_qty,confirmed_at FROM purchase_order_lines WHERE purchase_order_id=$2`,[clone,poId]);
  const result=await request(yard3445,`orders/${clone}/receive`,'POST',{orderType:'purchase_order',locationId:1,
    photoDataUrls:['data:image/png;base64,AA==','data:image/png;base64,AQ==']});
  assert.equal(result.status,200,JSON.stringify(result.data));
  const jobId=result.data.jobId;
  assert.ok(jobId);
  let job;
  for(let attempt=0;attempt<30;attempt+=1) {
    job=await request(yard3445,`receipt-jobs/${jobId}`);
    assert.equal(job.status,200,JSON.stringify(job.data));
    if(job.data.status!=='running') {break;}
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(job.data.status,'complete',JSON.stringify(job.data));
  assert.equal(job.data.result.receiptStatus,'partial_received');
  const saved=(await query('SELECT payload FROM receiving_receipt_records WHERE order_id=$1',[clone])).rows[0].payload;
  assert.deepEqual(saved.item.items.filter(item=>item.itemReceive).map(item=>item.orderLine),[2,5,6,7]);
  assert.deepEqual(saved.item.items.filter(item=>!item.itemReceive).map(item=>item.orderLine),[1,3,4]);
  assert.equal((await request(foreign,`receipt-jobs/${jobId}`)).status,403);
});

test('a completed yard receipt leaves the other yard open and prevents duplicate quantities', async () => {
  const order=await getReceivableReceivingOrder(poId,{destinationLocationId:1});
  const payload=buildItemReceiptPayload(order,order.receivableLines);
  const options={photoDataUrls:['data:image/png;base64,AA==','data:image/png;base64,AQ=='],payload,response:{},itemReceiptId:889931728,itemReceiptTranid:'IR-MULTIYARD'};
  const recorded=await recordReceivingReceipt(poId,yard3445.operator.id,options);
  assert.equal(recorded.receiptStatus,'partial_received');
  assert.deepEqual(await recordReceivingReceipt(poId,yard3445.operator.id,options),recorded);
  const remaining=await getReceivingOrder(poId);
  assert.ok(remaining.lines.filter(line=>Number(line.location_id)===1).every(line=>Number(line.quantity)===0));
  assert.deepEqual(remaining.lines.filter(line=>Number(line.location_id)===28).map(line=>Number(line.quantity)),[720,70,140]);
  await assert.rejects(getReceivableReceivingOrder(poId,{destinationLocationId:1}),/No confirmed lines to receive/);
  assert.equal((await query('SELECT count(*)::int AS count FROM receiving_receipt_records WHERE order_id=$1',[poId])).rows[0].count,1);
  const recovered=await request(yard3445,`orders/${poId}/posting-status?locationId=1`);
  assert.equal(recovered.status,200);
  assert.equal(recovered.data.order.destination_location_id,1);
});
