import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import crypto from 'node:crypto';
import {app,purchaseReceiptCatchupTick} from '../../../src/server.js';
import {config} from '../../../src/config.js';
import {query,closeDb,withTransaction} from '../../../src/db.js';
const originalSecret=config.netsuite.ifIrWebhookSecret;
const originalEnabled=config.netsuite.directAccessEnabled;
const server=app.listen(0,'127.0.0.1');
after(async()=>{config.netsuite.ifIrWebhookSecret=originalSecret;config.netsuite.directAccessEnabled=originalEnabled;
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closeDb();});
test('signed IR acknowledgement contains a durable PO job even while SCM reconciliation is busy',async()=>{
  if(!server.listening) await new Promise(resolve=>server.once('listening',resolve));
  config.netsuite.ifIrWebhookSecret=crypto.randomBytes(32).toString('hex');
  await query("INSERT INTO purchase_orders(netsuite_id,tranid,netsuite_active) VALUES(986001,'PO-IR-TEST',true)");
  await query("INSERT INTO scm_reconciliation_runs(run_key,trigger_source,scope_kind,target_order_kind,target_order_ref,status,dry_run,apply_unambiguous,requested_by) VALUES('receipt-busy','manual','order_family','PO','PO-BUSY','running',false,true,'receipt-test')");
  const eventId=crypto.randomUUID(),timestamp=String(Math.floor(Date.now()/1000));
  const body=JSON.stringify({schemaVersion:'mbbs.ifir.reconciliation.v1',eventId,action:'create',record:{recordType:'itemreceipt',id:986002,tranid:'IR-TEST',createdFrom:{id:986001,recordType:'purchaseorder',text:'PO-IR-TEST'},lines:[]}});
  const signature=crypto.createHmac('sha256',config.netsuite.ifIrWebhookSecret).update(`${timestamp}\n${eventId}\n${body}`).digest('hex');
  const send=signature=>fetch(`http://127.0.0.1:${server.address().port}/api/webhooks/netsuite/if-ir`,{method:'POST',headers:{'content-type':'application/json','x-mbbs-ifir-event-id':eventId,'x-mbbs-ifir-timestamp':timestamp,'x-mbbs-ifir-signature':signature},body});
  const first=await send(signature);assert.equal(first.status,202,await first.text());
  const job=(await query('SELECT * FROM netsuite_delayed_status_refresh_jobs WHERE netsuite_order_id=986001')).rows;
  assert.equal(job.length,1);assert.equal(job[0].status,'pending');
  const duplicate=await send(signature);assert.equal(duplicate.status,202);assert.equal((await duplicate.json()).duplicate,true);
  assert.equal((await query('SELECT count(*)::int AS n FROM netsuite_delayed_status_refresh_jobs WHERE netsuite_order_id=986001')).rows[0].n,1);
  const invalid=await send('invalid');assert.equal(invalid.status,401);
});
test('catch-up honors disabled NetSuite access and reports database failures without breaking the worker loop',async()=>{
  config.netsuite.directAccessEnabled=false;assert.deepEqual(await purchaseReceiptCatchupTick(),[]);
  config.netsuite.directAccessEnabled=true;
  assert.deepEqual(await purchaseReceiptCatchupTick(),[]);
  await withTransaction(async()=>{
    await query('ALTER TABLE sales_special_stock_cases RENAME TO receipt_test_unavailable');
    const original=console.error,errors=[];console.error=(...args)=>errors.push(args.join(' '));
    try {assert.deepEqual(await purchaseReceiptCatchupTick(),[]);assert(errors.some(s=>s.includes('Linked PO receipt catch-up failed')));}
    finally {console.error=original;}
  },{rollback:true});
});
