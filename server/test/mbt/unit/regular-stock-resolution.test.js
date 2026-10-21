import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {normalizeRegularStockResolution} from '../../../src/regular-stock-resolution.js';

const valid={purchaseOrderRef:'POB012345',eta:'2026-10-15',expectedRevision:1};
test('resolution requires a PO, a real calendar date and a positive case revision',()=>{
  assert.deepEqual(normalizeRegularStockResolution({...valid,purchaseOrderRef:'  POB012345  ',expectedRevision:'2'}),{...valid,expectedRevision:2});
  for(const change of [{purchaseOrderRef:''},{purchaseOrderRef:'x'.repeat(81)},{purchaseOrderRef:'PO\nBAD'},{purchaseOrderRef:{}},
    {eta:''},{eta:'2026-02-30'},{eta:'2026-13-01'},{eta:'10/15/2026'},{eta:'2026-10-15T12:00:00Z'},
    {expectedRevision:0},{expectedRevision:1.5},{expectedRevision:'no'},{expectedRevision:null}]){
    assert.throws(()=>normalizeRegularStockResolution({...valid,...change}),error=>error.status===400);
  }
  assert.equal(normalizeRegularStockResolution({...valid,eta:'2000-02-29'}).eta,'2000-02-29');
});

test('property: valid PO/date replies normalize idempotently without changing their meaning',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:999999999}),fc.date({min:new Date('2000-01-01Z'),max:new Date('2099-12-31Z'),noInvalidDate:true}),
    fc.integer({min:1,max:10000}),(po,date,revision)=>{
      const input={purchaseOrderRef:`  POB${po}  `,eta:date.toISOString().slice(0,10),expectedRevision:String(revision)};
      const normalized=normalizeRegularStockResolution(input);
      assert.deepEqual(normalized,{purchaseOrderRef:`POB${po}`,eta:input.eta,expectedRevision:revision});
      assert.deepEqual(normalizeRegularStockResolution(normalized),normalized);
    }),{seed:2026100201,numRuns:200});
});

test('property: impossible calendar days and empty PO references never become accepted replies',()=>{
  fc.assert(fc.property(fc.integer({min:2000,max:2099}),fc.integer({min:32,max:99}),(year,day)=>{
    assert.throws(()=>normalizeRegularStockResolution({...valid,eta:`${year}-01-${day}`}),error=>error.status===400);
    assert.throws(()=>normalizeRegularStockResolution({...valid,purchaseOrderRef:' '.repeat(day)}),error=>error.status===400);
  }),{seed:2026100202,numRuns:200});
});

test('Resolve UI is limited to uncommitted Stocking cases and escapes the saved reply',()=>{
  const window={RegularStockUI:{t:en=>en,esc:value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char])}};
  vm.runInNewContext(readFileSync('public/regular-stock-resolution.js','utf8'),{window},{filename:new URL('../../../public/regular-stock-resolution.js',import.meta.url).pathname});
  const ui=window.RegularStockResolution;
  const request={workflowVersion:2,status:'submitted',regular:{deliveryMethod:'stocking'},lines:[{status:'submitted'}],transfers:[]};
  assert.equal(ui.eligible(request),true);
  for(const change of [{status:'completed'},{status:'cancelled'},{workflowVersion:1},{transfers:[{}]},
    {regular:{deliveryMethod:'pickup'}},{regular:{deliveryMethod:'delivery'}},{regular:{deliveryMethod:'stocking',pickupTransfer:{status:'executing'}}},
    {regular:{deliveryMethod:'stocking',handoffStatus:'executing'}},{lines:[{status:'approved',purchase:{demandId:1}}]},
    {lines:[{status:'converted'}]},{lines:[]}])assert.equal(ui.eligible({...request,...change}),false);
  const saved={...request,status:'completed',regular:{...request.regular,resolution:{purchaseOrderRef:'PO<script>',eta:'2026-10-15',resolvedAt:'2026-10-02T12:00:00Z'}}};
  assert.equal(ui.eligible(saved),false);assert.match(ui.result(saved),/PO&lt;script&gt;/);assert.match(ui.result(saved),/2026-10-15/);
});
