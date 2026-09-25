import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { prepareSpecialQuantityPlan, applySpecialQuantityPlan } from '../../../src/special-stock-quantity-adapter.js';

function fixture({from=24,to=36}={}) {
  const records=new Map([901,902].map(id=>[id,{item:{items:[
    {line:3,item:{id:'2055'},quantity:from,units:{id:'865'},rate:id===901?9:4,description:'TEST exact product'},
    {line:8,item:{id:'1784'},quantity:2,units:{id:'246'},rate:1,description:'PALLET'}
  ]}}]));
  const identity=new Map([901,902].map(id=>[id,{uniquekey:id*100+1,rest_line_id:3,item:2055,
    execution_quantity:0,billed_quantity:0,line_closed:'F',status_text:id===901?'Pending Fulfillment':'Pending Receipt'}]));
  const writes=[];
  const deps={
    rest:async(path,options={})=>{
      const id=Number(path.match(/\/(\d+)(?:\?|$)/)[1]);
      if(options.method==='PATCH') {
        writes.push({id,body:structuredClone(options.body)});
        if(deps.failPo && id===902) { deps.failPo=false; throw new Error('TEST PO unavailable'); }
        for(const patch of options.body.item.items) {
          assert.deepEqual(Object.keys(patch).sort(),['line','quantity']);
          const line=records.get(id).item.items.find(line=>line.line===patch.line);
          assert.ok(line,'A keyed existing line is required');line.quantity=patch.quantity;
        }
        if(deps.corruptAfterWrite) deps.corruptAfterWrite(id,records);
      }
      return {data:structuredClone(records.get(id))};
    },
    queryAll:async sql=>{
      const id=Number(sql.match(/tl\.transaction\s*=\s*(\d+)/)[1]);
      return [structuredClone(identity.get(id))];
    }
  };
  const orders=[901,902].map(id=>({id,kind:id===901?'sales_order':'purchase_order',lines:[{
    caseLineId:1,remoteLineId:id*100+1,itemId:2055,quantity:from,toQuantity:to,unitId:865,rate:id===901?9:4,description:'TEST exact product'
  }]}));
  return {records,identity,writes,deps,orders};
}

