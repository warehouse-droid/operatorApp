import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {app} from '../../src/server.js';
import {createOperator} from '../../src/auth-repository.js';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {pdfText} from '../field-sales/pdf-text.js';
import {fields} from './fixtures.js';
import {createMbrEquipmentRepository} from '../../src/mbr/equipment-repository.js';
const roster=JSON.parse(await readFile(new URL('./equipment-roster.json',import.meta.url),'utf8'))
  .map(([brand,model,description,unitCode,serialNumber])=>({brand,model,description,unitCode,serialNumber,active:true}));

assert.equal(process.env.MBT_TEST_ISOLATED,'1','Use the bounded disposable MBR gauntlet.');
let server,base;
const sessions={};
before(async()=>{
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  for(const [key,role] of [['mbr','mbr_sales'],['admin','admin'],['sales','sales']]) {
    const username='mbr-equipment-'+randomUUID(),password='equipment-test-only';
    await createOperator({username,displayName:key,role,password,yardLocationIds:role==='sales'?[1]:[]});
    const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
    assert.equal(response.status,200);sessions[key]=(await response.json()).token;
  }
});
after(async()=>{server?.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closeDb();});
async function request(path,{actor='mbr',method='GET',body,headers={}}={}) {
  const response=await fetch(base+'/api/mbr'+path,{method,headers:{...(actor?{authorization:'Bearer '+sessions[actor]}:{}),
    ...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
  const bytes=Buffer.from(await response.arrayBuffer());
  return {status:response.status,headers:response.headers,bytes,body:response.headers.get('content-type')?.includes('json')?JSON.parse(bytes):null};
}
const input=row=>({brand:row.brand,model:row.model,description:row.description,unitCode:row.unitCode,serialNumber:row.serialNumber,active:row.active});
const pair=row=>({equipmentModel:row.model,serialNumber:row.serialNumber});

test('setup storage failures propagate without partial equipment writes',async()=>{
  const repository=createMbrEquipmentRepository(),actor=(await request('/status')).body.operator;
  const beforeRows=(await request('/setup/equipment')).body.items;
  for(const operation of ['add','edit']) {
    await withTransaction(async()=>{
      await query('ALTER TABLE mbr_equipment RENAME TO mbr_equipment_unavailable');
      const attempt=operation==='add'?repository.add(actor,input(beforeRows[0])):
        repository.edit(actor,beforeRows[0].id,{...input(beforeRows[0]),revision:beforeRows[0].revision});
      await assert.rejects(attempt,{code:'42P01'});
    },{rollback:true});
  }
  assert.deepEqual((await request('/setup/equipment')).body.items,beforeRows);
});

test('migration loads exactly the supplied 38-unit roster and leaves contract tables intact',async()=>{
  const response=await request('/setup/equipment');assert.equal(response.status,200);
  const rows=response.body.items.map(input).sort((a,b)=>a.serialNumber.localeCompare(b.serialNumber));
  assert.deepEqual(rows,[...roster].sort((a,b)=>a.serialNumber.localeCompare(b.serialNumber)));
  const beforeRows=await query('SELECT count(*) FROM mbr_contracts');
  const sql=await readFile(new URL('../../migrations/287_mbr_equipment.sql',import.meta.url),'utf8');
  await withTransaction(async()=>{
    await query('DROP TABLE mbr_equipment');await query(sql);
    assert.equal((await query('SELECT count(*) FROM mbr_equipment')).rows[0].count,'38');
  },{rollback:true});
  assert.deepEqual((await query('SELECT count(*) FROM mbr_contracts')).rows,beforeRows.rows);
  assert.equal((await request('/setup/equipment')).body.items.length,38);
});

test('setup requires staff MBR authority for every read and write, including valid customer tokens',async()=>{
  for(const actor of [null,'sales']) {
    for(const [path,method] of [['/setup/equipment','GET'],['/setup/equipment','POST'],['/setup/equipment/1','PATCH']]) {
      const result=await request(path,{actor,method,body:method==='GET'?undefined:input(roster[0])});
      assert.equal(result.status,actor?403:401);
    }
  }
  assert.equal((await request('/setup/equipment',{actor:'admin'})).status,200);
  const c=await request('/contracts',{method:'POST',body:fields()});assert.equal(c.status,201);
  const link=await request(`/contracts/${c.body.id}/link`,{method:'POST',body:{revision:1}});
  const token=new URL(link.body.url).hash.slice(1);
  assert.equal((await request('/setup/equipment',{actor:null,headers:{'x-mbr-contract-token':token}})).status,401);
  const page=await fetch(base+'/mbr/setup');assert.equal(page.status,200);
  assert.match(await page.text(),/MBR Setup/u);assert.match(page.headers.get('cache-control'),/no-store/u);
});

test('setup supports persistence, duplicate rejection, inactive units, and stale/concurrent edit protection',async t=>{
  const fresh={...input(roster[0]),model:'Test model',unitCode:'TEST-'+randomUUID(),serialNumber:'SN-'+randomUUID()};
  const created=await request('/setup/equipment',{method:'POST',body:fresh});assert.equal(created.status,201);
  const row=created.body;assert.equal(row.revision,1);
  t.after(()=>query('DELETE FROM mbr_equipment WHERE id=$1',[row.id]));
  assert.deepEqual(input(row),fresh);
  for(const duplicate of [{...fresh,unitCode:'UNIQUE-'+randomUUID()},{...fresh,serialNumber:'UNIQUE-'+randomUUID()}]) {
    assert.equal((await request('/setup/equipment',{method:'POST',body:duplicate})).status,409);
  }
  const results=await Promise.all([true,false].map(active=>request('/setup/equipment/'+row.id,
    {method:'PATCH',body:{...fresh,active,revision:1}})));
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  const current=results.find(result=>result.status===200).body;
  const inactive=await request('/setup/equipment/'+row.id,{method:'PATCH',body:{...fresh,active:false,revision:current.revision}});
  assert.equal(inactive.status,200);assert.equal(inactive.body.revision,3);
  assert.equal((await request('/setup/equipment')).body.items.find(item=>item.id===row.id).active,false);
  assert.equal((await request('/contracts',{method:'POST',body:fields(pair(inactive.body))})).status,400);
  assert.equal((await request('/setup/equipment/999999999',{method:'PATCH',body:{...fresh,revision:1}})).status,404);
  assert.equal((await request('/setup/equipment/invalid',{method:'PATCH',body:{...fresh,revision:1}})).status,400);
  for(const body of [{...fresh,revision:0},{...fresh,revision:'1'},{...fresh,revision:1,active:'false'},{...fresh,revision:1,model:'Bad\nModel'}]) {
    assert.equal((await request('/setup/equipment/'+row.id,{method:'PATCH',body})).status,400);
  }
});

test('mismatched and unknown model/SN pairs fail creation, editing and renewal without new revisions',async()=>{
  const invalid={equipmentModel:roster[0].model,serialNumber:roster[2].serialNumber};
  for(const override of [invalid,{equipmentModel:'Unknown',serialNumber:'UNKNOWN'}]) {
    assert.equal((await request('/contracts',{method:'POST',body:fields(override)})).status,400);
  }
  const c=await request('/contracts',{method:'POST',body:fields()});assert.equal(c.status,201);
  const edited=await request('/contracts/'+c.body.id,{method:'PATCH',body:fields({...invalid,revision:1})});assert.equal(edited.status,400);
  assert.equal((await request('/contracts/'+c.body.id)).body.revision,1);
  await request(`/contracts/${c.body.id}/link`,{method:'POST',body:{revision:1}});
  await query('UPDATE mbr_contracts SET expires_at=clock_timestamp() WHERE id=$1',[c.body.id]);
  assert.equal((await request(`/contracts/${c.body.id}/renew`,{method:'POST',body:fields({...invalid,revision:1})})).status,400);
  assert.equal((await request('/contracts/'+c.body.id)).body.revision,1);
});

test('historical free-text equipment remains editable and renewable but cannot be newly created',async()=>{
  const c=await request('/contracts',{method:'POST',body:fields()});assert.equal(c.status,201);
  const old={equipmentModel:'Legacy CAT 259D',serialNumber:'LEGACY-SN'};
  await query(`UPDATE mbr_contract_revisions SET snapshot=jsonb_set(jsonb_set(snapshot,'{fields,equipmentModel}',$2::jsonb),'{fields,serialNumber}',$3::jsonb)
    WHERE contract_id=$1 AND revision=1`,[c.body.id,JSON.stringify(old.equipmentModel),JSON.stringify(old.serialNumber)]);
  const edited=await request('/contracts/'+c.body.id,{method:'PATCH',body:fields({...old,revision:1,lessee:'Legacy customer'})});assert.equal(edited.status,200);
  assert.deepEqual(pair({model:edited.body.fields.equipmentModel,serialNumber:edited.body.fields.serialNumber}),old);
  await request(`/contracts/${c.body.id}/link`,{method:'POST',body:{revision:2}});
  await query('UPDATE mbr_contracts SET expires_at=clock_timestamp() WHERE id=$1',[c.body.id]);
  assert.equal((await request(`/contracts/${c.body.id}/renew`,{method:'POST',body:fields({...old,revision:2})})).status,200);
  assert.equal((await request('/contracts',{method:'POST',body:fields(old)})).status,400);
});

test('deactivating equipment preserves old contract terms and rejects new use; reactivation restores availability',async()=>{
  const c=await request('/contracts',{method:'POST',body:fields()});assert.equal(c.status,201);
  const row=(await request('/setup/equipment')).body.items.find(item=>item.serialNumber===roster[0].serialNumber);
  assert.ok(row);
  try {
    const changed=await request('/setup/equipment/'+row.id,{method:'PATCH',body:{...input(row),model:'Retired model',active:false,revision:row.revision}});
    assert.equal(changed.status,200);
    assert.equal((await request('/contracts',{method:'POST',body:fields()})).status,400);
    const saved=await request('/contracts/'+c.body.id,{method:'PATCH',body:fields({revision:1,lessee:'Still correct'})});assert.equal(saved.status,200);
    assert.equal(saved.body.fields.equipmentModel,roster[0].model);assert.equal(saved.body.fields.serialNumber,roster[0].serialNumber);
  } finally {
    const current=(await request('/setup/equipment')).body.items.find(item=>item.id===row.id);
    assert.equal((await request('/setup/equipment/'+row.id,{method:'PATCH',body:{...input(row),revision:current.revision}})).status,200);
  }
});

test('sales download current unsigned saved terms before signing and after expiry; public PDF still requires signing',async()=>{
  const c=await request('/contracts',{method:'POST',body:fields()});assert.equal(c.status,201);
  for(const actor of ['mbr','admin']) {
    const result=await request(`/contracts/${c.body.id}/pdf`,{actor});assert.equal(result.status,200);
    assert.equal(result.bytes.subarray(0,4).toString(),'%PDF');
    assert.match(result.headers.get('content-disposition'),/-unsigned\.pdf/u);
    const text=pdfText(result.bytes).replace(/\s+/gu,' ');
    for(const phrase of ['Unsigned agreement','STR1000H',roster[0].serialNumber,'Acme Construction Ltd.','250.00','GPS TRACKING','13. WAIVER']) {
      assert.ok(text.includes(phrase),'Missing PDF content: '+phrase);
    }
    assert.ok(!text.includes('Electronic signature record'));assert.ok(!text.includes('Signed by:'));
  }
  assert.equal((await request(`/contracts/${c.body.id}/pdf`,{actor:'sales'})).status,403);
  const link=await request(`/contracts/${c.body.id}/link`,{method:'POST',body:{revision:1}});
  const token=new URL(link.body.url).hash.slice(1);
  assert.equal((await request('/public/pdf',{actor:null,headers:{'x-mbr-contract-token':token}})).status,409);
  const edited=await request('/contracts/'+c.body.id,{method:'PATCH',body:fields({revision:1,...pair(roster[2]),dailyRate:'321.50'})});assert.equal(edited.status,200);
  const text=pdfText((await request(`/contracts/${c.body.id}/pdf`)).bytes);
  assert.ok(text.includes('TV1100H'));assert.ok(text.includes(roster[2].serialNumber));assert.ok(text.includes('321.50'));
  assert.ok(!text.includes(roster[0].serialNumber));
  await query('UPDATE mbr_contracts SET expires_at=clock_timestamp() WHERE id=$1',[c.body.id]);
  assert.equal((await request(`/contracts/${c.body.id}/pdf`)).status,200);
  const unsigned=await query('SELECT signature_png,completed_pdf,status FROM mbr_contracts WHERE id=$1',[c.body.id]);
  assert.deepEqual(unsigned.rows[0],{signature_png:null,completed_pdf:null,status:'expired'});
});
