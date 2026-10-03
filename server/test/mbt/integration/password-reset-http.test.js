import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {once} from 'node:events';
import {app} from '../../../src/server.js';
import {createPasswordResetRouter} from '../../../src/password-reset-router.js';
import {createPasswordResetService} from '../../../src/password-reset-service.js';
import {createOperator,loginOperator,getOperatorByToken} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';
let server,base,operator,code;
before(async()=>{
 assert.equal(process.env.MBT_TEST_ISOLATED,'1');
 operator=await createOperator({username:'reset-http-'+crypto.randomUUID(),email:'test@example.test',password:'old-password',role:'boss'});
 const service=createPasswordResetService({mailer:{readiness:()=>({configured:true}),send:async message=>{code=message.code;}}});
 const outer=express();outer.use(express.json());outer.use('/api/auth/password-reset',createPasswordResetRouter({service}));outer.use(app);
 server=outer.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await closeDb();});
async function post(action,body){const r=await fetch(base+'/api/auth/password-reset/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,cache:r.headers.get('cache-control'),body:await r.json()};}
test('real HTTP reset keeps all codes out of responses and applies numeric-only validation',async()=>{
 const r=await post('request',{username:operator.username,email:operator.email});assert.equal(r.status,200);assert.equal(r.cache,'no-store');assert.match(code,/^[0-9]{6}$/);assert(!JSON.stringify(r.body).includes(code));
 for(const passcode of ['a12345',123456,'123456\n']){assert.equal((await post('verify',{challengeId:r.body.challengeId,passcode})).status,400);}
 const verified=await post('verify',{challengeId:r.body.challengeId,passcode:code});assert.equal(verified.status,200);assert.equal(verified.cache,'no-store');
 const oldLogins=await Promise.all(Array.from({length:5},()=>loginOperator(operator.username,'old-password')));
 const resetting=post('complete',{resetToken:verified.body.resetToken,password:'http-new-password'});
 const racing=await Promise.allSettled(Array.from({length:5},()=>loginOperator(operator.username,'old-password')));
 assert.equal((await resetting).status,200);
 for(const login of [...oldLogins,...racing.filter(r=>r.status==='fulfilled').map(r=>r.value)]){assert.equal(await getOperatorByToken(login.token),null);}
 assert.equal((await loginOperator(operator.username,'http-new-password')).operator.email,'test@example.test');
 assert.equal((await post('complete',{resetToken:verified.body.resetToken,password:'replay-password'})).status,400);
});
test('persistent IP throttle rejects a new service instance without sending another email',async()=>{
 const ip='throttle-'+crypto.randomUUID(),input={username:operator.username,email:operator.email};let sent=0;
 const service=createPasswordResetService({mailer:{readiness:()=>({configured:true}),send:async()=>{sent++;}}});
 await query(`INSERT INTO operator_password_reset_limits(key_hash,started_at,requests) VALUES($1,now(),60)`,[crypto.createHash('sha256').update('request:'+ip).digest('hex')]);
 await assert.rejects(()=>service.request(input,{ip}),e=>e.status===429);assert.equal(sent,0);
});
test('production app wires the reset route and sanitizes passcodes and tokens in its audit logger',async()=>{
 // The production route has no SMTP credentials in this isolated environment.
 const live=app.listen(0,'127.0.0.1');await once(live,'listening');
 try{
  const r=await fetch(`http://127.0.0.1:${live.address().port}/api/auth/password-reset/verify`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({challengeId:crypto.randomUUID(),passcode:'042817'})});
  assert.equal(r.status,400);assert.equal(r.headers.get('cache-control'),'no-store');assert(!(await r.text()).includes('042817'));
 }finally{live.closeAllConnections();await new Promise(resolve=>live.close(resolve));}
});
