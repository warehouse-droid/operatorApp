import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { query, withTransaction, closeDb } from '../../src/db.js';
import { createFieldSalesRepository } from '../../src/field-sales/repository.js';

if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Isolated test database required');}
after(closeDb);
async function fixture(run) {
  return withTransaction(async()=>{
    const rep={id:randomUUID(),role:'field_sales'},other={id:randomUUID(),role:'field_sales'},admin={id:randomUUID(),role:'admin'};
    for(const a of [rep,other,admin]) {await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles) VALUES($1,$1,$1,'test','test',$2,ARRAY[$2]::text[])`,[a.id,a.role]);}
    const repo=createFieldSalesRepository();
    await repo.saveSettings(admin,{revision:(await repo.settings()).revision,data:{enabled:true,importsEnabled:false,postingEnabled:false,companies:{MBBS:{taxBps:1300},MBT:{taxBps:1300}}}});
    await query(`INSERT INTO field_sales_catalog(company,item_id,sku,description,unit_rate) VALUES('MBBS','123','BLOCK','Block','19.99'),('MBT','456','BIN','Bin','100') ON CONFLICT DO NOTHING`);
    const site=(await repo.command(rep,{id:randomUUID(),kind:'jobsite.save',payload:{id:randomUUID(),name:'Belfield',address:'90 Belfield Rd',latitude:43.7,longitude:-79.5}})).jobsite;
    await run({repo,rep,other,admin,site});
  },{rollback:true});
}
test('D1 idempotent commands retain original result and reject different payload',()=>fixture(async({repo,rep,site})=>{
  const command={id:randomUUID(),kind:'note.add',payload:{id:randomUUID(),jobsiteId:site.id,body:'Contact met'}};
  assert.deepEqual(await repo.command(rep,command),await repo.command(rep,command));
  assert.equal((await repo.getJobsite(site.id)).notes.length,1);
  await assert.rejects(repo.command(rep,{...command,payload:{...command.payload,body:'Changed'}}),e=>e.status===409);
}));
test('D2 route ownership, stale revisions and preserved completed history',()=>fixture(async({repo,rep,other,site})=>{
  const id=randomUUID(),stopId=randomUUID();
  const saved=await repo.command(rep,{id:randomUUID(),kind:'route.save',payload:{id,name:'North afternoon',date:'2026-09-18',period:'afternoon',stops:[{id:stopId,jobsiteId:site.id,address:site.address,latitude:site.latitude,longitude:site.longitude}]}});
  assert.equal(saved.route.revision,1);
  await assert.rejects(repo.command(other,{id:randomUUID(),kind:'route.save',payload:{...saved.route.data,id,revision:1,name:'Hijack',date:'2026-09-18'}}),e=>e.status===403);
  const visitId=randomUUID();
  const visit={id:randomUUID(),kind:'visit.record',payload:{id:visitId,jobsiteId:site.id,routeId:id,stopId,outcome:'Quote requested',occurredAt:'2026-09-18T18:00:00Z',revisitDate:'2026-10-02',revisitPriority:3}};
  await repo.command(rep,visit);await repo.command(rep,visit);
  assert.equal((await repo.getJobsite(site.id)).visits.length,1);
  assert.equal((await repo.listFollowups(rep)).length,1);
  await assert.rejects(repo.command(rep,{id:randomUUID(),kind:'route.save',payload:{id,revision:1,name:'Old copy',date:'2026-09-18',stops:[]}}),e=>e.status===409);
  const route=await repo.getRoute(id);
  const edited=await repo.command(rep,{id:randomUUID(),kind:'route.save',payload:{...route.data,id,revision:route.revision,name:route.name,date:'2026-09-18',stops:[]}});
  assert.equal(edited.route.data.stops[0].status,'completed');
}));
test('D3 immutable quote revisions, exact snapshots and retired publication',()=>fixture(async({repo,rep,site})=>{
  const cmd=(kind,payload)=>repo.command(rep,{id:randomUUID(),kind,payload});
  const customer=(await cmd('customer.save',{id:randomUUID(),name:'New Builder'})).customer;
  await cmd('customer.link',{customerId:customer.id,jobsiteId:site.id});
  const id=randomUUID(),payload={id,company:'MBBS',jobsiteId:site.id,fieldSalesCustomerId:customer.id,lines:[{id:'a',company:'MBBS',itemId:'123',description:'Block',quantity:'3',unitRate:'19.99'}]};
  const first=await cmd('quote.save',payload);assert.equal(first.quote.snapshot.totalMinor,6777);
  await cmd('customer.save',{...customer,name:'Revised Builder'});
  const next=await cmd('quote.save',{...payload,revision:1});assert.equal(next.quote.revision,2);
  assert.equal((await repo.getQuote(id,1)).snapshot.customerName,'New Builder');
  assert.equal(next.quote.snapshot.customerName,'Revised Builder');
  await assert.rejects(cmd('quote.save',{...payload,revision:1}),e=>e.status===409);
  await assert.rejects(cmd('quote.publish',{id,revision:2}),/Sales Order|local/);
}));
test('D4 merges retain notes, sources and quote associations',()=>fixture(async({repo,rep,site})=>{
  const second=(await repo.command(rep,{id:randomUUID(),kind:'jobsite.save',payload:{id:randomUUID(),name:'Alias',address:'90 Belfield Road'}})).jobsite;
  await repo.command(rep,{id:randomUUID(),kind:'note.add',payload:{id:randomUUID(),jobsiteId:second.id,body:'Alias note'}});
  await repo.command(rep,{id:randomUUID(),kind:'jobsite.merge',payload:{fromId:second.id,toId:site.id}});
  assert.equal((await repo.getJobsite(site.id)).notes.length,1);
  assert.equal((await repo.getJobsite(second.id)).id,site.id);
}));
