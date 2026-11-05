import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import fc from 'fast-check';
import { buildExchangeIntent, exchangeMonth, exchangeDestination, exchangeMemo, isStockExchange } from '../../../src/stock-exchange-domain.js';

const record = { recordType:'exchange', stockReturnType:'quality', receivingLocationId:1,
  submittedAt:'2026-10-29T12:00:00Z',sourceSalesOrderRef:'SOB123456',
  lines:[{itemId:123,returnedSalesQuantity:2,salesUomId:3,reasonId:5}] };
test('Toronto month and all three exact yard memos and destinations',()=>{
  assert.equal(exchangeMonth('2026-11-01T03:59:59Z'),'2026-10');
  assert.equal(exchangeMonth('2026-11-01T04:00:00Z'),'2026-11');
  for(const [id,code,destination] of [[1,'3445',9],[28,'2967',39],[26,'150',42]]){
    assert.equal(exchangeMemo(id,'2026-10'),`${code} 2026 Oct Exchange`);
    assert.deepEqual(exchangeDestination([{id,subsidiary:1},{id:destination,parent:id,name:`${code} Return`}],id),
      {sourceId:id,destinationId:destination,subsidiaryId:1});
  }
  assert.throws(()=>exchangeDestination([{id:1,subsidiary:1}],1),/active Return/);
  assert.throws(()=>exchangeMemo(15,'2026-10'),/yard/);
});
test('exchange quantity property preserves quantity, unit, SO and quality reason exactly',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:1000000}),fc.integer({min:5,max:9}),fc.integer({min:1,max:500}),
    (qty,reasonId,salesUomId)=>{
      const intent=buildExchangeIntent({...record,lines:[{...record.lines[0],returnedSalesQuantity:qty/100,reasonId,salesUomId}]});
      const line=intent.lines[0];
      assert.equal(line.adjustQtyBy,qty/100);assert.equal(line.custcol_atlas_rc_so.id,String(reasonId));
      assert.equal(line.units,String(salesUomId));assert.equal(line.custcol_position,'SOB123456');
      assert.equal(intent.memo,'3445 2026 Oct Exchange');assert.equal(intent.externalId,'mbbs-exchange-1-2026-10');
    }),{seed:3445,numRuns:150});
});
test('invalid quantities, reasons, units, dates and SO reference are refused',()=>{
  for(const returnedSalesQuantity of [0,-1,Infinity,NaN,1e13]){assert.throws(()=>buildExchangeIntent({...record,lines:[{...record.lines[0],returnedSalesQuantity}]}));}
  for(const reasonId of [0,4,10,999]){assert.throws(()=>buildExchangeIntent({...record,lines:[{...record.lines[0],reasonId}]}));}
  assert.throws(()=>buildExchangeIntent({...record,lines:[{...record.lines[0],salesUomId:null}]}));
  assert.throws(()=>buildExchangeIntent({...record,sourceSalesOrderRef:"SO' OR 1=1"}));
  assert.throws(()=>exchangeMonth('bad date'));
});

const source=fs.readFileSync('public/operator.js','utf8');
function extract(name){const start=source.search(new RegExp(`(?:async )?function ${name}\\(`));assert.ok(start>=0,name);
  const end=source.slice(start+1).search(/\n(?:async )?function /);return source.slice(start,end<0?undefined:start+end+1);}
test('Return menu includes Stock exchange and review identifies its Inventory Transfer',()=>{
  let rendered='';const page=vm.createContext({currentModule:'stock-exchange',locationId:1,returnMode:'stock',operator:{display_name:'Test'},
    currentLocation:()=>({text:'3445'}),t:(_key,value)=>value,escapeHtml:String,shell:(_title,_sub,body)=>{rendered=body;},
    returnResult:{stockExchange:{reference:'SE-000001',recordType:'exchange',netSuiteStage:'inventory_transfer',netSuiteTransactionRef:'IT123',netSuiteSyncStatus:'succeeded'}},
    localizeMessage:String});
  for(const name of ['renderReturnSelect','returnNetSuiteResultLabel','renderReturnSuccess']){vm.runInContext(extract(name),page);}
  page.renderReturnSelect();assert.match(rendered,/data-module="stock-exchange"/);assert.match(rendered,/Stock exchange/);
  assert.match(page.renderReturnSuccess(),/Inventory Transfer/);assert.match(page.renderReturnSuccess(),/SE-000001/);
});

test('exchange property rejects every reason outside R1–R5',()=>{
  fc.assert(fc.property(fc.integer({min:1,max:1000}).filter(reason=>reason<5||reason>9),reasonId=>{
    assert.throws(()=>buildExchangeIntent({...record,lines:[{...record.lines[0],reasonId}]}),/R1.R5/);
  }),{seed:2967,numRuns:150});
});

test('empty exchange drafts resume into the stock editor and never select PALLET',()=>{
  const page=vm.createContext({currentModule:'stock-exchange',returnMode:'stock',returnLines:()=>[]});
  for(const name of ['draftReturnMode','firstReturnLineId']){vm.runInContext(extract(name),page);}
  assert.equal(page.draftReturnMode({returnMode:'exchange'}),'stock');
  assert.equal(page.firstReturnLineId(),'');
});

