import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {stockCheckMaterial} from '../src/stock-check/line-description.js';
import {createOllamaMatcher} from '../src/stock-check/ollama-matching.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const dir='test-artifacts/stock-check-batch',input=JSON.parse(await fs.readFile('test-artifacts/stock-check-description/history-input.json','utf8')),
  original=JSON.parse(await fs.readFile('test-artifacts/stock-check-ollama/history-input.json','utf8')),
  expected={...JSON.parse(await fs.readFile('test/support/stock-check-ollama-history-expected.json','utf8')).expected,207:'0237M01818807-1',222:'0237M01818807-1',208:'0262M01618807-1'},
  sourceSha256=crypto.createHash('sha256').update(await fs.readFile('src/stock-check/ollama-matching.js')).digest('hex'),records=[],assessed=[];
const requestOnly=process.argv.includes('--request'),artifact=name=>dir+'/'+(requestOnly?'request-':'')+name;
const regular=requestOnly?JSON.parse(await fs.readFile(dir+'/live-request-input.json','utf8')).lines:
  input.lines.map(raw=>({...raw,...stockCheckMaterial({workflow_kind:raw.kind,product_name:raw.productName,detail_spec:raw.detailSpec,regular_item_code:raw.itemCode})}));
const special=requestOnly?[]:original.lines.filter(line=>line.kind==='special'),groups=[regular,...[...new Set(special.map(line=>line.requestId))].map(id=>special.filter(line=>line.requestId===id).sort((a,b)=>a.lineId-b.lineId))];
const matcher=createOllamaMatcher({settings:()=>({baseUrl:process.env.OLLAMA_BASE_URL,model:process.env.OLLAMA_MODEL}),fetchImpl:async(url,options)=>{
  const prompt=JSON.parse(options.body),data=JSON.parse(prompt.prompt.split('/no_think\n')[1]);
  console.log(JSON.stringify({inferenceStarted:new Date().toISOString(),lines:data.lines.map(row=>({id:row.line.lineId,candidates:row.candidates.length}))}));
  const started=Date.now(),response=await fetch(url,options),body=await response.json();
  records.push({prompt,response:body,elapsedMs:Date.now()-started});await fs.writeFile(artifact('history-model-records.json'),JSON.stringify(records,null,2));
  return {ok:response.ok,json:async()=>body};
}});
let combinedBatch;
for(let index=0;index<groups.length;index++) {
  const batch=groups[index],started=Date.now(),matched=await matcher.match(batch,input.products),elapsedMs=Date.now()-started;
  for(const row of matched) {
    const raw=batch.find(line=>line.lineId===row.lineId),actual=row.product?.sku??null;
    const result={lineId:row.lineId,description:[raw.productName,raw.color,raw.size].filter(Boolean).join(' | '),expected:expected[row.lineId],actual,
      status:row.aiMatch.status,reason:row.aiMatch.reason,elapsedMs,incorrectAuto:Boolean(actual&&actual!==expected[row.lineId])};
    assessed.push(result);console.log(JSON.stringify(result));
  }
  if(index===0) {
    const startedAgain=Date.now(),cached=await matcher.match(batch,input.products),cachedElapsedMs=Date.now()-startedAgain;
    combinedBatch={lines:batch.length,elapsedMs,cachedElapsedMs,modelCalls:records.length,matched:matched.filter(row=>row.product).length};
    assert.deepEqual(cached,matched);assert.equal(records.length,1);assert.ok(elapsedMs<90000);assert.equal(combinedBatch.matched,2);
    assert.deepEqual(matched.map(row=>row.product?.sku),batch.map(row=>expected[row.lineId]));
    const body=JSON.parse(records[0].prompt.prompt.split('/no_think\n')[1]);
    assert.deepEqual(body.lines.map(row=>row.candidates.length),[1,1]);
    for(const raw of regular) {assert.equal(records[0].prompt.prompt.includes(raw.referenceItemCode),false);}
    console.log(JSON.stringify({combinedBatch}));
  }
  await fs.writeFile(artifact('history-results.json'),JSON.stringify(assessed,null,2));
}
const report={at:new Date().toISOString(),readOnly:true,model:process.env.OLLAMA_MODEL,sourceSha256,total:assessed.length,requests:groups.length,
  autoMatched:assessed.filter(row=>row.actual).length,incorrectAuto:assessed.filter(row=>row.incorrectAuto).length,
  combinedBatchPassed:combinedBatch?.matched===2&&combinedBatch.elapsedMs<90000,combinedBatch,assessed};
await fs.writeFile(artifact('history-assessment.json'),JSON.stringify(report,null,2));
assert.equal(report.incorrectAuto,0);assert.equal(report.combinedBatchPassed,true);
console.log(JSON.stringify({passed:true,total:report.total,matched:report.autoMatched,combinedBatch}));
