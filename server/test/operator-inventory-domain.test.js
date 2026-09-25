import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { inventoryDate, damageMemo, damageMemoMonth, damageDestination, quantitySnapshot, inventoryYards, assertInventoryYard, countSheetCommand } from '../src/inventory-workflow-domain.js';
import '../public/counting-calculator.js';
const calc = globalThis.MBBSCountingCalculator;
const operator = { id: 'op', role: 'operator', operatorYardLocationIds: [1] };
const manager = { id: 'mgr', role: 'yard_manager', yardLocationIds: [1] };
const item = { to_plt: 54.18, to_lyr: 9.03, to_pcs: 0, stock_unit: 'SQFT', sales_unit: 'SQFT', sales_unit_id: 613 };
test('D4: Toronto acceptance date and exact IT00551 memo', () => {
  assert.equal(inventoryDate(new Date('2026-10-01T03:59:59Z')), '2026-09-30');
  assert.equal(inventoryDate(new Date('2026-10-01T04:00:00Z')), '2026-10-01');
  assert.equal(damageMemo(1, '2026-09'), '3445 2026 Sep Damage');
  assert.throws(() => damageMemo(1, '2026-13'));
});
test('D7: legacy month in memo wins over posting date', () => {
  for (const memo of ['2026 June 3445 Damage', '3445 2026 Jun Damage', '2026 June 3445 Damage (cannot do yard credit)']) assert.equal(damageMemoMonth(memo), '2026-06');
  assert.equal(damageMemoMonth('3445 2026 Sep Damage'), '2026-09');
  assert.equal(damageMemoMonth('3445 2026-09 Damage'), '2026-09');
  assert.equal(damageMemoMonth('ordinary transfer'), null);
});
test('D1: exact active child and unique destination', () => {
  const rows = [{id:'1', name:'3445', subsidiary:'1'}, {id:'10', parent:'1', name:'3445 Damage', isinactive:'F'}, {id:'8',parent:'1',name:'3445 Hold'}];
  assert.equal(damageDestination(rows, 1).destinationId, 10);
  assert.throws(() => damageDestination(rows, 28));
  assert.throws(() => damageDestination([...rows, {id:'99', parent:'1',name:'3445 Damage'}], 1));
  assert.throws(() => damageDestination(rows.map(r => r.id === '10' ? {...r,isinactive:'T'} : r), 1));
});
test('D3: physical conversion and actual sales UOM fallback', () => {
  assert.equal(quantitySnapshot(item, {pallets:1,layers:2}, {damage:true}).quantity, 72.24);
  const fallback=quantitySnapshot({stock_unit:'Ton',sales_unit:'Yard',sales_unit_id:888}, {sales:2.5}, {damage:true});
  assert.equal(fallback.quantity,2.5); assert.equal(fallback.unit,'Yard'); assert.equal(fallback.unitId,888);
  assert.throws(() => quantitySnapshot(item,{pieces:1},{damage:true}));
  assert.throws(() => quantitySnapshot(item,{}, {damage:true}));
  assert.throws(() => quantitySnapshot({}, {sales:1}, {damage:true}));
});
test('D2/C3: invalid quantities cannot normalize into valid counts', () => {
  for(const value of [-1,Infinity,NaN,'no',true,[],{},'']) assert.throws(() => quantitySnapshot(item,{pallets:value}));
  assert.equal(quantitySnapshot(item,{pallets:0}).quantity,0);
  assert.equal(quantitySnapshot({stock_unit:'Ton'}, {pieces:3}).quantity,3);
});
test('A1: management and operator yard grants are independent', () => {
  assert.deepEqual(inventoryYards(operator),[1]); assert.deepEqual(inventoryYards(manager,true),[1]);
  assert.throws(() => inventoryYards(operator,true));
  assert.throws(() => assertInventoryYard(operator,28));
  assert.throws(() => assertInventoryYard({...manager,yardLocationIds:[]},1,true));
  assert.equal(inventoryYards({role:'admin'},true).length,4);
});
test('C2/C3/C4: owner, generation and completion fences', () => {
  const sheet={status:'in_progress',owner_id:'op',revision:3,attempt:2};
  assert.doesNotThrow(()=>countSheetCommand(sheet,operator,{revision:3,attempt:2},'line'));
  assert.throws(()=>countSheetCommand(sheet,{...operator,id:'other'},{revision:3,attempt:2},'line'));
  assert.throws(()=>countSheetCommand(sheet,operator,{revision:2,attempt:1},'line'));
  assert.throws(()=>countSheetCommand({...sheet,status:'submitted'},operator,{revision:3,attempt:2},'line'));
});
test('K1: arithmetic, malformed input and finite nonnegative result', () => {
  assert.equal(calc.evaluate('12 × 9'),108); assert.equal(calc.evaluate('12+3*2'),18);
  assert.equal(calc.evaluate('5-10+6'),1); assert.equal(calc.evaluate('0.1+0.2'),0.3);
  for(const expression of ['1+','2-3','1/2','(1+2)','process.exit()','Infinity','1**2','']) assert.throws(()=>calc.evaluate(expression));
});
test('K1: Clear, Backspace and continuation after equals', () => {
  let state={expression:'0',evaluated:false};
  for(const key of ['1','2','×','9','=']) state=calc.press(state,key);
  assert.equal(state.expression,'108'); assert.equal(state.value,108);
  state=calc.press(state,'+'); state=calc.press(state,'2'); state=calc.press(state,'='); assert.equal(state.value,110);
  state=calc.press(state,'7'); assert.equal(state.expression,'7');
  state=calc.press(state,'Back'); assert.equal(state.expression,'0');
  assert.equal(calc.press(state,'Clear').value,0);
});
test('D3/K1: independent arithmetic and conversion properties', () => {
  fc.assert(fc.property(fc.integer({min:0,max:1000}),fc.integer({min:0,max:1000}),fc.integer({min:1,max:500}), (a,b,c) => {
    assert.equal(calc.evaluate(`${a}+${b}*${c}`),a+b*c);
    assert.equal(quantitySnapshot({to_plt:c,to_lyr:1,stock_unit:'PCS'},{pallets:a,layers:b}).quantity,a*c+b);
  }),{seed:23092026,numRuns:300});
});
test('D1-D4/A1: invalid configuration and malformed input fail closed',()=>{
  assert.throws(()=>damageMemo(999,'2026-09'));
  assert.equal(damageMemoMonth('Damage without month'),null);
  assert.throws(()=>damageDestination([{id:1,name:'3445',isinactive:true},{id:10,parent:1,name:'3445 Damage'}],1));
  assert.throws(()=>inventoryYards({role:'sales'}));assert.deepEqual(inventoryYards({role:'operator'}),[]);
  for(const value of [0,-1,'01',{},'1000000000000000000']) assert.throws(()=>assertInventoryYard(operator,value));
  for(const input of [null,[],{unknown:2},{sales:1},{pallets:1e13}]) assert.throws(()=>quantitySnapshot(item,input));
  assert.throws(()=>quantitySnapshot({to_plt:1e12},{pallets:2}));
  assert.equal(quantitySnapshot({},{}).unit,'Qty');
  assert.equal(quantitySnapshot({stock_unit_id:191},{pieces:2}).unitId,191);
  assert.throws(()=>countSheetCommand({status:'in_progress',owner_id:'op',revision:1,attempt:1},operator,{revision:1,attempt:1},'erase'));
});
test('K1: calculator decimal entry, corrections and overflow are explicit',()=>{
  let state=calc.press(undefined,'.');state=calc.press(state,'2');assert.equal(calc.evaluate(state.expression),0.2);
  state=calc.press(state,'+');state=calc.press(state,'×');state=calc.press(state,'3');assert.equal(calc.press(state,'=').value,0.6);
  assert.equal(calc.press({expression:'12',evaluated:true},'.').expression,'0.');
  assert.throws(()=>calc.press(state,'/'));assert.throws(()=>calc.press({expression:'1'.repeat(160)},'1'));
  assert.throws(()=>calc.evaluate('1'.repeat(161)));assert.throws(()=>calc.evaluate('1000000000000*2'));
  assert.equal(calc.evaluate('12X9−8'),100);
  assert.match(calc.pad(),/data-key="×"/);assert.match(calc.pad('data-inv-action','count-key'),/data-inv-action="count-key"/);
});
