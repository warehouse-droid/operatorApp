// The NetSuite order webhook receiver runs in its own container so app releases and restarts do not lose
// NetSuite order webhooks (Cloudflare routes /api/webhooks/netsuite/order to it). It must answer exactly
// like the app's route, save to the same inbox, and never load the app.
import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {app} from '../../src/server.js';
import {config} from '../../src/config.js';
import {query,closeDb} from '../../src/db.js';

const RECEIVER_URL=new URL('../../src/netsuite-order-webhook-receiver.js',import.meta.url);
const SECRET='receiver-test-secret-0123456789abcdef';
const originalSecret=config.netsuite.webhookSecret;
config.netsuite.webhookSecret=SECRET;
const servers=[app.listen(0,'127.0.0.1')];
after(async()=>{
  config.netsuite.webhookSecret=originalSecret;
  for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await closeDb();
});

const receiverModule=()=>import(RECEIVER_URL.href);
async function baseUrl(server){
  if(!server.listening) await new Promise(resolve=>server.once('listening',resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const appUrl=()=>baseUrl(servers[0]);
async function receiverUrl(options){
  const {startNetSuiteOrderWebhookReceiver,createNetSuiteOrderWebhookReceiver}=await receiverModule();
  const server=await startNetSuiteOrderWebhookReceiver({port:0,...(options?{receiver:createNetSuiteOrderWebhookReceiver(options)}:{})});
  servers.push(server);
  return baseUrl(server);
}
const order=(id,extra={})=>({recordType:'salesorder',id:String(id),tranid:`SO-RCV-${id}`,eventType:'edit',
  lastModifiedDate:'2026-11-09T20:00:00Z',status:'Pending Fulfillment',lines:[],...extra});
async function post(base,body,headers={'x-mbbs-webhook-secret':SECRET}){
  const response=await fetch(`${base}/api/webhooks/netsuite/order`,{method:'POST',
    headers:{'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
  const text=await response.text();
  let json=null;try{json=JSON.parse(text);}catch{json={text};}
  return {status:response.status,json};
}
// Responses must match except the inbox row id.
const comparable=({status,json})=>({status,json:Object.fromEntries(Object.entries(json).filter(([key])=>key!=='queueId'))});
const inbox=id=>query(`SELECT status,payload->>'tranid' AS tranid FROM netsuite_order_webhook_inbox
  WHERE netsuite_order_id::text=$1 ORDER BY id`,[String(id)]).then(result=>result.rows);

test('the receiver saves a NetSuite order webhook to the inbox and answers like the app',async()=>{
  const receiver=await receiverUrl();
  const first=await post(receiver,order(990101));
  assert.equal(first.status,202,JSON.stringify(first.json));
  assert.equal(first.json.accepted,true);assert.equal(first.json.queued,true);assert.ok(first.json.queueId);
  assert.deepEqual(await inbox(990101),[{status:'queued',tranid:'SO-RCV-990101'}]);
  const repeat=await post(receiver,order(990101));
  assert.equal(repeat.status,202);assert.equal(repeat.json.duplicate,true);
  assert.equal((await inbox(990101)).length,1);
  const viaApp=await post(await appUrl(),order(990102));
  assert.deepEqual(comparable(first),comparable(viaApp));
  assert.deepEqual(comparable(repeat),comparable(await post(await appUrl(),order(990102))));
});

test('refusals and the legacy body secret match the app',async()=>{
  const receiver=await receiverUrl(),viaApp=await appUrl();
  const cases=[
    ['wrong secret',id=>[order(id),{'x-mbbs-webhook-secret':'wrong'}]],
    ['no secret',id=>[order(id),{}]],
    ['no record type',id=>[{id:String(id),tranid:'SO-RCV-BAD'}]],
    ['no order id',()=>[{recordType:'salesorder',tranid:'SO-RCV-BAD'}]],
    ['broken JSON',()=>['{"recordType":"salesorder",']],
    ['secret in the body',id=>[{...order(id),secret:SECRET},{}]],
  ];
  let id=990200;
  for(const [name,make] of cases){
    const fromReceiver=await post(receiver,...make(++id));
    const fromApp=await post(viaApp,...make(++id));
    assert.deepEqual(comparable(fromReceiver),comparable(fromApp),name);
  }
  assert.equal((await inbox(990201)).length,0,'a wrong secret saves nothing');
  config.netsuite.webhookSecret='';
  try {
    const fromReceiver=await post(receiver,order(990301)),fromApp=await post(viaApp,order(990302));
    assert.equal(fromReceiver.status,503);assert.deepEqual(fromReceiver,fromApp);
  } finally {config.netsuite.webhookSecret=SECRET;}
});

test('health reports whether the database answers',async()=>{
  const healthy=await fetch(`${await receiverUrl()}/health`);
  assert.equal(healthy.status,200);assert.deepEqual(await healthy.json(),{ok:true,service:'webhook-receiver'});
  const down=await fetch(`${await receiverUrl({ping:async()=>{throw new Error('connection refused');}})}/health`);
  assert.equal(down.status,503);
  assert.equal((await fetch(`${await receiverUrl()}/api/other`)).status,404);
});

test('the receiver never loads the app (server.js)',async()=>{
  const seen=new Set(),pending=[RECEIVER_URL];
  while(pending.length){
    const url=pending.pop();
    if(seen.has(url.href)) continue;
    seen.add(url.href);
    const source=await readFile(url,'utf8');
    for(const [,specifier] of source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+["'](\.{1,2}\/[^"']+)["']/gmu)){
      pending.push(new URL(specifier,url));
    }
  }
  const files=[...seen].map(href=>href.split('/src/').pop());
  assert.ok(files.includes('netsuite-order-webhook-queue-repository.js'),files.join(','));
  assert.ok(!files.includes('server.js'),files.join(','));
  assert.ok(files.length<=20,`the receiver loads ${files.length} modules: ${files.join(',')}`);
});

test('the container entry point starts, saves a webhook, and stops cleanly on SIGTERM',async()=>{
  const child=spawn(process.execPath,[RECEIVER_URL.pathname],{env:{...process.env,PORT:'0',NETSUITE_WEBHOOK_SECRET:SECRET}});
  let output='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{output+=data;});
  const exited=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})));
  const timer=setTimeout(()=>child.kill('SIGKILL'),30_000);
  try {
    const started=Date.now();
    while(!/listening on port (\d+)/u.test(output)){
      assert.ok(child.exitCode===null,output.slice(-4000));
      assert.ok(Date.now()-started<15_000,'no listening line: '+output.slice(-4000));
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    const port=output.match(/listening on port (\d+)/u)[1];
    const saved=await post(`http://127.0.0.1:${port}`,order(990401));
    assert.equal(saved.status,202,JSON.stringify(saved.json));
    assert.deepEqual(await inbox(990401),[{status:'queued',tranid:'SO-RCV-990401'}]);
    child.kill('SIGTERM');
    assert.deepEqual(await exited,{code:0,signal:null},output.slice(-4000));
  } finally {clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');}
});
