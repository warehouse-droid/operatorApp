import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query,withTransaction,closeDb } from '../../src/db.js';
import { createCityImporter } from '../../src/field-sales/importer.js';
import { createFieldSalesRepository } from '../../src/field-sales/repository.js';
after(closeDb);
if(process.env.MBT_TEST_ISOLATED!=='1'){throw new Error('Disposable test database required.');}

test('I4 complete import is repeatable, preserves sales edits, and rejects a changed snapshot atomically',()=>withTransaction(async()=>{
  const actor={id:randomUUID(),role:'field_sales'},folder=970000001;
  await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles) VALUES($1,$1,'Import test','test','test','field_sales',ARRAY['field_sales'])`,[actor.id]);
  await query(`UPDATE field_sales_settings SET data=jsonb_set(data,'{enabled}','true')`);
  let changed=false,metadataCalls=0;
  const attributes=i=>({OBJECTID:i,FOLDERRSN:folder,PROPERTYRSN:i,FULL_ADDRESS:`${i} Test Road`,APPLICATION_TYPE:'Community planning',STATUS_GROUP:'Open',DISTRICT_NAME:'West',WARD_NUMBER:'01',LATEST_MILESTONE:'Statement of Approval Issued',LATITUDE:43.7,LONGITUDE:-79.5});
  const fetchJson=async value=>{const u=new URL(value);if(u.searchParams.get('returnCountOnly')){return {count:2};}if(u.pathname.endsWith('/query')){return {features:[1,2].map(i=>({attributes:attributes(i)}))};}metadataCalls++;return {editingInfo:{lastEditDate:changed&&metadataCalls%2===0?2:1}};};
  const repo=createFieldSalesRepository(),importer=createCityImporter(repo,{fetchJson});
  await importer.run('planning');
  const site=(await query(`SELECT * FROM field_sales_jobsites WHERE source_group=$1`,[`planning:${folder}`])).rows[0];
  assert.equal((await repo.getJobsite(site.id)).sources.length,2);
  await repo.command(actor,{id:randomUUID(),kind:'jobsite.save',payload:{...site,name:'Rep adjusted name',priority:3}});
  await repo.command(actor,{id:randomUUID(),kind:'note.add',payload:{id:randomUUID(),jobsiteId:site.id,body:'Preserve this conversation'}});
  await importer.run('planning');
  const refreshed=await repo.getJobsite(site.id);assert.equal(refreshed.name,'Rep adjusted name');assert.equal(refreshed.priority,3);assert.equal(refreshed.notes[0].body,'Preserve this conversation');assert.equal(refreshed.sources.length,2);
  changed=true;await assert.rejects(importer.run('planning'),/changed during import/);
  const retained=await repo.getJobsite(site.id);assert.equal(retained.sources.filter(s=>s.present).length,2);assert.equal(retained.notes.length,1);
  const history=await importer.history();assert.equal(history[0].state,'failed');assert.match(history[0].error,/changed during import/);
  assert.equal((await query('SELECT count(*)::int AS n FROM field_sales_import_stage')).rows[0].n,0);
}, {rollback:true}));
