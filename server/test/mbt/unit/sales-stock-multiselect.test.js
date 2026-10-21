import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {SALES_CASE_STAGES,SALES_REQUEST_TYPES,parseSalesRequestTypes,parseSalesCaseStages,restoreSalesStockFilters,salesStockListFiltersHtml} from '../../../public/sales-stock-list-filters.js';

test('Multiple case stages and request types accept scalar, CSV and repeated selections without accepting invalid filters',()=>{
  for (const [options,parse] of [[SALES_CASE_STAGES,parseSalesCaseStages],[SALES_REQUEST_TYPES,parseSalesRequestTypes]]) {
    fc.assert(fc.property(fc.array(fc.constantFrom(...Object.keys(options)),{maxLength:50}),values=>{
      const expected=Object.keys(options).filter(value=>values.includes(value));
      assert.deepEqual(parse(values),expected);
      assert.deepEqual(parse(values.join(',')),expected);
      if(values.length)assert.deepEqual(parse(values[0]),[values[0]]);
    }),{seed:20261009,numRuns:100});
    for(const value of [{},true,1,[''],['unknown'],['new_enquiry',{}],Array(65).fill('completed'),"' OR true --"])
      assert.throws(()=>parse(value),{status:400,code:'SALES_STOCK_FILTER_INVALID'});
  }
});

test('Saved filters preserve vendor commas and multiple selections; menu labels escape vendor markup',()=>{
  const saved={requestTypeFilter:['stocking','backorder'],backorderStageFilter:['new_enquiry','completed'],vendorFilter:['TEST, Vendor','<img src=x onerror=alert(1)>']};
  assert.deepEqual(restoreSalesStockFilters(JSON.stringify(saved)),{...saved,backorderStageFilter:[],unifiedStatus:'pending_scm,completed'});
  for(const value of ['null','{bad','{"backorderStageFilter":["unknown"]}'])
    assert.deepEqual(restoreSalesStockFilters(value),{requestTypeFilter:[],backorderStageFilter:[],vendorFilter:[]});
  const html=salesStockListFiltersHtml({...saved,disabled:true});
  assert.ok(!html.includes('<select')&&!html.includes('statusFilter')&&!html.includes('<img'));
  assert(!html.includes('Case stage'));assert.match(html,/&lt;img/);
  assert.match(html,/value="stocking" checked disabled/);
  assert.match(salesStockListFiltersHtml({...saved,language:'zh-CN'}),/申请类型/);
});
