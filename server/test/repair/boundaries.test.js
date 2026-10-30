import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {createRepairWorker} from '../../src/repair/worker.js';
import {validateRepairMedia} from '../../src/repair/media.js';
import {assertRepairVehicleAvailable} from '../../src/repair/guards.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');after(closeDb);
test('media verifies image bytes, rejects disguised payloads, and preserves original PDF',async()=>{
 const image=await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer();
 assert.equal((await validateRepairMedia(image,'image/png','work')).byteSize,image.length);
 await assert.rejects(validateRepairMedia(Buffer.from('<script>alert(1)</script>'),'image/png','work'),/image|invalid/i);
 const pdf=Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');
 assert.equal((await validateRepairMedia(pdf,'application/pdf','receipt')).bytes,pdf);
 await assert.rejects(validateRepairMedia(pdf,'application/pdf','handover'),/photo|image/i);
});
test('posting gate performs zero network writes and expired leases become attention, never automatic repost',()=>withTransaction(async()=>{
 let calls=0;const worker=createRepairWorker({query,transaction:withTransaction,enabled:()=>false,adapter:{inspection:async()=>{calls++;}}});
 assert.deepEqual(await worker.tick(),{enabled:false});assert.equal(calls,0);
 const id=randomUUID();await query("INSERT INTO repair_postings(id,kind,state,lease_until) VALUES($1,'work_update','working',now()-interval '1 hour')",[id]);
 const active=createRepairWorker({query,transaction:withTransaction,enabled:()=>true,adapter:{}});await active.tick();
 assert.equal((await query('SELECT state FROM repair_postings WHERE id=$1',[id])).rows[0].state,'uncertain');
}, {rollback:true}));
test('out-of-service blocks new starts and later planning, but completed receipt releases only that repair',()=>withTransaction(async()=>{
 const vehicle=randomUUID();await query("INSERT INTO repair_vehicles(id,company,customer_id,plate) VALUES($1,'MBT','7973','GUARD')",[vehicle]);
 const id=randomUUID();await query("INSERT INTO repair_requests(id,vehicle_id,company,requester_type,requester_id,condition,inspection_fee_minor,inspection_tax_bps) VALUES($1,$2,'MBT','driver','1','out_of_service',15000,1300)",[id,vehicle]);
 await assert.rejects(assertRepairVehicleAvailable({vehicleId:vehicle,enabled:true}),error=>error.code==='REPAIR_OUT_OF_SERVICE');
 await query("UPDATE repair_requests SET status='completed',receipt='accepted',outcome='declined' WHERE id=$1",[id]);
 await assert.rejects(assertRepairVehicleAvailable({vehicleId:vehicle,enabled:true}),error=>error.code==='REPAIR_OUT_OF_SERVICE');
 await query("UPDATE repair_requests SET outcome='repaired' WHERE id=$1",[id]);await assertRepairVehicleAvailable({vehicleId:vehicle,enabled:true});
}, {rollback:true}));
test('partial NetSuite success preserves the WOR reference and uncertain posting never retries itself',()=>withTransaction(async()=>{
 await query('DELETE FROM repair_postings');await query("UPDATE repair_settings SET data=jsonb_set(data,'{postingEnabled}','true')");
 const vehicle=randomUUID(),id=randomUUID();await query("INSERT INTO repair_vehicles(id,company,customer_id,plate) VALUES($1,'MBT','7973','WORKER')",[vehicle]);
 await query("INSERT INTO repair_requests(id,vehicle_id,company,requester_type,requester_id,condition,inspection_fee_minor,inspection_tax_bps) VALUES($1,$2,'MBT','driver','worker','can_operate',15000,1300)",[id,vehicle]);
 await query("INSERT INTO repair_postings(id,request_id,kind) VALUES($1,$2,'inspection')",[randomUUID(),id]);let calls=0;
 const worker=createRepairWorker({query,transaction:withTransaction,enabled:()=>true,adapter:{inspection:async(_job,_mapping,remember)=>{calls++;await remember({worId:'405'});throw new Error('Connection lost after WOR');}}});
 assert.equal((await worker.tick()).state,'uncertain');assert.equal((await query('SELECT data FROM repair_requests WHERE id=$1',[id])).rows[0].data.worId,'405');
 await worker.tick();assert.equal(calls,1);assert.ok((await query("SELECT id FROM repair_notifications WHERE request_id=$1 AND kind='posting_attention'",[id])).rowCount);
}, {rollback:true}));
