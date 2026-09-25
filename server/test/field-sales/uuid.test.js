import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { newId } from '../../public/field-sales/identity.js';

test('UUID fallback produces valid unique v4 IDs without randomUUID',()=>{
  const crypto={getRandomValues:bytes=>webcrypto.getRandomValues(bytes)};
  const ids=Array.from({length:1000},()=>newId(crypto));
  assert.equal(new Set(ids).size,1000);
  for(const id of ids){assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);}
});
test('UUID native method retains its receiver and unavailable crypto fails clearly',()=>{
  const crypto={randomUUID(){assert.equal(this,crypto);return 'native';}};
  assert.equal(newId(crypto),'native');
  assert.throws(()=>newId({}),/browser.*secure random/i);
});
