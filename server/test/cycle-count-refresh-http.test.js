import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {app} from '../src/server.js';
import {query,closeDb} from '../src/db.js';
import {config} from '../src/config.js';
import {createOperator,loginOperator} from '../src/auth-repository.js';
const item=982600,previous={...config.netsuite},nativeFetch=globalThis.fetch;
let server,base,token,adminToken,fail=false,reads=0;
before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  for(const role of ['operator','admin']) {
    const username=crypto.randomUUID(),password=crypto.randomUUID();
    await createOperator({username,password,displayName:'Cycle HTTP',role,operatorYardLocationIds:[1]});
    const session=await loginOperator(username,password);
    if(role==='operator') {token=session.token;} else {adminToken=session.token;}
  }
  await query("INSERT INTO inventory_items(item_id,item_name,stock_unit,to_lyr) VALUES($1,'Cycle HTTP SKU','SQFT',12.79) ON CONFLICT DO NOTHING",[item]);
  await query('INSERT INTO inventory_balances(item_id,location_id,quantity_on_hand,quantity_available) VALUES($1,1,1086.93,396.39) ON CONFLICT DO NOTHING',[item]);
  await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'test-cycle-http',now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
  Object.assign(config.netsuite,{directAccessEnabled:true,restBaseUrl:'https://cycle-stock.invalid/services/rest'});
  globalThis.fetch=(url,options)=>{
    if(!String(url).startsWith('https://cycle-stock.invalid/')) {return nativeFetch(url,options);}
    reads++;
    assert.ok(JSON.parse(options.body).q.includes('AggregateItemLocation'));
    return Promise.resolve(fail ? Response.json({error:'offline'},{status:503}) : Response.json({items:[{
      item_id:item,item_name:'Cycle HTTP SKU',stock_unit:'SQFT',location_id:1,quantity_on_hand:86.7,quantity_available:76.7,to_lyr:12.79
    }]}));
  };
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{globalThis.fetch=nativeFetch;Object.assign(config.netsuite,previous);await new Promise(resolve=>server.close(resolve));await query("DELETE FROM netsuite_tokens WHERE access_token='test-cycle-http'");await closeDb();});
async function request(path,body,auth=token) {
  const response=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json()};
}
test('P4/P6: real cycle endpoints refresh, preserve blind draft/submission, and expose comparison only in review',async()=>{
  const confirmed=await request('/api/cycle-count/lines',{itemId:item,locationId:1,layers:5});
  assert.equal(confirmed.status,200);assert.equal(reads,1);
  const draft=await request('/api/cycle-count/draft');assert.equal(draft.status,200);
  const submitted=await request('/api/cycle-count/submit',{});assert.equal(submitted.status,200);
  for(const response of [confirmed,draft,submitted]) {
    assert.equal(Number(response.data.lines[0].counted_total_qty),63.95);
    for(const field of ['variance_qty','system_on_hand_qty','system_packed_qty','actual_on_hand_qty']) {assert.equal(field in response.data.lines[0],false);}
  }
  const review=await request('/api/cycle-count/records',undefined,adminToken);assert.equal(review.status,200);
  const line=review.data.find(record=>String(record.id)===String(confirmed.data.id)).lines[0];
  assert.equal(Number(line.system_on_hand_qty),86.7);assert.equal(Number(line.system_packed_qty),0);
  assert.equal(Number(line.actual_on_hand_qty),86.7);assert.equal(Number(line.variance_qty),-22.75);assert.equal(line.stock_unit,'SQFT');
  const history=await request('/api/operator/history');assert.equal(history.status,200);
  assert.ok(JSON.stringify(history.data).includes('actualOnHand'));
  fail=true;const failed=await request('/api/cycle-count/lines',{itemId:item,locationId:1,layers:6});
  assert.equal(failed.status,503);assert.equal(failed.data.code,'CYCLE_COUNT_REFRESH_FAILED');
});
