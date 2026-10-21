import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {parseYardIds,yardFilterHtml} from '../../../public/stock-request-yard-filter.js';
import {validate,manifest,tables,execute,digest} from '../../../tools/stock-request-test-cleanup.mjs';

test('yard parser normalizes safe IDs, rejects malformed values, and escapes yard labels',()=>{
  for(const value of [undefined,null,'',[]]) assert.deepEqual(parseYardIds(value),[]);
  assert.deepEqual(parseYardIds(['28','1','28']),[1,28]);
  assert.deepEqual(parseYardIds(1),[1]);
  for(const value of ['1,',{},true,-1,0,1.5,Number.MAX_SAFE_INTEGER+1,[null],'1e2','',Array(65).fill(1)].filter(value=>value!=='')) assert.throws(()=>parseYardIds(value),{status:400});
  const html=yardFilterHtml([{locationId:1,yardCode:'<img src=x onerror="bad"> & yard'}],[1],{label:'"Yard"',disabled:true});
  assert.match(html,/type="checkbox"/); assert.match(html,/checked disabled/); assert.doesNotMatch(html,/<img/); assert.match(html,/&lt;img/);
  assert.match(yardFilterHtml([{locationId:1,name:'Name'},{locationId:28}],[]),/Yards: All/);
  fc.assert(fc.property(fc.array(fc.integer({min:1,max:99999}),{maxLength:50}),values=>{
    const expected=[...new Set(values)].sort((a,b)=>a-b);
    assert.deepEqual(parseYardIds(values.join(',')),expected);
    assert.deepEqual(parseYardIds(parseYardIds(values)),expected);
  }),{seed:270927,numRuns:100});
});

function snapshot(){return {rows:{...Object.fromEntries(tables.map(table=>[table,[]])),sales_stock_requests:manifest.map(row=>({id:row.id,request_ref:row.ref,request_type:'special'})),sales_special_stock_cases:manifest.map(row=>({request_id:row.id,sales_order_operation_status:'idle',purchase_order_operation_status:'idle'}))},foreignKeys:[]};}
test('cleanup accepts only the approved identities and owned rows, never active operations or unknown dependencies',()=>{
  validate(snapshot());
  const edits=[s=>s.rows.sales_stock_requests.pop(),s=>s.rows.sales_stock_requests[0].request_ref='SPREQ-OTHER',s=>s.rows.sales_stock_requests[0].request_type='regular',s=>s.rows.sales_special_stock_cases.pop(),s=>s.rows.sales_special_stock_events.push({request_id:1}),s=>s.rows.sales_stock_transfers.push({request_id:57}),s=>s.rows.sales_special_stock_media.push({request_id:57}),s=>s.foreignKeys.push({child:'unreviewed_table'})];
  for(const field of ['sales_order_operation_status','purchase_order_operation_status']) for(const status of ['creating','applying','closing']) edits.push(s=>s.rows.sales_special_stock_cases[0][field]=status);
  for(const field of ['quantity_review','closure_review']) edits.push(s=>s.rows.sales_special_stock_cases[0][field]={status:'applying'});
  for(const edit of edits){const value=snapshot();edit(value);assert.throws(()=>validate(value));}
});
test('cleanup rejects changed backups before any DELETE and rolls back',async()=>{
  const sql=[];const client={query:async statement=>{sql.push(statement);return {rows:[{payload:JSON.stringify(snapshot())}]};}};
  await assert.rejects(execute(client,{mode:'apply',expected:digest('stale')}),/Backup no longer matches/);
  assert.equal(sql.at(-1),'ROLLBACK'); assert.ok(!sql.some(statement=>statement.startsWith('DELETE')));
  assert.ok(!sql.includes('COMMIT'));
  await assert.rejects(execute(client,{mode:'other'}),/Unknown cleanup mode/);
});
