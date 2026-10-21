import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {stockCheckMaterial} from '../src/stock-check/line-description.js';
import {createOllamaMatcher} from '../src/stock-check/ollama-matching.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const dir='test-artifacts/stock-check-description',input=JSON.parse(await fs.readFile(dir+'/history-input.json','utf8')),
  expected={222:'0237M01818807-1',208:'0262M01618807-1'},records=[],assessed=[];
const sourceHash=crypto.createHash('sha256').update(await fs.readFile('src/stock-check/line-description.js')).digest('hex');
const matchingHash=crypto.createHash('sha256').update(await fs.readFile('src/stock-check/line-matching.js')).digest('hex');
const matcher=createOllamaMatcher({settings:()=>({baseUrl:process.env.OLLAMA_BASE_URL,model:process.env.OLLAMA_MODEL}),fetchImpl:async(url,options)=>{
  const started=Date.now(),response=await fetch(url,options),body=await response.json(),prompt=JSON.parse(options.body);
  for(const line of input.lines) {assert.equal(prompt.prompt.includes(line.itemCode),false,'NetSuite internal codes must not reach the model.');}
  records.push({prompt,response:body,elapsedMs:Date.now()-started});await fs.writeFile(dir+'/history-model-records.json',JSON.stringify(records,null,2));
  return {ok:response.ok,json:async()=>body};
}});
for(const raw of input.lines) {
  const material=stockCheckMaterial({workflow_kind:raw.kind,product_name:raw.productName,detail_spec:raw.detailSpec,regular_item_code:raw.itemCode});
  assert.equal(material.productName,raw.detailSpec);assert.equal(material.itemCode,null);
  const started=Date.now(),[result]=await matcher.match([{...raw,...material}],input.products);
  const row={lineId:raw.lineId,description:material.productName,referenceItemCode:material.referenceItemCode,expected:expected[raw.lineId],actual:result.product?.sku??null,
    aiMatch:result.aiMatch,elapsedMs:Date.now()-started};
  assessed.push(row);await fs.writeFile(dir+'/history-results.json',JSON.stringify(assessed,null,2));console.log(JSON.stringify(row));
}
const report={at:new Date().toISOString(),readOnly:true,model:process.env.OLLAMA_MODEL,descriptionSourceSha256:sourceHash,matchingSourceSha256:matchingHash,total:assessed.length,
  autoMatched:assessed.filter(row=>row.actual).length,incorrectAuto:assessed.filter(row=>row.actual && row.actual!==row.expected).length,
  userExampleMatched:assessed.some(row=>row.lineId===222&&row.actual===expected[222]),assessed};
await fs.writeFile(dir+'/history-assessment.json',JSON.stringify(report,null,2));
assert.equal(report.incorrectAuto,0);assert.equal(report.userExampleMatched,true);assert.equal(report.autoMatched,report.total);
console.log(JSON.stringify({passed:true,matched:report.autoMatched,total:report.total,model:report.model}));
