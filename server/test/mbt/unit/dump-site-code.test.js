import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {normalizeLocalMasterDataRow} from '../../../src/mbt/local-master-data-service.js';

const site=code=>({dumpSiteCode:code,displayName:'Dump site',addressLine1:'3445 Test Road',addressLine2:'',
  city:'Toronto',region:'ON',postalCode:'',countryCode:'CA',phone:'',latitude:null,longitude:null,
  itemAcceptances:[{itemCode:'DUMP',accepted:true,scaleTicketRequired:true,notes:'',active:true}],
  openingHours:[{isoWeekday:1,opensAt:'07:00',closesAt:'17:00'}],notes:'',active:true});

test('dump-site codes: numeric yard codes and hyphenated identities are accepted',()=>{
  for(const [entered,expected] of [['3445','3445'],['2967','2967'],[' north-dump_1 ','NORTH-DUMP_1']]) {
    assert.equal(normalizeLocalMasterDataRow('dump_sites',site(entered)).dumpSiteCode,expected);
  }
});
test('dump-site codes: rejected identities explain the code requirement',()=>{
  for(const code of ['', 'north dump','../3445','<script>','A'.repeat(65),'_3445']) {
    assert.throws(()=>normalizeLocalMasterDataRow('dump_sites',site(code)),/dump-site code/i);
  }
});
test('dump-site hours: backwards intervals explain the opening-hours problem',()=>{
  assert.throws(()=>normalizeLocalMasterDataRow('dump_sites',{...site('NORTH'),
    openingHours:[{isoWeekday:1,opensAt:'17:00',closesAt:'07:00'}]}),/opening.*clos|clos.*open/i);
});
test('dump-site code property: accepted identities normalize and round-trip without losing characters',()=>{
  const letterOrDigit=[...'aZ019'];const tail=[...letterOrDigit,'_','-'];
  fc.assert(fc.property(fc.tuple(fc.constantFrom(...letterOrDigit),fc.array(fc.constantFrom(...tail),{maxLength:63})),
    ([first,rest])=>{
      const code=first+rest.join(''),normalized=normalizeLocalMasterDataRow('dump_sites',site(` ${code} `));
      assert.equal(normalized.dumpSiteCode,code.toUpperCase());
      assert.deepEqual(normalizeLocalMasterDataRow('dump_sites',normalized),normalized);
    }),{numRuns:120,seed:3445});
});
