import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import sharp from 'sharp';
import {app} from '../../src/server.js';
import {createOperator,operatorHomeRoute} from '../../src/auth-repository.js';
import {query,closeDb} from '../../src/db.js';
import {config} from '../../src/config.js';
import {staffReturnPath} from '../../public/staff-login-routes.js';
import {fields} from './fixtures.js';
import {createPublicRateLimiter} from '../../src/mbr/router.js';
let server,base,signatureDataUrl;
assert.equal(process.env.MBT_TEST_ISOLATED,'1','Run database tests through mbr-contract-gauntlet.py');
const sessions={};
before(async()=>{
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  for(const [key,role,roles] of [['admin','admin',['admin']],['sales','sales',['sales']],['mbr','mbr_sales',['mbr_sales']],
    ['otherMbr','mbr_sales',['mbr_sales']],['mixed','sales',['sales','mbr_sales']],['operator','operator',['operator']]]) {
    const username='mbr-http-'+randomUUID();
    // Existing Sales delivery access requires an outbound yard assignment.
    const actor=await createOperator({username,displayName:key,password:'mbr-test-password',role,roles,
      yardLocationIds:role==='sales'?[1]:[]});
    const result=await request('/api/auth/login',{method:'POST',body:{username,password:'mbr-test-password'}});
    assert.equal(result.status,200);sessions[key]={actor,token:result.body.token};
  }
  signatureDataUrl='data:image/png;base64,'+(await sharp(Buffer.from('<svg width="900" height="320"><rect width="900" height="320" fill="white"/><path d="M20 180 Q90 40 140 190 L270 120 L250 200 L380 160" stroke="black" stroke-width="5" fill="none"/></svg>')).png().toBuffer()).toString('base64');
});
after(async()=>{server?.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closeDb();});
async function request(path,{actor,method='GET',body,token,headers={}}={}) {
  const response=await fetch(base+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),
    ...(actor?{authorization:'Bearer '+sessions[actor].token}:{}),...(token?{'x-mbr-contract-token':token}:{}),...headers},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json().catch(()=>({})),headers:response.headers};
}
async function issued() {
  const result=await request('/api/mbr/contracts',{actor:'mbr',method:'POST',body:fields()});assert.equal(result.status,201);
  const link=await request(`/api/mbr/contracts/${result.body.id}/link`,{actor:'mbr',method:'POST',body:{revision:result.body.revision}});
  assert.equal(link.status,200);return {contract:result.body,token:new URL(link.body.url).hash.slice(1)};
}
const signing=(overrides={})=>({revision:1,protectionPlanAccepted:false,consent:true,signerName:'Alice Customer',
  signatureDataUrl,submissionId:randomUUID(),...overrides});

test('real staff login recognizes MBR Sales and preserves all existing primary homes',async()=>{
  assert.equal(operatorHomeRoute('mbr_sales'),'/mbr/contracts');
  assert.equal(operatorHomeRoute({role:'sales',roles:['sales','mbr_sales']}),'/sales');
  assert.equal(staffReturnPath('/mbr/contracts/new',['mbr_sales']),'/mbr/contracts/new');
  assert.equal(staffReturnPath('/mbr/sign#secret',['mbr_sales']),'');
  assert.equal(staffReturnPath('/sales',['mbr_sales']),'');
  const me=await request('/api/auth/me',{actor:'mbr'});
  assert.equal(me.status,200);assert.equal(me.body.operator.homeRoute,'/mbr/contracts');assert.equal(me.body.mbrContractsEnabled,true);
});

test('MBR data is role-protected and shared between MBR Sales and admins',async()=>{
  assert.equal((await request('/api/mbr/contracts')).status,401);
  assert.equal((await request('/api/mbr/contracts',{actor:'sales',headers:{'x-mbbs-role':'mbr_sales'}})).status,403);
  assert.equal((await request('/api/mbr/contracts',{actor:'operator'})).status,403);
  const {contract}=await issued();
  for(const actor of ['admin','otherMbr','mixed']) {
    assert.equal((await request(`/api/mbr/contracts/${contract.id}`,{actor})).status,200);
  }
});

test('MBR-only staff cannot read other protected modules or their event stream',async()=>{
  for(const path of ['/api/mbt/frontdesk/status','/api/field-sales/status','/api/operators','/api/sales/delivery-requests']) {
    const result=await request(path,{actor:'mbr'});assert.equal(result.status,403,path);
    assert.equal(result.body.redirect,'/mbr/contracts');
  }
  assert.equal((await request('/api/events?token='+sessions.mbr.token)).status,403);
  assert.equal((await request('/api/sales/delivery-requests',{actor:'sales'})).status,200);
  assert.equal((await request('/api/sales/delivery-requests',{actor:'mixed'})).status,200);
});

test('public link reviews exactly one contract without a staff account; headers forbid caching',async()=>{
  const {contract,token}=await issued();
  const result=await request('/api/mbr/public/contract',{token});assert.equal(result.status,200);
  assert.equal(result.body.id,contract.id);assert.equal(result.body.revision,1);
  assert.ok(result.headers.get('cache-control').includes('no-store'));assert.equal(result.headers.get('referrer-policy'),'no-referrer');
  assert.equal((await request('/api/mbr/public/contract')).status,404);
  assert.equal((await request('/api/mbr/public/contract',{token:'A'.repeat(43)})).status,404);
  assert.equal((await request('/api/mbr/contracts/'+contract.id,{token})).status,401);
});

