import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import fc from 'fast-check';
const source=readFileSync('public/stock-request-conversation.js','utf8');
function ordering() {
  const window={addEventListener(){}},document={addEventListener(){}},localStorage={getItem(){return '';}};
  runInNewContext(source,{window,document,localStorage,setInterval(){}});
  assert.equal(typeof window.StockRequestConversation.order,'function');
  return window.StockRequestConversation.order;
}
const ids=rows=>Array.from(rows,row=>row.id);
test('property: conversation order is descending, stable and does not alter request data',()=>{
  fc.assert(fc.property(fc.array(fc.nat({max:100000}),{minLength:2,maxLength:60}),events=>{
    const rows=events.map((conversationEventId,id)=>({id:id+1,conversationEventId,revision:3})),before=JSON.stringify(rows),order=ordering();
    const sorted=order(rows);
    assert.deepEqual(ids(sorted),ids([...rows].sort((a,b)=>b.conversationEventId-a.conversationEventId)));
    assert.equal(JSON.stringify(rows),before);assert.deepEqual(ids(order(sorted)),ids(sorted));
  }),{seed:20261016,numRuns:150});
});
test('property: stale queue snapshots cannot erase newer message priority',()=>{
  fc.assert(fc.property(fc.integer({min:2,max:100000}),latest=>{
    const order=ordering();order([{id:1,conversationEventId:latest},{id:2,conversationEventId:latest-1}]);
    assert.deepEqual(ids(order([{id:2,conversationEventId:latest-1},{id:1,conversationEventId:0}])),[1,2]);
    assert.deepEqual(ids(order([{id:1,conversationEventId:latest},{id:2,conversationEventId:latest+1}])),[2,1]);
  }),{seed:20261016,numRuns:100});
});