test('prepares exact SO and PO identities without a remote mutation',async()=>{
  const f=fixture(),plan=await prepareSpecialQuantityPlan({orders:f.orders},f.deps);
  assert.equal(plan.orders.length,2);assert.deepEqual(f.writes,[]);
  assert.equal(plan.orders[0].changes[0].line,3);assert.equal(plan.orders[0].changes[0].remoteLineId,90101);
});
test('accepts the type-prefixed status labels returned by live NetSuite SuiteQL',async()=>{
  const f=fixture();
  f.identity.get(901).status_text='Sales Order : Pending Fulfillment';
  f.identity.get(902).status_text='Purchase Order : Pending Receipt';
  const plan=await prepareSpecialQuantityPlan({orders:f.orders},f.deps);
  assert.deepEqual(await applySpecialQuantityPlan(plan,f.deps),{verifiedOrderIds:[901,902]});
  const blocked=fixture();blocked.identity.get(901).status_text='Sales Order : Pending Billing/Partially Fulfilled';
  await assert.rejects(()=>prepareSpecialQuantityPlan({orders:blocked.orders},blocked.deps),{code:'SPECIAL_QUANTITY_REMOTE_CONFLICT'});
  assert.deepEqual(blocked.writes,[]);
});
test('updates both orders and preserves prices, units, descriptions and pallet lines',async()=>{
  const f=fixture(),plan=await prepareSpecialQuantityPlan({orders:f.orders},f.deps);
  const before=structuredClone([...f.records]);
  assert.deepEqual(await applySpecialQuantityPlan(plan,f.deps),{verifiedOrderIds:[901,902]});
  for(const [id,old]of before){const current=f.records.get(id).item.items;assert.equal(current[0].quantity,36);
    assert.equal(current[0].rate,old.item.items[0].rate);assert.deepEqual(current[1],old.item.items[1]);}
  assert.equal(f.writes.length,2);
  await applySpecialQuantityPlan(plan,f.deps);assert.equal(f.writes.length,2);
});
test('partial SO success resumes by verifying it and updating only the unfinished PO',async()=>{
  const f=fixture(),plan=await prepareSpecialQuantityPlan({orders:f.orders},f.deps);
  f.deps.failPo=true;
  await assert.rejects(()=>applySpecialQuantityPlan(plan,f.deps),/TEST PO unavailable/);
  assert.equal(f.records.get(901).item.items[0].quantity,36);assert.equal(f.records.get(902).item.items[0].quantity,24);
  await applySpecialQuantityPlan(plan,f.deps);
  assert.equal(f.writes.filter(write=>write.id===901).length,1);
  assert.equal(f.records.get(902).item.items[0].quantity,36);
});
for(const [name,mutate]of [
  ['wrong item',f=>{f.identity.get(902).item=99;}],
  ['fulfilled quantity',f=>{f.identity.get(902).execution_quantity=1;}],
  ['billed quantity',f=>{f.identity.get(902).billed_quantity=1;}],
  ['closed line',f=>{f.identity.get(902).line_closed='T';}],
  ['closed order',f=>{f.identity.get(902).status_text='Closed';}],
  ['changed quantity',f=>{f.records.get(902).item.items[0].quantity=29;}],
  ['changed rate',f=>{f.records.get(902).item.items[0].rate=5;}],
  ['changed unit',f=>{f.records.get(902).item.items[0].units.id='99';}]
])test(`rejects ${name} before updating either order`,async()=>{
  const f=fixture();mutate(f);
  await assert.rejects(()=>prepareSpecialQuantityPlan({orders:f.orders},f.deps),{code:'SPECIAL_QUANTITY_REMOTE_CONFLICT'});
  assert.deepEqual(f.writes,[]);
});
test('rechecks the entire pair before retry and verifies unrelated lines after mutation',async()=>{
  const f=fixture(),plan=await prepareSpecialQuantityPlan({orders:f.orders},f.deps);
  f.records.get(902).item.items[1].quantity=99;
  await assert.rejects(()=>applySpecialQuantityPlan(plan,f.deps),{code:'SPECIAL_QUANTITY_REMOTE_CONFLICT'});assert.deepEqual(f.writes,[]);
  f.records.get(902).item.items[1].quantity=2;
  f.deps.corruptAfterWrite=(_id,records)=>{records.get(901).item.items[0].rate=10;};
  await assert.rejects(()=>applySpecialQuantityPlan(plan,f.deps),{code:'SPECIAL_QUANTITY_REMOTE_CONFLICT'});
});
test('property: replay sets an absolute quantity once and never compounds a delta',async()=>{
  await fc.assert(fc.asyncProperty(fc.integer({min:1,max:10000}),fc.integer({min:1,max:10000}),async(from,to)=>{
    const f=fixture({from,to}),plan=await prepareSpecialQuantityPlan({orders:f.orders},f.deps);
    await applySpecialQuantityPlan(plan,f.deps);await applySpecialQuantityPlan(plan,f.deps);
    assert.equal(f.records.get(901).item.items[0].quantity,to);assert.equal(f.records.get(902).item.items[0].quantity,to);
    assert.equal(f.writes.length,from===to?0:2);
  }),{numRuns:75,seed:24092028});
});

test('adversarial identities, missing execution evidence and changed descriptions never reach PATCH',async()=>{
  for(const mutate of [
    f=>{f.orders[0].id='1 OR 1=1';},f=>{f.orders[0].kind='estimate';},
    f=>{f.orders[0].lines.push({...f.orders[0].lines[0]});},
    f=>{f.orders[0].lines[0].toQuantity=0;},f=>{f.orders[0].lines[0].unitId=null;},
    f=>{f.identity.get(901).billed_quantity=null;},f=>{f.identity.get(901).execution_quantity=null;},
    f=>{f.records.get(901).item.items[0].description='Changed externally';},
    f=>{f.records.get(901).item.items.push({...f.records.get(901).item.items[0]});},
    f=>{f.records.get(901).item.items[0].rate='unknown';},
    f=>{f.records.get(901).item.items=[];}
  ]) {
    const f=fixture();mutate(f);await assert.rejects(()=>prepareSpecialQuantityPlan({orders:f.orders},f.deps),{code:'SPECIAL_QUANTITY_REMOTE_CONFLICT'});assert.deepEqual(f.writes,[]);
  }
  const f=fixture(),plan=await prepareSpecialQuantityPlan({orders:f.orders},f.deps);
  f.identity.get(901).rest_line_id=4;
  await assert.rejects(()=>applySpecialQuantityPlan(plan,f.deps),{code:'SPECIAL_QUANTITY_REMOTE_CONFLICT'});assert.deepEqual(f.writes,[]);
});
