import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source=readFileSync(new URL('../../../public/operator.js',import.meta.url),'utf8');

function load(name,values) {
  const start=source.indexOf(`async function ${name}(`);
  assert.ok(start>=0);
  const end=source.indexOf('\n}',start)+2;
  const executable=source.slice(0,start).replace(/[^\n]/g,' ')+source.slice(start,end);
  const context=vm.createContext(values);
  new vm.Script(executable,{filename:path.resolve('public/operator.js')}).runInContext(context);
  return context;
}

test('detail requests carry the chosen yard for multiple-yard accounts',async()=>{
  const requests=[];
  const context=load('loadReceivingDetail',{
    locationId:1,receivingSelectedId:null,receivingDetailRequest:0,receivingOrderType:'purchase_order',receivingOrders:[],
    invalidateReceivingRequests:()=>{},receivingRequestContext:()=>({}),receivingRequestIsCurrent:()=>true,render:()=>{},
    api:async url=>{requests.push(url);return{lines:[]};}
  });
  await context.loadReceivingDetail('1026879');
  assert.equal(new URL(requests[0],'http://local').searchParams.get('locationId'),'1');
  context.locationId=28;
  await context.loadReceivingDetail('1026879');
  assert.equal(new URL(requests[1],'http://local').searchParams.get('locationId'),'28');
});

test('page line confirmation and unconfirmation carry the chosen yard',async()=>{
  const requests=[];
  const common={locationId:1,receivingSelectedId:'1026879',receivingSelectedOrder:{order_type:'purchase_order',lines:[{id:1}]},
    pageConfirming:false,receivingOrderType:'purchase_order',receivingLinePage:0,activeLinePageSize:()=>10,
    isPickableLine:()=>true,hasReceivingRemainingQty:()=>true,pageItems:rows=>rows,
    receivingConfirmPayloadForLine:()=>({pallets:1}),confirmPayloadHasQty:()=>true,
    updatePageConfirmControls:()=>{},render:()=>{},showToast:()=>{},t:(_key,value)=>value,
    api:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return{confirmed:1,lines:[]};}
  };
  await load('confirmReceivingPage',{...common}).confirmReceivingPage();
  await load('unconfirmReceivingLine',{...common}).unconfirmReceivingLine(1);
  const row={querySelector:()=>({value:'1'})};
  await load('confirmReceivingLine',{...common,app:{querySelector:()=>row},isIndependentManualLine:()=>false}).confirmReceivingLine(1);
  assert.deepEqual(requests.map(request=>request.body.locationId),[1,1,1]);
});

test('installing the tablet cache fetches the updated client used by the HTML shell',async()=>{
  const worker=readFileSync(new URL('../../../public/service-worker.js',import.meta.url),'utf8');
  const html=readFileSync(new URL('../../../public/operator.html',import.meta.url),'utf8');
  const previous=readFileSync(new URL('../../support/receiving-multi-yard-baseline/public/operator.html',import.meta.url),'utf8');
  const currentUrl=html.match(/src="(\/operator\.js\?v=[^"]+)"/)[1];
  assert.notEqual(currentUrl,previous.match(/src="(\/operator\.js\?v=[^"]+)"/)[1]);
  const handlers=new Map();
  let requests,completion;
  const context=vm.createContext({URL,Request,
    self:{location:{origin:'http://local'},addEventListener:(name,handler)=>handlers.set(name,handler),skipWaiting:()=>{}},
    caches:{open:async()=>({addAll:async rows=>{requests=rows;}})}});
  new vm.Script(worker,{filename:path.resolve('public/service-worker.js')}).runInContext(context);
  handlers.get('install')({waitUntil:promise=>{completion=promise;}});
  await completion;
  const client=requests.find(request=>new URL(request.url).pathname==='/operator.js');
  assert.equal(new URL(client.url).pathname+new URL(client.url).search,currentUrl);
  assert.equal(client.cache,'reload');
});