test('public sign rejects cross-origin requests, missing choices, rate tampering, malformed and oversized input',async()=>{
  const {token}=await issued();
  const alien=await request('/api/mbr/public/sign',{token,method:'POST',body:signing(),headers:{origin:'https://evil.example'}});
  assert.equal(alien.status,403);
  for(const override of [{protectionPlanAccepted:undefined},{consent:false},{dailyRate:'0.01'},
    {signatureDataUrl:'data:image/svg+xml;base64,abc'},{signatureDataUrl:'data:image/png;base64,'+'A'.repeat(1100000)}]) {
    const result=await request('/api/mbr/public/sign',{token,method:'POST',body:signing(override)});
    assert.ok([400,413].includes(result.status),JSON.stringify(result.body));
  }
});

test('customer signs current terms and downloads the PDF without an account, including after deadline',async()=>{
  const {contract,token}=await issued();
  const payload=signing();
  const signed=await request('/api/mbr/public/sign',{token,method:'POST',body:payload,headers:{origin:base}});
  assert.equal(signed.status,200,JSON.stringify(signed.body));assert.equal(signed.body.status,'completed');
  const pdf=await fetch(base+'/api/mbr/public/pdf',{headers:{'x-mbr-contract-token':token}});
  assert.equal(pdf.status,200);assert.equal(pdf.headers.get('content-type'),'application/pdf');
  assert.match(pdf.headers.get('content-disposition'),/MBR-.*\.pdf/u);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,4).toString(),'%PDF');
  await query("UPDATE mbr_contracts SET expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[contract.id]);
  assert.equal((await request('/api/mbr/public/contract',{token})).body.status,'completed');
  const replay=await request('/api/mbr/public/sign',{token,method:'POST',body:payload});assert.equal(replay.status,200);
});

test('customer stale-version conflict, expiry and renewal are enforced through actual HTTP',async()=>{
  const {contract,token}=await issued();
  const edit=await request(`/api/mbr/contracts/${contract.id}`,{actor:'otherMbr',method:'PATCH',body:{revision:1,...fields({lessee:'Corrected Lessee'})}});
  assert.equal(edit.status,200);
  const stale=await request('/api/mbr/public/sign',{token,method:'POST',body:signing()});assert.equal(stale.status,409);assert.equal(stale.body.code,'MBR_CONTRACT_CHANGED');
  assert.equal((await request('/api/mbr/public/contract',{token})).body.fields.lessee,'Corrected Lessee');
  await query('UPDATE mbr_contracts SET expires_at=clock_timestamp() WHERE id=$1',[contract.id]);
  assert.equal((await request('/api/mbr/public/contract',{token})).status,410);
  const renewal=await request(`/api/mbr/contracts/${contract.id}/renew`,{actor:'mbr',method:'POST',body:{revision:2,...fields()}});
  assert.equal(renewal.status,200);
  assert.equal((await request('/api/mbr/public/contract',{token})).status,410);
  assert.equal((await request('/api/mbr/public/contract',{token:new URL(renewal.body.url).hash.slice(1)})).status,200);
});

test('rollout flag disables both staff and public contract operations',async()=>{
  const {token}=await issued();
  const prior=config.mbr.enabled;config.mbr.enabled=false;
  try {
    for(const options of [{actor:'mbr'},{token}]) {
      const path=options.token?'/api/mbr/public/contract':'/api/mbr/contracts';
      const result=await request(path,options);assert.equal(result.status,503);assert.equal(result.body.code,'MBR_DISABLED');
    }
  }finally {config.mbr.enabled=prior;}
});

test('both service workers explicitly bypass every MBR page',async()=>{
  for(const filename of ['service-worker.js','driver-service-worker.js']) {
    const text=await readFile(new URL('../../public/'+filename,import.meta.url),'utf8');
    assert.match(text,/if \(url\.pathname === "\/mbr" \|\| url\.pathname\.startsWith\("\/mbr\/"\)\) return/u);
  }
  const page=await fetch(base+'/mbr/sign');assert.equal(page.status,200);
  assert.ok(page.headers.get('cache-control').includes('no-store'));
});

test('public rate limiter bounds requests, expires old buckets and returns Retry-After',()=>{
  let stamp=0;
  const limiter=createPublicRateLimiter({limit:2,maximumKeys:1,periodMs:1000,now:()=>stamp});
  const invoke=ip=>{let status=200,next=false;
    const response={status(value){status=value;return this;},set(){return this;},json(){return this;}};
    limiter({ip},response,()=>{next=true;});return {status,next};};
  assert.equal(invoke('one').next,true);assert.equal(invoke('one').next,true);assert.equal(invoke('one').status,429);
  assert.equal(invoke('two').status,429);stamp=1001;assert.equal(invoke('two').next,true);
});
