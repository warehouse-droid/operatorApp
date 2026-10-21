import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {parseScmStockQueues,SCM_STOCK_QUEUES,scmQueueFilterHtml} from '../../../public/stock-request-queue-filter.js';
const queues=Object.keys(SCM_STOCK_QUEUES);
test('SCM queue parsing is a canonical deduplicated union and round trips through CSV',()=>{
  fc.assert(fc.property(fc.array(fc.constantFrom(...queues),{minLength:1,maxLength:64}),values=>{
    const expected=queues.filter(queue=>values.includes(queue));
    assert.deepEqual(parseScmStockQueues(values),expected);assert.deepEqual(parseScmStockQueues(values.join(',')),expected);
    assert.deepEqual(parseScmStockQueues(expected.join(',')),expected);assert.deepEqual(parseScmStockQueues(values.map(value=>' '+value.toUpperCase()+' ')),expected);
    const html=scmQueueFilterHtml(expected.join(','));assert.equal((html.match(/checked/g)||[]).length,expected.length);
  }),{seed:20261007,numRuns:300});
});
test('Empty queue selection means all, absent queue means Request, and invalid mixed values are rejected',()=>{
  assert.deepEqual(parseScmStockQueues(''),queues);assert.deepEqual(parseScmStockQueues([]),queues);assert.deepEqual(parseScmStockQueues(),['request']);
  assert.ok(scmQueueFilterHtml('').includes('Queue: All'));assert.equal(scmQueueFilterHtml('').includes('checked'),false);
  fc.assert(fc.property(fc.string().filter(value=>!queues.includes(value.trim().toLowerCase())),invalid=>{
    assert.throws(()=>parseScmStockQueues(['request',invalid]),{status:400,code:'STOCK_REQUEST_QUEUE_INVALID'});
  }),{seed:38,numRuns:200});
  for(const invalid of [0,{},['request',null],Array(65).fill('request')])assert.throws(()=>parseScmStockQueues(invalid),{code:'STOCK_REQUEST_QUEUE_INVALID'});
});
