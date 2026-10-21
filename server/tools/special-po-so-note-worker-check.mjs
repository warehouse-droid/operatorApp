import assert from 'node:assert/strict';
import {beginRollbackContext,query,closeDb} from '../src/db.js';
import {upsertPurchaseOrders} from '../src/order-sync-repository.js';
import {getNetSuiteMirrorOrderSnapshot} from '../src/netsuite-mirror-repository.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
const rollback=await beginRollbackContext();
try {await rollback.run(async()=>{
  const id=9_700_000_000_000+Date.now();
  const header={id,tranid:'TEST-WORKER-NOTE-'+id,trandate:'2099-01-01',vendor:'TEST worker Note',
    status:'B',status_text:'Pending Receipt',memo:'Original Remark',destination_location_id:1,destination_location:'3445'};
  await upsertPurchaseOrders([{...header,netsuite_note:'for SOB121819'}]);
  await upsertPurchaseOrders([header]);
  assert.equal((await getNetSuiteMirrorOrderSnapshot('purchase_order',id)).header.netsuite_note,'for SOB121819');
  await upsertPurchaseOrders([{...header,netsuite_note:'for SOB121820'}]);
  assert.equal((await getNetSuiteMirrorOrderSnapshot('purchase_order',id)).header.netsuite_note,'for SOB121820');
  await upsertPurchaseOrders([{...header,netsuite_note:''}]);
  const row=(await query('SELECT memo,netsuite_note FROM purchase_orders WHERE netsuite_id=$1',[id])).rows[0];
  assert.deepEqual(row,{memo:'Original Remark',netsuite_note:''});
  console.log(JSON.stringify({isolated:true,poNoteSync:true,mirrorNote:true,partialPayloadPreserved:true,clearingVerified:true}));
});} finally {await rollback.rollback();await closeDb();}
