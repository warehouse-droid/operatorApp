import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {closeDb} from '../src/db.js';
import {createControlDamageRouter} from '../src/control-damage-router.js';
import {isOperatorNetSuiteRequest} from '../src/operator-netsuite-request-pool.js';

test('S4: real Control review HTTP uses foreground priority for transfer and fallback unit reads',async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,'1');
  const reads=[],writes=[];
  const remote={findMonthly:async()=>{
    await Promise.resolve();reads.push({kind:'transfers',foreground:isOperatorNetSuiteRequest()});
    return [{id:'1031838',tranId:'IT00571',memo:'3445 2026 Oct Damage',location:{id:'1'},transferLocation:{id:'10'},
      inventory:{items:[{line:1,item:{id:'5022',refName:'UNI-PISAS-COP-SAFARI'},adjustQtyBy:18,units:'998877',custcol_atlas_rc_so:{id:'5'},description:'Original SKU description'}]}}];
  },units:async()=>{
    await Promise.resolve();reads.push({kind:'units',foreground:isOperatorNetSuiteRequest()});return {'998877':'PC'};
  },apply:async()=>writes.push('apply')};
  const local=express();local.use((req,_res,next)=>{req.operator={role:'yard_manager',roles:['yard_manager'],yardLocationIds:[1]};next();});
  local.use(createControlDamageRouter({remote}));
  local.use((error,_req,res,_next)=>res.status(error.status || 500).json({error:error.message}));
  const server=local.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const response=await fetch(base+'/review?locationId=1&month=2026-10');assert.equal(response.status,200);
    const review=await response.json();assert.equal(review.syncError,null);assert.equal(review.transfers[0].lines[0].unit,'PC');
    assert.deepEqual(reads,[{kind:'transfers',foreground:true},{kind:'units',foreground:true}]);
    const previous=reads.length;
    assert.equal((await fetch(base+'/review?locationId=28&month=2026-10')).status,403);assert.equal(reads.length,previous);
    assert.deepEqual(writes,[]);assert.equal(isOperatorNetSuiteRequest(),false);
  } finally {await new Promise(resolve=>server.close(resolve));await closeDb();}
});
