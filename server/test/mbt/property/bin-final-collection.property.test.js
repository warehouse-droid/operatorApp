import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {finalCollectionHold} from '../../../src/mbt/bin-final-collection.js';
const rows=fc.array(fc.record({reference:fc.nat(30).map(n=>`BIN${n}X-1C`),
  status:fc.constantFrom('tentative','ready','planned','in_progress','evidence_pending','completed','cancelled'),
  order_status:fc.constantFrom('ready','in_progress','completed','cancelled')}),{maxLength:30});
test('collection property: exactly the unfinished noncancelled rental jobs hold the final collection',()=>{
  fc.assert(fc.property(rows,work=>{
    const before=work.map(row=>Object.assign(Object.create(Object.getPrototypeOf(row)),row)),hold=finalCollectionHold('collection',work);
    const expected=[...new Set(work.filter(w=>w.order_status!=='cancelled'&&w.status!=='completed'&&w.status!=='cancelled').map(w=>w.reference))];
    if(expected.length) {assert.deepEqual(hold.references,expected);assert.match(hold.reason,/Waiting for.*complete:/);}
    else assert.equal(hold,null);
    assert.deepEqual(work,before);
  }),{seed:3445,numRuns:500});
});
test('collection property: delivery and exchange routes are never treated as final collections',()=>{
  fc.assert(fc.property(rows,fc.constantFrom('delivery','exchange'),(work,kind)=>{
    assert.equal(finalCollectionHold(kind,work),null);
  }),{seed:2967,numRuns:150});
});
