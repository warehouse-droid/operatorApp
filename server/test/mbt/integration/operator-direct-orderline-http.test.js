import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test, { before, after } from "node:test";
import { config } from "../../../src/config.js";
import { query, closeDb } from "../../../src/db.js";
import { createOperator } from "../../../src/auth-repository.js";
import { buildOperatorNetSuitePostingDraft } from "../../../src/operator-netsuite-posting-domain.js";
import { createOperatorNetSuitePostingProcessor } from "../../../src/operator-netsuite-posting-service.js";
import { operatorNetSuitePostingAdapter } from "../../../src/operator-netsuite-posting-netsuite-adapter.js";
import * as repo from "../../../src/operator-netsuite-posting-repository.js";

const previous = { ...config.netsuite };
const records = new Map();
const calls = [];
let server, actor, base, nextId=910000, delay=0, failSource=0, loseResponse=false, active=0, peak=0, finalized=0;
const repository={get:repo.getOperatorNetSuitePostingCommand,claim:repo.claimOperatorNetSuitePostingCommand,
  renew:repo.renewOperatorNetSuitePostingLease,startAttempt:repo.startOperatorNetSuitePostingAttempt,
  success:repo.recordOperatorNetSuitePostingStepSuccess,failure:repo.recordOperatorNetSuitePostingStepFailure,
  attention:repo.markOperatorNetSuitePostingCommandAttention,fail:repo.failOperatorNetSuitePostingCommand,
  complete:repo.completeOperatorNetSuitePostingCommand};

