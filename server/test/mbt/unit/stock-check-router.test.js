import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {createStockCheckRouter} from '../../../src/stock-check/router.js';
async function server(t) {
  const evidenceDir=await fs.mkdtemp(path.join(os.tmpdir(),'stock-check-http-'));t.after(()=>fs.rm(evidenceDir,{recursive:true,force:true}));
  const id='10101010-1010-4010-8010-101010101010';await fs.mkdir(path.join(evidenceDir,id));
  await fs.writeFile(path.join(evidenceDir,id,'proof.jpg'),Buffer.from([255,216,255,217]));
  const repo={listVendors:async()=>[{id:1,name:'Unilock'}],getJob:async()=>({id,steps:[{screenshot:'proof.jpg'}]}),saveAccount:async(_id,input)=>({id:1,label:input.label,username:input.username,configured:true})};
  const requestChecks={get:async requestId=>({requestId,lines:[]}),match:async requestId=>({requestId,matched:true}),start:async(requestId,input,actor)=>({requestId,lines:input.lines,actor})};
  const app=express();app.use('/api/scm/stock-check',createStockCheckRouter({repo,evidenceDir,requestChecks,authenticate:(req,res,next)=>{
    if(!req.headers.authorization) {return res.status(401).json({error:'Sign in.'});}
    req.operator={id:1,role:req.headers.authorization};next();
  }}));
  const http=app.listen(0,'127.0.0.1');t.after(()=>new Promise(resolve=>http.close(resolve)));
  await new Promise(resolve=>http.once('listening',resolve));
  return {base:'http://127.0.0.1:'+http.address().port+'/api/scm/stock-check',id};
}
test('stock-check API requires authentication and SCM authority before accepting a body',async t=>{
  const {base}=await server(t);assert.equal((await fetch(base+'/vendors')).status,401);
  assert.equal((await fetch(base+'/vendors',{headers:{authorization:'sales'}})).status,403);
  const response=await fetch(base+'/vendors',{headers:{authorization:'scm'}});assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
});
test('request line check routes require SCM and validate record IDs before reading or queueing',async t=>{
  const {base}=await server(t);
  for(const method of ['GET','POST']) {
    const options={method,headers:{'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify({lines:[]})}:{})};
    assert.equal((await fetch(base+'/requests/12',options)).status,401);
    assert.equal((await fetch(base+'/requests/12',{...options,headers:{...options.headers,authorization:'sales'}})).status,403);
    assert.equal((await fetch(base+'/requests/NaN',{...options,headers:{...options.headers,authorization:'scm'}})).status,400);
  }
  const get=await fetch(base+'/requests/12',{headers:{authorization:'scm'}});assert.deepEqual(await get.json(),{requestId:12,lines:[]});
  const post=await fetch(base+'/requests/12',{method:'POST',headers:{authorization:'scm','content-type':'application/json'},body:JSON.stringify({lines:[{lineId:4,productId:1}]})});
  assert.equal(post.status,202);assert.deepEqual(await post.json(),{requestId:12,lines:[{lineId:4,productId:1}],actor:'1'});
});
test('credential bodies are bounded and malformed JSON never reflects a password fragment',async t=>{
  const {base}=await server(t),secret='private-fixture-value';
  const bad=await fetch(base+'/vendors/1/accounts',{method:'POST',headers:{authorization:'scm','content-type':'application/json'},body:'{"password":"'+secret+'"'});
  assert.equal(bad.status,400);assert.equal((await bad.text()).includes(secret),false);
  const large=await fetch(base+'/vendors/1/accounts',{method:'POST',headers:{authorization:'scm','content-type':'application/json'},body:JSON.stringify({password:'x'.repeat(18000)})});assert.equal(large.status,413);
});
test('Ollama matching requires SCM, validates the request ID, ignores client descriptors and returns a private read-only result',async t=>{
  const {base}=await server(t),options={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({productName:'Untrusted browser description'})};
  assert.equal((await fetch(base+'/requests/12/match',options)).status,401);
  assert.equal((await fetch(base+'/requests/12/match',{...options,headers:{...options.headers,authorization:'sales'}})).status,403);
  assert.equal((await fetch(base+'/requests/no/match',{...options,headers:{...options.headers,authorization:'scm'}})).status,400);
  const response=await fetch(base+'/requests/12/match',{...options,headers:{...options.headers,authorization:'scm'}});
  assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);assert.deepEqual(await response.json(),{requestId:12,matched:true});
});
test('screenshot evidence requires SCM login, belongs to a recorded job step, and blocks arbitrary paths',async t=>{
  const {base,id}=await server(t);assert.equal((await fetch(base+'/jobs/'+id+'/evidence/proof.jpg')).status,401);
  const proof=await fetch(base+'/jobs/'+id+'/evidence/proof.jpg',{headers:{authorization:'scm'}});assert.equal(proof.status,200);assert.equal(proof.headers.get('content-type'),'image/jpeg');
  assert.equal((await fetch(base+'/jobs/'+id+'/evidence/unrecorded.jpg',{headers:{authorization:'scm'}})).status,404);
  assert.equal((await fetch(base+'/jobs/'+id+'/evidence/%2e%2e%2fsecret',{headers:{authorization:'scm'}})).status,400);
});
