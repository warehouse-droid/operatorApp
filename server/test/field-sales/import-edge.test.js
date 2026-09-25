import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlanning,normalizePermit } from '../../public/field-sales/domain.js';

test('I3 missing coordinates stay unknown; unlocated permits never merge unrelated permit numbers',()=>{
  const p=normalizePlanning({APPLICATION_TYPE:'Community planning',STATUS_GROUP:'Open',FOLDERRSN:1,PROPERTYRSN:2,FULL_ADDRESS:'1 Test Road',LATITUDE:null,LONGITUDE:null});
  assert.equal(p.latitude,null);assert.equal(p.longitude,null);
  const a=normalizePermit({PERMIT_NUM:'A',STATUS:'Active'}),b=normalizePermit({PERMIT_NUM:'B',STATUS:'Active'});
  assert.notEqual(a.groupKey,b.groupKey);assert.match(a.address,/unavailable/i);
});