before(async()=>{
  assert.equal(process.env.MBT_TEST_ISOLATED,"1");
  actor=(await createOperator({username:`direct-${crypto.randomUUID()}`,displayName:"Direct posting test",password:"test-only",role:"operator",roles:["operator"],yardLocationIds:[15]})).id;
  await query("INSERT INTO netsuite_tokens(id,access_token,expires_at) VALUES(1,'direct-test-token',now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET access_token=EXCLUDED.access_token,expires_at=EXCLUDED.expires_at");
  server=http.createServer(async(req,res)=>{
    let body="";for await(const chunk of req) {body+=chunk;}
    const path=new URL(req.url,base).pathname;
    calls.push({method:req.method,path});active++;peak=Math.max(peak,active);
    try {
      if(req.method==="POST"&&path.includes("/!transform/")){
        const sourceId=Number(path.split("/")[6]);
        if(sourceId===failSource){res.writeHead(400,{"content-type":"application/json"});res.end(JSON.stringify({"o:errorDetails":[{"o:errorCode":"INVALID_QUANTITY"}]}));return;}
        await new Promise(resolve=>setTimeout(resolve,delay));
        const payload=JSON.parse(body);const id=++nextId;
        const type=path.endsWith("itemreceipt")?"itemReceipt":"itemFulfillment";
        records.set(String(id),{id,tranId:`TEST-${id}`,externalId:payload.externalId,createdFrom:{id:String(sourceId)},
          item:{items:payload.item.items.filter(line=>line.itemReceive)}});
        if(loseResponse){loseResponse=false;req.socket.destroy();return;}
        res.writeHead(204,{location:`${base}/record/v1/${type}/${id}`});res.end();return;
      }
      if(req.method==="GET"&&/\/item(?:Receipt|Fulfillment)\//.test(path)){
        const key=decodeURIComponent(path.split("/").at(-1));
        const record=key.startsWith("eid:")?[...records.values()].find(row=>row.externalId===key.slice(4)):records.get(key);
        res.writeHead(record?200:404,{"content-type":"application/json"});
        res.end(JSON.stringify(record||{"o:errorDetails":[{"o:errorCode":"NONEXISTENT_EXTERNAL_ID"}]}));return;
      }
      res.writeHead(500);res.end("Unexpected network call");
    } finally {active--;}
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  base=`http://127.0.0.1:${server.address().port}/services/rest`;
  Object.assign(config.netsuite,{directAccessEnabled:true,restBaseUrl:base});
});

after(async()=>{
  Object.assign(config.netsuite,previous);
  await new Promise(resolve=>server.close(resolve));
  await query("DELETE FROM operator_netsuite_posting_commands WHERE actor_operator_id=$1", [actor]);
  await closeDb();
});

function draft(kind="SO", count=1, sourceId=++nextId, ir=kind==="PO") {
  const transactionType=ir?"IR":"IF";
  const functionKey=ir?"receiving":kind==="SO"?"customer_pickup":"delivery_prep";
  const id=crypto.randomUUID();const localOrderKey=`${functionKey}:${kind}:${id}`;
  return buildOperatorNetSuitePostingDraft({requestId:id,actorOperatorId:actor,functionKey,transactionType,
    policy:{gateKey:`operator_netsuite_${functionKey}_${transactionType.toLowerCase()}_12441`,revision:1,effective:true,functionKey,transactionType,locationId:15,yardCode:"12441"},
    photoRefs:[],localOrderKeys:[localOrderKey],
    localOperation:{kind:ir?"receiving_receipt":kind==="SO"?"customer_pickup_load":"delivery_consolidation_load",orderId:id,
      orderType:{PO:"purchase_order",SO:"sales_order",TO:{IF:"consolidation_load",IR:"transfer_order"}[transactionType]}[kind]},
    targets:Array.from({length:count},(_,index)=>({postingStrategy:"stored_order_line_v1",sourceOrderKind:kind,
      sourceNetSuiteId:sourceId+index,sourceOrderRef:`SOURCE-${sourceId+index}`,
      selectedLines:[{orderLine:24,quantity:360,location:15,localOrderKey,localLineId:`line-${index}`,sourceLineKey:"1234"}],
      availableLines:[{orderLine:24,location:15,orderedQuantity:1,completedQuantity:1,remainingQuantity:0,sourceLineKey:"1234"},
        {orderLine:25,location:15,orderedQuantity:2,remainingQuantity:2,sourceLineKey:"1235"}]}))});
}

function processor() {
  return createOperatorNetSuitePostingProcessor({repository,adapter:operatorNetSuitePostingAdapter,
    workerId:"direct-http-test",finalize:async()=>{finalized++;return {verified:true};}});
}

test("actual HTTP + database: direct SO IF and PO IR each perform only create then verify",async()=>{
  for(const kind of ["SO","PO"]){
    const command=draft(kind);const begin=calls.length;
    await repo.createOrReplayOperatorNetSuitePostingCommand(command);
    const result=await processor().process(command.requestId);
    assert.equal(result.status,"completed");assert.equal(result.steps[0].attemptCount,1);
    assert.deepEqual(calls.slice(begin).map(call=>call.method),["POST","GET"]);
    assert.ok(calls.slice(begin).every(call=>!call.path.includes("eid:")&&!call.path.includes("suiteql")));
    assert.equal(records.get(String(result.steps[0].netSuiteTransactionId)).item.items[0].quantity,360);
  }
});

test("actual HTTP + database: direct TO IR uses the stored line and the transfer receipt endpoint", async () => {
  const command = draft("TO", 1, ++nextId, true);
  const begin = calls.length;
  await repo.createOrReplayOperatorNetSuitePostingCommand(command);
  const result = await processor().process(command.requestId);
  assert.equal(result.status, "completed");
  assert.deepEqual(calls.slice(begin).map(call => call.method), ["POST", "GET"]);
  assert.match(calls[begin].path, /\/transferorder\/\d+\/!transform\/itemreceipt$/u);
  assert.equal(records.get(String(result.steps[0].netSuiteTransactionId)).item.items[0].quantity, 360);
});

test("actual database: sibling split claims race for one parent and attempt freshness is durable",async()=>{
  const a=draft("PO"),b=draft("PO",1,a.steps[0].sourceNetSuiteId);
  const outcomes=await Promise.allSettled([repo.createOrReplayOperatorNetSuitePostingCommand(a),repo.createOrReplayOperatorNetSuitePostingCommand(b)]);
  assert.equal(outcomes.filter(row=>row.status==="fulfilled").length,1);
  assert.equal(outcomes.find(row=>row.status==="rejected").reason.code,"OPERATOR_NETSUITE_POSTING_ORDER_CLAIMED");
  const id=outcomes.find(row=>row.status==="fulfilled").value.command.id;
  const claimed=await repo.claimOperatorNetSuitePostingCommand({commandId:id,workerId:"fresh-test",leaseSeconds:180});
  const input={commandId:id,stepId:claimed.steps[0].id,leaseToken:claimed.leaseToken};
  assert.equal((await repo.startOperatorNetSuitePostingAttempt(input)).fresh,true);
  assert.equal((await repo.startOperatorNetSuitePostingAttempt(input)).fresh,false);
});

test("actual HTTP: a lost success response recovers by external ID without a second transform",async()=>{
  const command=draft("PO");const begin=calls.length;loseResponse=true;
  await repo.createOrReplayOperatorNetSuitePostingCommand(command);
  const result=await processor().process(command.requestId);
  assert.equal(result.status,"completed");
  assert.equal(calls.slice(begin).filter(row=>row.method==="POST").length,1);
  assert.ok(calls.slice(begin).some(row=>row.path.includes("/eid:")));
});

test("five-source consolidation confirms within 15 seconds with four-second NetSuite transforms",async()=>{
  const command=draft("TO",5);delay=4000;peak=0;
  const started=performance.now();
  try {
    await repo.createOrReplayOperatorNetSuitePostingCommand(command);
    const result=await processor().process(command.requestId);
    assert.equal(result.status,"completed");assert.equal(result.steps.length,5);
    assert.equal(peak,3);
    const elapsed=performance.now()-started;
    assert.ok(elapsed<15000,`Confirmed batch took ${elapsed}ms`);
    assert.ok(elapsed-8000<2000,`Local and verification overhead exceeded 2 seconds: ${elapsed}ms`);
    console.log(JSON.stringify({benchmark:"five-source-confirmed",elapsedMs:Math.round(elapsed),remoteTransformMs:4000,peak}));
  } finally {delay=0;}
});

test("partial remote batch failure records successful steps but never finalizes locally",async()=>{
  const command=draft("TO",5);const beforeFinalized=finalized;failSource=command.steps[1].sourceNetSuiteId;
  try {
    await repo.createOrReplayOperatorNetSuitePostingCommand(command);
    const result=await processor().process(command.requestId);
    assert.equal(result.status,"attention");assert.equal(finalized,beforeFinalized);
    assert.ok(result.steps.some(step=>step.status==="posted"));
    assert.ok(result.steps.some(step=>step.status==="failed"));
    assert.ok(result.activeClaims.length>0);
  } finally {failSource=0;}
});
