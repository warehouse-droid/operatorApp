import test from 'node:test';
import assert from 'node:assert/strict';
import {requestSearchRefs} from '../../../public/stock-request-search.js';

test('request lists match any full reference, ignoring duplicate references and case', () => {
  assert.deepEqual(requestSearchRefs('streq-000001, SPREQ-000002; STREQ-000001\nSTREQ-000003'), ['STREQ-000001','SPREQ-000002','STREQ-000003']);
  const refs = Array.from({length:150},(_,i)=>`SPREQ-${String(i+1).padStart(6,'0')}`);
  assert.deepEqual(requestSearchRefs(refs.join(', ')),refs);
});

test('partial references, item names and punctuation retain ordinary text search', () => {
  for (const value of ['',undefined,'STREQ-000','stone slab','Vendor, Inc.',"SPREQ-000001' OR true --"]) assert.deepEqual(requestSearchRefs(value),[]);
  assert.deepEqual(requestSearchRefs('streq-000001'),['STREQ-000001']);
});
