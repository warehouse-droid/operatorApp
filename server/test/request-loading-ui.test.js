import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import fc from 'fast-check';
import {fileURLToPath} from 'node:url';

function harness(audience, requests) {
  const sales = audience === 'sales';
  const prefix = sales ? 'salesStock' : 'scmStock';
  const source = fs.readFileSync(new URL(`../public/${audience}-stock-requests.js`, import.meta.url), 'utf8');
  const name = prefix + 'Load';
  const body = source.match(new RegExp(`^async function ${name}\\([^]*?^}`, 'm'))?.[0];
  assert.ok(body, 'Real page loader must be present');
  const state = {loadGeneration:0,composer:null,bucket:'pending',queue:'request',requests:[],selectedId:null,
    search:'',vendorFilter:sales?[]:'',requestTypeFilter:sales?[]:'',backorderStageFilter:sales?[]:'',requestDateFilter:'',sourceLocationFilter:'',destinationLocationFilter:'',
    selectedLineIds:new Set(),selectedTransferId:null};
  const calls = [];
  const payload = rows => ({requests:rows,yards:[{locationId:1,yardCode:'3445'}],filterOptions:{},allowOverAvailability:false,revision:1});
  const api = async path => {
    calls.push(path);
    if (/stock-requests\?/.test(path)) return payload(requests);
    return requests.find(row=>String(row.id)===path.split('/').at(-1));
  };
  const context = vm.createContext({URLSearchParams,window:{MBBSSalesStockActiveTab:'regular'},
    localStorage:{setItem(){}},[prefix+'State']:state,[prefix+'Api']:api,[prefix+'Updates']:null,
    [sales?'renderSalesStockRequests':'renderScmStockRequests']:()=>{},
    salesStockReconcileNewComposerDestination(){},salesStockSupportedDestinationLocationId:value=>value});
  const offset=source.indexOf(body);
  const padded=source.slice(0,offset).replace(/[^\n]/g,' ')+body+source.slice(offset+body.length).replace(/[^\n]/g,' ');
  vm.runInContext(padded,context,{filename:fileURLToPath(new URL(`../public/${audience}-stock-requests.js`,import.meta.url))});
  return {state,calls,context,run:()=>vm.runInContext(`${name}()`,context)};
}

const detail = (id, revision=1) => ({id,revision,requestRef:`REQ-${id}`,bucket:'pending',
  regular:{deliveryMethod:'backorder'},lines:[{id:id*10,status:'submitted',salesQty:7}],transfers:[],events:[{eventType:'created'}]});

for (const audience of ['sales','scm']) {
  test(`${audience}: initial loading reuses the complete selected detail returned by the queue`,async()=>{
    const record=detail(42),h=harness(audience,[record]);
    await h.run();
    assert.equal(h.state.selectedId,42);
    assert.deepEqual(h.state.detail,record);
    assert.equal(h.state.loading,false);
    assert.equal(h.calls.length,1,'Queue already includes this detail; do not request it twice');
  });
  test(`${audience}: refresh preserves selection and uses its current quantities and revision`,async()=>{
    const h=harness(audience,[detail(41),detail(42,9)]);
    h.state.selectedId='42';h.state.detail=detail(42,1);
    await h.run();
    assert.equal(Number(h.state.selectedId),42);
    assert.equal(h.state.detail.revision,9);
    assert.equal(h.state.detail.lines[0].salesQty,7);
    assert.equal(h.calls.length,1);
  });
  test(`${audience}: an empty queue clears a stale selected detail`,async()=>{
    const h=harness(audience,[]);h.state.selectedId=42;h.state.detail=detail(42);
    await h.run();
    assert.equal(h.state.selectedId,null);assert.equal(h.state.detail,null);assert.equal(h.calls.length,1);
  });
  test(`${audience}: a slow earlier response cannot replace a newer selection`,async()=>{
    const h=harness(audience,[]),pending=[];
    h.context[(audience==='sales'?'salesStock':'scmStock')+'Api']=path=>/stock-requests\?/.test(path)
      ? new Promise(resolve=>pending.push(resolve)) : Promise.resolve(detail(Number(path.split('/').at(-1))));
    const first=h.run(),second=h.run();
    pending[1]({requests:[detail(43)],yards:[],filterOptions:{}});
    await second;
    pending[0]({requests:[detail(42)],yards:[],filterOptions:{}});
    await first;
    assert.equal(h.state.detail.id,43);
  });
}

for(const audience of ['sales','scm']) test(`${audience}: selection property retains exactly the authorized queue record`,async()=>{
  await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({min:1,max:10000}),{minLength:1,maxLength:20}),fc.nat(),
    async(ids,index)=>{
      const rows=ids.map(id=>detail(id,3)),selected=rows[index%rows.length];
      const h=harness(audience,rows);h.state.selectedId=String(selected.id);h.state.detail=detail(selected.id,1);
      await h.run();assert.deepEqual(h.state.detail,selected);assert.equal(h.calls.length,1);
    }),{seed:20261008,numRuns:50});
});

for(const audience of ['sales','scm']) test(`${audience}: transfer and purchase requests retain the live availability detail fetch`,async()=>{
  for(const stockingType of ['transfer','purchase']) {
    const row={...detail(42),regular:{deliveryMethod:'stocking',stockingType},availability:[]};
    const h=harness(audience,[row]),full={...row,availability:[{item:{itemId:1},yards:[{requestableAvailable:9}]}]};
    h.context[(audience==='sales'?'salesStock':'scmStock')+'Api']=async path=>{
      h.calls.push(path);return path.includes('?')?{requests:[row],yards:[]}:full;
    };
    await h.run();assert.equal(h.calls.length,2);assert.deepEqual(h.state.detail,full);
  }
});
