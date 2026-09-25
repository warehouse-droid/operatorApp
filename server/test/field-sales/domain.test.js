import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { calculateQuote, requireFieldSales, assertRouteOwner, torontoWindow, torontoDate, normalizeAddress, normalizePlanning, normalizePermit, recommendedRank, proposeOrder } from '../../public/field-sales/domain.js';

const actor = { id: 'rep-a', role: 'field_sales' };
const policies = { MBBS: { taxBps: 1300 }, MBT: { taxBps: 1300 } };
const line = (company, quantity, unitRate) => ({ id: company, company, itemId: '123', description: 'Item', quantity, unitRate });

test('Q1 exact decimal totals split into companies', () => {
  const q = calculateQuote({ currency: 'CAD', lines: [line('MBBS','3','19.99'), line('MBT','2','100')] }, policies);
  assert.equal(q.subtotalMinor, 25997);
  assert.equal(q.companies.MBBS.totalMinor, 6777);
  assert.equal(q.companies.MBT.totalMinor, 22600);
  assert.equal(q.totalMinor, 29377);
});
test('Q2 reject malformed, negative, excessive or unsafe values, unknown companies and currencies', () => {
  for (const value of ['-1','NaN','Infinity','1e3','1.0000001','9999999999999999999']) {
    assert.throws(() => calculateQuote({ lines:[line('MBBS',value,'1')] }, policies));
  }
  assert.throws(() => calculateQuote({ lines:[line('OTHER','1','1')] }, policies));
  assert.throws(() => calculateQuote({ currency:'USD', lines:[line('MBBS','1','1')] }, policies));
  assert.throws(() => calculateQuote({ lines:[line('MBBS','0','1')] }, policies));
  assert.throws(() => calculateQuote({ lines:[line('MBBS','1','1')] }, {}));
});
test('Q3 decimal half-cent and fractional quantity rounding', () => {
  const q = calculateQuote({ lines:[line('MBBS','0.125','19.96')] }, policies);
  assert.equal(q.lines[0].amountMinor,250);
  assert.equal(q.taxMinor,33);
  assert.equal(q.totalMinor,283);
});
test('Q4 company totals always sum and input order cannot affect totals', () => {
  fc.assert(fc.property(fc.array(fc.record({company:fc.constantFrom('MBBS','MBT'),q:fc.integer({min:1,max:100}),c:fc.integer({min:0,max:100000})}),{minLength:1,maxLength:30}), rows => {
    const lines=rows.map((r,i)=>({...line(r.company,String(r.q),(r.c/100).toFixed(2)),id:String(i)}));
    const q=calculateQuote({lines},policies);
    assert.equal(q.totalMinor,Object.values(q.companies).reduce((s,c)=>s+c.totalMinor,0));
    assert.equal(q.totalMinor,calculateQuote({lines:[...lines].reverse()},policies).totalMinor);
  }),{numRuns:200});
});
test('A1 Field Sales is independent of staff/public Sales', () => {
  assert.equal(requireFieldSales(actor),actor);
  assert.equal(requireFieldSales({id:'admin',roles:['admin']}).id,'admin');
  for(const a of [{id:'sales',role:'sales'},{id:'public',role:'sales',publicSales:true},null]) {assert.throws(()=>requireFieldSales(a));}
  assert.doesNotThrow(()=>assertRouteOwner(actor,{owner_id:'rep-a'}));
  assert.throws(()=>assertRouteOwner(actor,{owner_id:'rep-b'}));
});
test('R1 Toronto afternoon handles daylight saving and invalid dates', () => {
  assert.equal(torontoWindow('2026-09-18','afternoon').start,'2026-09-18T17:00:00.000Z');
  assert.equal(torontoWindow('2026-01-18','afternoon').start,'2026-01-18T18:00:00.000Z');
  assert.throws(()=>torontoWindow('2026-02-30','afternoon'));
});
test('I1 stable application identity and source evidence', () => {
  const a=normalizePlanning({FOLDERRSN:123,PROPERTYRSN:77,FULL_ADDRESS:'90 BELFIELD RD',APPLICATION_TYPE:'Community planning',STATUS_GROUP:'Open',LATEST_MILESTONE:'Statement of Approval Issued',DISTRICT_NAME:'West',WARD_NUMBER:'01',LATITUDE:43.7,LONGITUDE:-79.5});
  assert.equal(a.sourceKey,'123:77'); assert.equal(a.groupKey,'planning:123'); assert.equal(a.district,'Etobicoke-York');
  assert.equal(a.rank,30);
  assert.equal(normalizeAddress('90  Belfield Rd.'), normalizeAddress('90 BELFIELD ROAD'));
  assert.equal(normalizePlanning({APPLICATION_TYPE:'C of A',STATUS_GROUP:'Open'}),null);
});
test('I2 permits have no age cutoff and never assert observed construction', () => {
  const p=normalizePermit({PERMIT_NUM:'10 100000 BLD',REVISION_NUM:'00',STREET_NUM:'90',STREET_NAME:'BELFIELD',STREET_TYPE:'RD',STATUS:'Inspection ',ISSUED_DATE:'2010-01-01',PERMIT_TYPE:'New Building',POSTAL:'M9W'});
  assert.equal(p.status,'Inspection'); assert.equal(p.postalPrefix,'M9W'); assert.equal(p.observedStage,undefined);
  assert.equal(p.minor,false); assert.equal(recommendedRank('City Council Decision Made','Refused'),0);
});
test('R2 optimization is a preview, retains completed stops and each remaining stop', () => {
  const stops=[{id:'done',status:'completed',latitude:43,longitude:-79},{id:'far',latitude:43.8,longitude:-79},{id:'near',latitude:43.1,longitude:-79}];
  const before=JSON.stringify(stops);const ordered=proposeOrder(stops,{latitude:43,longitude:-79});
  assert.equal(JSON.stringify(stops),before);assert.deepEqual(ordered.map(s=>s.id),['done','near','far']);
});
test('Q8 invalid quote shape, overflowing cents and duplicate lines never produce a total',()=>{
  for(const input of [{},{lines:Array(201).fill(line('MBBS','1','1'))},{lines:[line('MBBS','999999999999','999999999999')]},{lines:[line('MBBS','1','1'),line('MBBS','2','2')]},{lines:[{...line('MBBS','1','1'),description:''}]}]){assert.throws(()=>calculateQuote(input,policies));}
  for(const taxBps of [-1,10001,1.3]){assert.throws(()=>calculateQuote({lines:[line('MBBS','1','1')]},{MBBS:{taxBps}}));}
  assert.equal(calculateQuote({lines:[]},policies).totalMinor,0);
});
test('R9 Toronto custom windows reject nonexistent hours and reversed plans',()=>{
  assert.equal(torontoDate(new Date('2026-01-02T02:00:00Z')),'2026-01-01');
  assert.equal(torontoWindow('2026-01-02','morning').end,'2026-01-02T17:00:00.000Z');
  assert.equal(torontoWindow('2026-07-02','custom','15:00','18:00').end,'2026-07-02T22:00:00.000Z');
  for(const args of [['2026-03-08','custom','02:30','04:00'],['2026-01-02','custom','18:00','15:00'],['invalid'],['2026-01-02','custom','25:00','26:00']]){assert.throws(()=>torontoWindow(...args));}
  assert.throws(()=>proposeOrder([{latitude:null,longitude:-79}],{latitude:43,longitude:-79}));
  assert.equal(recommendedRank('City Council Decision Made','Approved'),10);assert.equal(recommendedRank('Application Submitted'),0);assert.throws(()=>normalizePlanning({APPLICATION_TYPE:'Community planning',STATUS_GROUP:'Open'}));
});
test('R10 order refinement shortens a greedy detour without changing the selected jobsites',()=>{
  const points=[[43.701,-79.492],[43.707,-79.493],[43.707,-79.498],[43.704,-79.495],[43.706,-79.498],[43.705,-79.494]].map(([latitude,longitude],id)=>({id:String(id),latitude,longitude}));
  const origin={latitude:43.7,longitude:-79.5},greedy=[3,5,1,2,4,0].map(i=>points[i]);
  const length=path=>[origin,...path].slice(1).reduce((sum,p,i)=>{const before=i?path[i-1]:origin;return sum+Math.hypot((p.latitude-before.latitude)*111,(p.longitude-before.longitude)*81);},0);
  const proposed=proposeOrder(points,origin);assert.ok(length(proposed)<length(greedy));assert.deepEqual(proposed.map(p=>p.id).sort(),points.map(p=>p.id).sort());
});
