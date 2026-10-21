import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createOllamaMatcher,compatibleVariant} from '../src/stock-check/ollama-matching.js';
assert.equal(process.env.MBT_TEST_ISOLATED,'1');
if(process.argv.includes('--inspect')) {
  const model=await (await fetch(process.env.OLLAMA_BASE_URL+'/api/show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OLLAMA_MODEL})})).json();
  console.log(JSON.stringify({capabilities:model.capabilities,thinking:model.thinking,parameters:model.parameters,details:model.details,template:model.template}));
  console.log(JSON.stringify(await (await fetch(process.env.OLLAMA_BASE_URL+'/api/ps')).json()));
  process.exit(0);
}
const dir='test-artifacts/stock-check-ollama',input=JSON.parse(await fs.readFile(dir+'/history-input.json','utf8'));
const {expected}=JSON.parse(await fs.readFile('test/support/stock-check-ollama-history-expected.json','utf8'));
const selected=process.argv.slice(2).filter(value=>!value.startsWith('--')).map(Number),lines=input.lines.filter(line=>selected.length?selected.includes(line.lineId):line.kind==='special');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const sourceSha256=hash(await fs.readFile('src/stock-check/ollama-matching.js'));
const groups=[...new Set(lines.map(line=>line.requestId))].map(id=>lines.filter(line=>line.requestId===id).sort((a,b)=>a.lineId-b.lineId));
const records=[],results=[];
const matcher=createOllamaMatcher({settings:()=>({baseUrl:process.env.OLLAMA_BASE_URL,model:process.env.OLLAMA_MODEL}),timeoutMs:process.argv.includes('--slow')?180000:90000,fetchImpl:async(url,options)=>{
  console.log(JSON.stringify({inferenceStarted:new Date().toISOString(),promptBytes:options.body.length}));
  const started=Date.now(),response=await fetch(url,options),body=await response.json();
  records.push({prompt:JSON.parse(options.body),response:body,elapsedMs:Date.now()-started});
  await fs.writeFile(dir+'/history-model-records.json',JSON.stringify(records,null,2));
  return {ok:response.ok,json:async()=>body};
}});
for(const batch of groups) {
  const started=Date.now(),matched=await matcher.match(batch,input.products);
  results.push(...matched.map(result=>({...result,product:result.product?{id:result.product.id,sku:result.product.sku,name:result.product.name,colour:result.product.colour,size:result.product.size}:null})));
  for(const result of matched) {
    const line=batch.find(row=>row.lineId===result.lineId);
    if(result.product) {assert.equal(compatibleVariant(line,result.product),true);}
    console.log(JSON.stringify({lineId:line.lineId,description:[line.productName,line.color,line.size].join(' | '),sku:result.product?.sku??null,...result.aiMatch,elapsedMs:Date.now()-started}));
  }
  await fs.writeFile(dir+'/history-results.json',JSON.stringify({at:new Date().toISOString(),readOnly:true,model:process.env.OLLAMA_MODEL,lines:results},null,2));
}
const assessed=results.map(row=>({lineId:row.lineId,expected:expected[row.lineId],actual:row.product?.sku??null,status:row.aiMatch.status,
  correct:(row.product?.sku??null)===expected[row.lineId],incorrectAuto:Boolean(row.product && row.product.sku!==expected[row.lineId])}));
assert.equal(hash(await fs.readFile('src/stock-check/ollama-matching.js')),sourceSha256,'Matching source changed during evaluation.');
const report={at:new Date().toISOString(),readOnly:true,sourceSha256,inputSha256:hash(await fs.readFile(dir+'/history-input.json')),grouping:'Historical request, ascending line ID',requests:groups.length,total:assessed.length,autoMatched:results.filter(row=>row.product).length,
  correct:assessed.filter(row=>row.correct).length,incorrectAuto:assessed.filter(row=>row.incorrectAuto).length,assessed};
await fs.writeFile(dir+'/history-assessment.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
assert.equal(report.incorrectAuto,0,'A historical line was automatically matched to the wrong variant.');
