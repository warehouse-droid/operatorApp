import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {app} from '../../src/server.js';
import {createOperator} from '../../src/auth-repository.js';
import {query,closeDb} from '../../src/db.js';
import {pdfText} from '../field-sales/pdf-text.js';
import {fields} from './fixtures.js';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
let server,base,token;
const nulls=Object.fromEntries(['effectiveDate','lessee','equipmentModel','serialNumber','rentalStart','rentalEnd',
  'pickupLocation','returnLocation','dailyRate','weeklyRate','monthlyRate','securityDeposit','expiryDays'].map(key=>[key,null]));
before(async()=>{
  const username='nullable-'+randomUUID(),password='test-nullable-fields';
  await createOperator({username,displayName:'Nullable Sales',role:'mbr_sales',password});
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
  const result=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
  assert.equal(result.status,200);token=(await result.json()).token;
});
after(async()=>{server?.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closeDb();});
async function request(path,{method='GET',body}={}) {
  const response=await fetch(base+'/api/mbr'+path,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const bytes=Buffer.from(await response.arrayBuffer());
  return {status:response.status,bytes,body:response.headers.get('content-type')?.includes('json')?JSON.parse(bytes):null};
}
test('empty and explicitly null contracts save, reopen, list and download with blank terms',async()=>{
  for(const body of [{},nulls]) {
    const saved=await request('/contracts',{method:'POST',body});assert.equal(saved.status,201);
    const contract=saved.body;
    assert.ok(Object.values(contract.fields).every(value=>value===null));
    const reloaded=await request('/contracts/'+contract.id);assert.deepEqual(reloaded.body.fields,contract.fields);
    assert.ok((await request('/contracts?search='+contract.number)).body.items.some(row=>row.id===contract.id));
    const pdf=await request(`/contracts/${contract.id}/pdf`);assert.equal(pdf.status,200);
    const text=pdfText(pdf.bytes);assert.ok(text.includes('Unsigned agreement'));assert.ok(!/\b(?:null|undefined)\b|0\.00/u.test(text));
  }
});
test('all populated fields can be cleared, then refilled, including a model without an SN',async()=>{
  const saved=await request('/contracts',{method:'POST',body:fields()});assert.equal(saved.status,201);
  const blank=await request('/contracts/'+saved.body.id,{method:'PATCH',body:{...nulls,revision:1}});
  assert.equal(blank.status,200);assert.ok(Object.values(blank.body.fields).every(value=>value===null));
  const partial=await request('/contracts/'+saved.body.id,{method:'PATCH',body:{...nulls,equipmentModel:'TV1100H',dailyRate:'0',revision:2}});
  assert.equal(partial.status,200);assert.equal(partial.body.fields.serialNumber,null);assert.equal(partial.body.fields.dailyRateMinor,0);
  const filled=await request('/contracts/'+saved.body.id,{method:'PATCH',body:fields({revision:3})});assert.equal(filled.status,200);
  assert.equal(filled.body.fields.serialNumber,'VLGST1KHAT0610007');
});
test('blank expiry uses three days for issue, edit and renewal while remaining null in the contract',async()=>{
  const created=await request('/contracts',{method:'POST',body:nulls});assert.equal(created.status,201);const id=created.body.id;
  const startedAt=Date.now(),link=await request(`/contracts/${id}/link`,{method:'POST',body:{revision:1}});assert.equal(link.status,200);
  assert.ok(Date.parse(link.body.expiresAt)>=startedAt+3*86400000-100);
  const edited=await request('/contracts/'+id,{method:'PATCH',body:{...nulls,revision:1}});assert.equal(edited.status,200);
  assert.equal(edited.body.fields.expiryDays,null);assert.ok(Date.parse(edited.body.expiresAt)>Date.now()+2.9*86400000);
  await query('UPDATE mbr_contracts SET expires_at=clock_timestamp() WHERE id=$1',[id]);
  const renewed=await request(`/contracts/${id}/renew`,{method:'POST',body:{...nulls,revision:2}});assert.equal(renewed.status,200);
  assert.equal(renewed.body.contract.fields.expiryDays,null);assert.ok(Date.parse(renewed.body.expiresAt)>Date.now()+2.9*86400000);
});
test('nullable contract fields preserve Setup requirements and reject invalid supplied data',async()=>{
  assert.equal((await request('/setup/equipment',{method:'POST',body:{brand:null,model:null,unitCode:null,serialNumber:null}})).status,400);
  for(const body of [{...nulls,effectiveDate:'2026-02-30'},{...nulls,dailyRate:'-1'},
    {...nulls,equipmentModel:'Unknown'},{...nulls,serialNumber:'VLGST1KHAT0610007'},
    {...nulls,equipmentModel:'STR1000H',serialNumber:'VLGT1K1HVS0610006'}]) {
    assert.equal((await request('/contracts',{method:'POST',body})).status,400);
  }
});
