import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {SALES_STOCK_STATUSES,parseSalesStockStatus,matchesSalesStockStatus,salesStockRequestStatus,salesStockStatusOptions} from '../../../public/sales-stock-status-filter.js';

test('Every Sales workflow and stock-check option is accepted; unknown and compound input is rejected',()=>{
  for(const value of Object.keys(SALES_STOCK_STATUSES))assert.equal(parseSalesStockStatus(value),value);
  for(const value of [undefined,null,''])assert.equal(parseSalesStockStatus(value),'');
  for(const value of [[],{},true,1,'pending,completed','new_enquiry\n',"' OR true --"])
    assert.throws(()=>parseSalesStockStatus(value),{code:'SALES_STOCK_STATUS_INVALID',status:400});
  assert.match(salesStockStatusOptions('confirmed'),/value="confirmed" selected/);
  assert.match(salesStockStatusOptions('confirmed','zh-CN'),/已确认/);
  fc.assert(fc.property(fc.constantFrom(...Object.keys(SALES_STOCK_STATUSES).filter(s=>!s.startsWith('supply:'))),status=>{
    const d={displayStatus:status,lines:[]};
    assert.equal(salesStockRequestStatus(d),status);
    for(const filter of Object.keys(SALES_STOCK_STATUSES).filter(s=>!s.startsWith('supply:')))
      assert.equal(matchesSalesStockStatus(d,filter),status===filter);
  }),{seed:20261009,numRuns:100});
});
test('Status matching follows visible attention and expiry priority; material statuses use any matching line',()=>{
  const d={requestType:'regular',workflowVersion:2,displayStatus:'accepted',regular:{approvalExpiresAt:'2000-01-01'},lines:[{status:'changes_requested'}]};
  assert.equal(salesStockRequestStatus(d),'expired');
  d.regular.deliveryMethod='stocking';assert.equal(salesStockRequestStatus(d),'changes_requested');
  const supply=['in_stock','low_inventory','vendor_transfer','production','allocation','no_stock','already_ordered'];
  fc.assert(fc.property(fc.array(fc.constantFrom(...supply)),lines=>{
    for(const value of supply)assert.equal(matchesSalesStockStatus({lines:lines.map(supplyStatus=>({supplyStatus}))},'supply:'+value),lines.includes(value));
  }),{seed:9,numRuns:100});
});
