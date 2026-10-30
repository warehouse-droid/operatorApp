import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {app} from '../../../src/server.js';
import {createOperator} from '../../../src/auth-repository.js';
import {query} from '../../../src/db.js';
import {fixture} from '../../support/operator-suiteql-fixture.mjs';

let transport,server,base,previousFlag;
const tokens={},users=[];
before(async()=>{
  transport=await fixture();
  previousFlag=(await query("SELECT enabled FROM mbt_feature_flags WHERE flag_key='special_stock_request_workflow'")).rows[0].enabled;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  base='http://127.0.0.1:'+server.address().port;
  for(const role of ['scm','sales']) {
    const username='test-po-units-'+randomUUID(),password=randomUUID();
    users.push(await createOperator({username,displayName:'TEST Units',password,role,roles:[role],yardLocationIds:[1]}));
    const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
    assert.equal(response.status,200);tokens[role]=(await response.json()).token;
  }
});
after(async()=>{
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await query("UPDATE mbt_feature_flags SET enabled=$1 WHERE flag_key='special_stock_request_workflow'",[previousFlag]);
  for(const user of users)await query('DELETE FROM operators WHERE id=$1',[user.id]);
  await transport?.close();
});
const get=(id,role='scm')=>fetch(`${base}/api/scm/special-stock-requests/items/${id}/units`,{headers:tokens[role]?{authorization:'Bearer '+tokens[role]}:{}});
test('SCM UOM endpoint returns live item-specific choices and rejects unauthorized or invalid requests',async()=>{
  const requests=[];
  transport.state.handle=async request=>{
    requests.push(request);
    if(request.body?.q)return {data:{items:[{id:2055,itemtype:'NonInvtPart',subtype:'Resale',isinactive:'F',unitstype:10,purchase_unit_id:2}]}};
    assert.equal(request.method,'GET');assert.ok(request.url.pathname.endsWith('/unitsType/10'));
    return {data:{uom:{items:[{internalId:1,abbreviation:'PC'},{internalId:2,abbreviation:'PLT'}]}}};
  };
  const response=await get(2055);assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
  assert.deepEqual((await response.json()).units.map(unit=>[unit.id,unit.name]),[[1,'PC'],[2,'PLT']]);
  assert.equal(requests.length,2);
  assert.equal((await get('invalid')).status,400);assert.equal(requests.length,2);
  assert.equal((await get(2055,'sales')).status,403);
  assert.equal((await get(2055,'anonymous')).status,401);
});