test('stock return fallback retry keys remain compatible and exchanges have a separate identity',()=>{
  const repository=fs.readFileSync('src/return-repository.js','utf8');
  const start=repository.indexOf('function normalizedIdempotencyKey(');
  const end=repository.indexOf('\nfunction publicYardSettings',start);
  assert.ok(start>=0&&end>start);
  const now=Date.parse('2026-10-29T12:00:00Z');
  const input={receivingLocationId:1,orderId:123,stockReturnType:'quality',lines:[{sourceLineId:1,salesQuantity:2,reasonId:5}]};
  const legacy={operatorId:'operator-1',bucket:Math.floor(now/300000),receivingLocationId:1,orderId:123,stockReturnType:'quality',lines:input.lines};
  const expected=`fallback:${crypto.createHash('sha256').update(JSON.stringify(legacy)).digest('hex')}`;
  const context=vm.createContext({crypto,cleanText:value=>String(value||''),isStockExchange,Date:{now:()=>now}});
  vm.runInContext(repository.slice(start,end),context);
  assert.equal(context.normalizedIdempotencyKey(input,'operator-1'),expected);
  assert.notEqual(context.normalizedIdempotencyKey({...input,returnMode:'exchange'},'operator-1'),expected);
});

test('a 2967 (SOA) order is looked up for exchange at 3445 while its stock return stays blocked',async()=>{
  const bodies=[];
  const page=vm.createContext({RETURN_ORDER_PREFIX_YARDS:{SOA:{locationId:28,yardCode:'2967'},SOB:{locationId:1,yardCode:'3445'},SOM:{locationId:26,yardCode:'150'}},
    returnYardSettings:[{locationId:1,allowCrossYardReturns:false}],locationId:1,currentModule:'stock-exchange',returnMode:'stock',
    returnBusy:false,returnLookupCode:'',returnLookupMessage:'',normalizedPickupCameraCode:value=>String(value).toUpperCase(),
    t:(_key,value)=>value,tf:(_key,value,vars)=>value.replace('{yard}',vars.yard),render:()=>undefined,
    stopReturnScannerCamera:()=>undefined,clearReturnCustomerSearch:()=>undefined,returnOrderNotFulfilledMessage:()=>'',returnYardName:()=>'',
    api:async(_path,options)=>{bodies.push(JSON.parse(options.body));throw new Error('stop after request');}});
  for(const name of ['returnOrderPrefixYard','currentReturnYardSetting','currentYardAllowsCrossYardReturns','returnLookupYardPreflight','lookupReturnOrder']){
    vm.runInContext(extract(name),page);
  }
  assert.equal(page.returnLookupYardPreflight('SOA1001').blocked,false);
  await page.lookupReturnOrder('SOA1001');
  assert.deepEqual(bodies,[{code:'SOA1001',receivingLocationId:1,mode:'exchange'}]);
  page.currentModule='stock-return';
  assert.equal(page.returnLookupYardPreflight('SOA1001').blocked,true);
  await page.lookupReturnOrder('SOA1001');
  assert.equal(bodies.length,1);
  assert.match(page.returnLookupMessage,/2967/);
});

test('exchange and return reasons show in Chinese while the English NetSuite label is kept',()=>{
  const storage=new Map([['mbbs.ui.language','zh-CN']]);
  const page=vm.createContext({localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},
    document:{documentElement:{},addEventListener(){}},CustomEvent:class{},dispatchEvent:()=>true,escapeHtml:String,returnType:'quality',
    renderReturnUnitInputs:()=>'',returnReasons:{normalReason:{id:'10',label:'GD - Good Condition'},qualityReasons:[
      {id:'5',label:'R1 - Color Variation'},{id:'6',label:'R2 - Efflorescence'},{id:'7',label:'R3 - Chipping / Crack'},
      {id:'8',label:'R4 - Surface'},{id:'9',label:'R5 - Others'}]}});
  vm.runInContext('window = globalThis',page);
  vm.runInContext(fs.readFileSync('public/i18n.js','utf8'),page);
  vm.runInContext(`const t=(key,fallback)=>window.MBBS_I18N?.t(key,fallback)||fallback;
    const tf=(key,fallback,variables={})=>window.MBBS_I18N?.format(key,fallback,variables)||fallback;
    const localizeMessage=message=>window.MBBS_I18N?.message(message)||String(message||'');`,page);
  const constant=source.match(/const RETURN_REASON_I18N_KEYS = [\s\S]*?\}\);/)?.[0];assert.ok(constant);
  vm.runInContext(constant,page);
  for(const name of ['returnReasonText','renderReturnStockRow']){vm.runInContext(extract(name),page);}
  const row=page.renderReturnStockRow({},{clientRowKey:'a',reasonId:'6'},0);
  for(const label of ['R1 - 色差','R2 - 泛碱 / 白华','R3 - 缺角 / 裂纹','R4 - 表面问题','R5 - 其他']){assert.ok(row.includes(label),label);}
  assert.doesNotMatch(row,/Color Variation|Efflorescence/);
  assert.match(row,/value="6" selected>R2 - 泛碱 \/ 白华</);
  // History lines carry the reason ID; a reworded NetSuite label still translates by ID.
  assert.equal(page.returnReasonText({reasonId:7,reasonLabel:'R3 - Chipping/Cracks'}),'R3 - 缺角 / 裂纹');
  assert.equal(page.returnReasonText({reasonId:10,reasonLabel:'GD - Good Condition'}),'GD - 状况良好');
  assert.equal(page.returnReasonText({label:'R5 - Others'}),'R5 - 其他');
  page.MBBS_I18N.setLanguage('en');
  assert.equal(page.returnReasonText({id:'5',label:'R1 - Color Variation'}),'R1 - Color Variation');
  assert.match(page.renderReturnStockRow({},{clientRowKey:'a',reasonId:''},0),/>R2 - Efflorescence</);
});
