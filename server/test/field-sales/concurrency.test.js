import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query,closeDb } from '../../src/db.js';
import { createFieldSalesRepository } from '../../src/field-sales/repository.js';
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable test database required.');}
after(closeDb);
test('C1 simultaneous route creation cannot steal ownership; concurrent edits and visits retain one winner',async()=>{
  const original=(await query('SELECT * FROM field_sales_settings')).rows[0],repo=createFieldSalesRepository();
  try {
    await query(`UPDATE field_sales_settings SET data=jsonb_set(data,'{enabled}','true')`);
    const actors=[{id:randomUUID(),role:'field_sales'},{id:randomUUID(),role:'field_sales'}];
    for(const a of actors){await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles) VALUES($1,$1,$1,'test','test','field_sales',ARRAY['field_sales'])`,[a.id]);}
    const cmd=(actor,kind,payload)=>repo.command(actor,{id:randomUUID(),kind,payload});
    const site=(await cmd(actors[0],'jobsite.save',{id:randomUUID(),name:'Concurrent site',address:'1 Concurrency Rd'})).jobsite;
    const id=randomUUID(),stopId=randomUUID(),payload={id,name:'Concurrent route',date:'2026-09-18',stops:[{id:stopId,jobsiteId:site.id}]};
    const created=await Promise.allSettled(actors.map(a=>cmd(a,'route.save',payload)));
    assert.equal(created.filter(r=>r.status==='fulfilled').length,1);assert.equal(created.find(r=>r.status==='rejected').reason.status,403);
    const saved=await repo.getRoute(id),owner=actors.find(a=>a.id===saved.owner_id);
    const edits=await Promise.allSettled(['A','B'].map(name=>cmd(owner,'route.save',{...payload,revision:1,name})));
    assert.equal(edits.filter(r=>r.status==='fulfilled').length,1);assert.equal(edits.find(r=>r.status==='rejected').reason.status,409);
    const visits=await Promise.allSettled([1,2].map(()=>cmd(owner,'visit.record',{id:randomUUID(),routeId:id,stopId,jobsiteId:site.id,outcome:'Contact met',occurredAt:'2026-09-18T18:00:00Z'})));
    assert.equal(visits.filter(r=>r.status==='fulfilled').length,1);assert.equal(visits.find(r=>r.status==='rejected').reason.status,409);assert.equal((await repo.getJobsite(site.id)).visits.length,1);
  }finally{await query('UPDATE field_sales_settings SET data=$1,revision=$2 WHERE singleton',[JSON.stringify(original.data),original.revision]);}
});
