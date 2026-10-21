import assert from 'node:assert/strict';
import {fixture} from '../test/support/operator-suiteql-fixture.mjs';
import {fetchPurchaseOrdersFromNetSuite,fetchPurchaseOrderFromNetSuite,
  fetchPurchaseOrderReferenceFromNetSuite,fetchPurchaseOrderHistorySnapshotFromNetSuite} from '../src/netsuite.js';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'mbbs-special-review-db');
const transport=await fixture();
try {
  let reads=0;
  transport.state.handle=async request=>{
    reads++;
    assert.equal(request.method,'POST');
    assert.match(request.url.pathname,/\/query\/v1\/suiteql$/);
    assert.match(request.body.q,/t\.custbody7 AS netsuite_note/);
    return {data:{items:[{id:'1030348',tranid:'POB03976',memo:'Pickering Yard - Unilock',netsuite_note:'for SOB121819'}]}};
  };
  for(const read of [async()=>(await fetchPurchaseOrdersFromNetSuite(1))[0],
    ()=>fetchPurchaseOrderFromNetSuite(1030348),()=>fetchPurchaseOrderReferenceFromNetSuite(1030348)]) {
    const order=await read();
    assert.equal(order.memo,'Pickering Yard - Unilock');
    assert.equal(order.netsuite_note,'for SOB121819');
  }
  const history=await fetchPurchaseOrderHistorySnapshotFromNetSuite(1030348);
  assert.equal(history.memo,'Pickering Yard - Unilock');
  assert.equal(history.note,'for SOB121819');
  assert.equal(reads,4);
  console.log(JSON.stringify({isolated:true,discovery:true,targetedRead:true,referenceRead:true,historyRead:true,noteSeparateFromMemo:true}));
} finally {await transport.close();}
