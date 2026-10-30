import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createMbtRouter} from '../../../src/mbt/router.js';

const paths=[['POST','/assets'],['PATCH','/assets/a'],['DELETE','/assets/a'],
  ['GET','/config/rate-cards'],['GET','/config/rate-cards/v'],['POST','/config/rate-cards'],
  ['PUT','/config/rate-cards/v'],['PATCH','/config/rate-cards/v/state'],['DELETE','/config/rate-cards/v'],
  ['POST','/config/rate-cards/v/validate'],['POST','/config/rate-cards/v/activate'],['POST','/config/rate-cards/v/clone'],
  ['POST','/config/rate-card-imports/preview'],['POST','/config/rate-card-imports/apply'],
  ['GET','/config/customer-charges/v'],['PUT','/config/customer-charges/v'],['POST','/assets/import/b/apply']];

test('Dispatch management: Admin and Dispatcher share asset and rate lifecycle routes; other roles cannot forge access',async()=>{
  const calls=[],service=new Proxy({}, {get:(_object,name)=>name==='then'?undefined:async input=>{calls.push({name,input});return {status:200,body:{ok:true},ok:true};}});
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.operator={id:'staff',roles:[req.get('x-test-role') || 'operator']};next();});
  app.use('/api/mbt',createMbtRouter({authorizePhase3Capability:async()=>({}),assetRegistryService:service,
    rateCardService:service,rateCardImportService:service,assetCsvImportService:service,customerChargeService:service}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  try {
    for(const role of ['admin','dispatcher','operator','mbt_frontdesk','mbt_billing']) {
      for(const [method,path] of paths) {
        const before=calls.length;
        const response=await fetch(`http://127.0.0.1:${server.address().port}/api/mbt${path}`,{method,
          headers:{'x-test-role':role,'content-type':'application/json','idempotency-key':crypto.randomUUID(),'x-mbbs-role':'admin'},
          ...(method==='GET'?{}:{body:JSON.stringify({expectedRevision:1,active:true,actor:{operatorId:'forged',roles:['admin']}})})});
        const body=await response.text(),allowed=['admin','dispatcher'].includes(role);
        assert.equal(response.status,allowed && path.endsWith('/preview')?201:allowed?200:403,`${role} ${method} ${path}: ${body}`);
        assert.equal(calls.length,before+(allowed?1:0));
        if(allowed && calls.at(-1).input?.actor) assert.deepEqual(calls.at(-1).input.actor,{operatorId:'staff',roles:[role]});
      }
    }
    for(const path of ['/config/gates','/config/netsuite/mappings','/config/dump-sites','/config/local/items']) {
      const response=await fetch(`http://127.0.0.1:${server.address().port}/api/mbt${path}`,{method:'PUT',headers:{'x-test-role':'dispatcher','content-type':'application/json'},body:'{}'});
      assert.ok([403,404].includes(response.status),path);
    }
  } finally {await new Promise(resolve=>server.close(resolve));}
});
