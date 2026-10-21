import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {app} from '../../src/server.js';
import {createOperator} from '../../src/auth-repository.js';
import {query,withTransaction,closeDb} from '../../src/db.js';
import {pdfText} from '../field-sales/pdf-text.js';
import {fields} from './fixtures.js';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const fixture=JSON.parse(await readFile(new URL('./rates-fixture.json',import.meta.url),'utf8'));
const prices=row=>({dailyRateMinor:row.dailyRateMinor,weeklyRateMinor:row.weeklyRateMinor,monthlyRateMinor:row.monthlyRateMinor});
let server,base,originalRates;
const sessions={};
before(async()=>{
  originalRates=(await query('SELECT * FROM mbr_model_rates ORDER BY model')).rows;
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  for(const role of ['mbr_sales','admin','sales']) {
    const username='model-rates-'+randomUUID(),password='rates-tests-only';
    await createOperator({username,displayName:'Rate '+role,role,password,yardLocationIds:role==='sales'?[1]:[]});
    const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
    assert.equal(response.status,200);sessions[role]=(await response.json()).token;
  }
});
after(async()=>{
  server?.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  for(const row of originalRates) {
    await query(`UPDATE mbr_model_rates SET daily_rate_minor=$2,weekly_rate_minor=$3,monthly_rate_minor=$4,
      revision=$5,updated_by=$6,updated_at=$7 WHERE model=$1`,
    [row.model,row.daily_rate_minor,row.weekly_rate_minor,row.monthly_rate_minor,row.revision,row.updated_by,row.updated_at]);
  }
  await closeDb();
});
async function request(path,{method='GET',body,actor='mbr_sales',headers={}}={}) {
  const response=await fetch(base+'/api/mbr'+path,{method,headers:{...(actor?{authorization:'Bearer '+sessions[actor]}:{}),
    ...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
  const bytes=Buffer.from(await response.arrayBuffer());
  return {status:response.status,bytes,body:response.headers.get('content-type')?.includes('json')?JSON.parse(bytes):null};
}
async function rows() {const result=await request('/setup/rates');assert.equal(result.status,200);return result.body.items;}
const payload=(row,extra={})=>({model:row.model,revision:row.revision,...Object.fromEntries(Object.entries(prices(row))
  .map(([key,value])=>[key.replace('Minor',''),value===null?null:(value/100).toFixed(2)])),...extra});

test('Setup returns every exact supplied model rate, ER636H Cab mapping, both shared models and null AX18',async()=>{
  const catalog=await rows();assert.equal(catalog.length,12);
  for(const [model,daily,weekly,monthly] of fixture) {
    const row=catalog.find(item=>item.model===model);assert.ok(row,model);
    assert.deepEqual(prices(row),{dailyRateMinor:daily*100,weeklyRateMinor:weekly*100,monthlyRateMinor:monthly*100});
    assert.equal(row.revision,1);
  }
  assert.deepEqual(prices(catalog.find(item=>item.model==='AX18')),{dailyRateMinor:null,weeklyRateMinor:null,monthlyRateMinor:null});
});
test('Setup rate migration rolls back without changing equipment, saved contracts or signatures',async()=>{
  assert.equal((await request('/setup/rates')).status,200);
  const beforeRows=(await query('SELECT * FROM mbr_model_rates ORDER BY model')).rows;
  const counts=async()=>(await query('SELECT (SELECT count(*) FROM mbr_equipment) AS units,(SELECT count(*) FROM mbr_contract_revisions) AS revisions,(SELECT count(*) FROM mbr_contract_events) AS events')).rows;
  const original=await counts();
  const sql=await readFile(new URL('../../migrations/290_mbr_model_rates.sql',import.meta.url),'utf8');
  await withTransaction(async()=>{
    await query('DROP TABLE mbr_model_rates');await query(sql);
    assert.equal((await query('SELECT count(*) FROM mbr_model_rates')).rows[0].count,'11');
    assert.deepEqual(await counts(),original);
  },{rollback:true});
  assert.deepEqual((await query('SELECT * FROM mbr_model_rates ORDER BY model')).rows,beforeRows);
});
test('rate Setup requires MBR Sales or Admin and rejects customer-link and unrelated-role access',async()=>{
  assert.equal((await request('/setup/rates',{actor:'admin'})).status,200);
  for(const actor of [null,'sales']) {
    for(const method of ['GET','PATCH']) {
      const result=await request('/setup/rates',{actor,method,body:method==='PATCH'?{model:'ER620H',revision:1}:undefined});
      assert.equal(result.status,actor?403:401);
    }
  }
  const saved=await request('/contracts',{method:'POST',body:fields()});
  const link=await request(`/contracts/${saved.body.id}/link`,{method:'POST',body:{revision:1}});
  const token=new URL(link.body.url).hash.slice(1);
  assert.equal((await request('/setup/rates',{actor:null,headers:{'x-mbr-contract-token':token}})).status,401);
});
test('Setup persists nullable and zero defaults with concurrent and stale edit protection',async()=>{
  const original=(await rows()).find(row=>row.model==='ER620H');
  try {
    const responses=await Promise.all(['281.25','282.50'].map(dailyRate=>request('/setup/rates',{method:'PATCH',body:payload(original,{dailyRate,weeklyRate:null,monthlyRate:'0'})})));
    assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
    const current=responses.find(response=>response.status===200).body;
    assert.equal(current.revision,original.revision+1);assert.equal(current.weeklyRateMinor,null);assert.equal(current.monthlyRateMinor,0);
    assert.deepEqual((await rows()).find(row=>row.model===original.model),current);
    assert.equal((await request('/setup/rates',{method:'PATCH',actor:'admin',body:payload(current,{dailyRate:'283.15'})})).status,200);
  } finally {
    const current=(await rows()).find(row=>row.model===original.model);
    assert.equal((await request('/setup/rates',{method:'PATCH',body:payload(original,{revision:current.revision})})).status,200);
  }
});
test('new equipment models start null and first-time rate edits cannot overwrite simultaneous edits',async t=>{
  const model='Unpriced '+randomUUID();
  const added=await request('/setup/equipment',{method:'POST',body:{brand:'Test',model,unitCode:randomUUID(),serialNumber:randomUUID()}});
  assert.equal(added.status,201);
  t.after(async()=>{await query('DELETE FROM mbr_model_rates WHERE model=$1',[model]);await query('DELETE FROM mbr_equipment WHERE id=$1',[added.body.id]);});
  const row=(await rows()).find(item=>item.model===model);
  assert.deepEqual(row,{model,dailyRateMinor:null,weeklyRateMinor:null,monthlyRateMinor:null,revision:0});
  const responses=await Promise.all(['12.34','56.78'].map(dailyRate=>request('/setup/rates',{method:'PATCH',body:payload(row,{dailyRate})})));
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
  assert.equal((await rows()).find(item=>item.model===model).revision,1);
});
test('malformed rates, revisions and unknown models leave Setup and existing contracts intact',async()=>{
  const row=(await rows()).find(item=>item.model==='ER620H');
  for(const extra of [{dailyRate:'-1'},{weeklyRate:'1.001'},{monthlyRate:3000},{dailyRate:'1e3'},
    {dailyRate:'10000000000'},{revision:-1},{revision:1.5},{revision:'1'},{revision:2147483648},
    {model:'Bad\nModel'},{model:"'; DROP TABLE mbr_contracts; --"}]) {
    const result=await request('/setup/rates',{method:'PATCH',body:payload(row,extra)});
    assert.ok([400,404].includes(result.status),JSON.stringify(extra));
  }
  assert.deepEqual((await rows()).find(item=>item.model===row.model),row);
  const rates=(await query('SELECT model FROM mbr_model_rates ORDER BY model')).rows;
  const {createMbrRatesRepository}=await import('../../src/mbr/rates-repository.js');
  const repository=createMbrRatesRepository(),actor=(await request('/status')).body.operator;
  await withTransaction(async()=>{
    await query('ALTER TABLE mbr_model_rates RENAME TO mbr_rates_unavailable');
    await assert.rejects(repository.list(),{code:'42P01'});
  },{rollback:true});
  await withTransaction(async()=>{
    await query('ALTER TABLE mbr_model_rates RENAME TO mbr_rates_unavailable');
    await assert.rejects(repository.edit(actor,payload(row)),{code:'42P01'});
  },{rollback:true});
  assert.deepEqual((await query('SELECT model FROM mbr_model_rates ORDER BY model')).rows,rates);
});
test('contract rate overrides and explicit nulls survive saving, Setup repricing, PDF and renewal',async()=>{
  const row=(await rows()).find(item=>item.model==='STR1000H');
  const input=fields({dailyRate:'123.45',weeklyRate:null,monthlyRate:'0'});
  const saved=await request('/contracts',{method:'POST',body:input});assert.equal(saved.status,201);
  const id=saved.body.id,expected={dailyRateMinor:12345,weeklyRateMinor:null,monthlyRateMinor:0};
  try {
    assert.equal((await request('/setup/rates',{method:'PATCH',body:payload(row,{dailyRate:'999.99'})})).status,200);
    assert.deepEqual(prices((await request('/contracts/'+id)).body.fields),expected);
    const text=pdfText((await request(`/contracts/${id}/pdf`)).bytes);assert.ok(text.includes('123.45'));assert.ok(!text.includes('999.99'));
    const edited=await request('/contracts/'+id,{method:'PATCH',body:{...input,revision:1,dailyRate:'87.65',monthlyRate:null}});
    assert.equal(edited.status,200);assert.deepEqual(prices(edited.body.fields),{dailyRateMinor:8765,weeklyRateMinor:null,monthlyRateMinor:null});
    await request(`/contracts/${id}/link`,{method:'POST',body:{revision:2}});
    await query('UPDATE mbr_contracts SET expires_at=clock_timestamp() WHERE id=$1',[id]);
    const renewed=await request(`/contracts/${id}/renew`,{method:'POST',body:{...input,revision:2,dailyRate:null,monthlyRate:null}});
    assert.equal(renewed.status,200);assert.deepEqual(prices(renewed.body.contract.fields),{dailyRateMinor:null,weeklyRateMinor:null,monthlyRateMinor:null});
  } finally {
    const current=(await rows()).find(item=>item.model===row.model);
    assert.equal((await request('/setup/rates',{method:'PATCH',body:payload(row,{revision:current.revision})})).status,200);
  }
});
