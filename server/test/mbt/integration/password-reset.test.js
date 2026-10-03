import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fc from 'fast-check';
import {createPasswordResetService,numericResetCode} from '../../../src/password-reset-service.js';
import {createOperator,loginOperator,getOperatorByToken,updateOperatorPassword} from '../../../src/auth-repository.js';
import {query,closeDb} from '../../../src/db.js';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
after(closeDb);
async function fixture(patch={}) {
 const operator=await createOperator({username:`reset-${crypto.randomUUID()}`,password:'original-password',email:'staff@example.test',role:'field_sales'});
 let time=Date.now(),code='042817';const mail=[];
 const service=createPasswordResetService({now:()=>time,generateCode:()=>code,
  mailer:{readiness:()=>({configured:true}),send:async message=>mail.push(message)},logger:{error:()=>{}},...patch});
 const identity={username:operator.username,email:operator.email},context={ip:crypto.randomUUID()};
 return {operator,service,mail,identity,context,advance:ms=>{time+=ms;},setCode:value=>{code=value;},request:()=>service.request(identity,context)};
}
const invalid=fn=>assert.rejects(fn,e=>e.status===400);
test('numeric codes preserve zeroes and property: always six ASCII digits',()=>{
 assert.equal(numericResetCode(()=>42817),'042817');assert.equal(numericResetCode(()=>0),'000000');
 fc.assert(fc.property(fc.integer({min:0,max:999999}),n=>assert.match(numericResetCode(()=>n),/^[0-9]{6}$/)),{numRuns:500,seed:20261003});
});
test('email code grants one password reset and revokes existing staff sessions atomically',async()=>{
 const h=await fixture();const login=await loginOperator(h.operator.username,'original-password');
 const request=await h.request();assert.equal(request.expiresIn,60);assert.equal(request.retryAfter,20);
 assert.equal(h.mail.length,1);assert.equal(h.mail[0].code,'042817');assert.equal(h.mail[0].to,'staff@example.test');
 assert(!JSON.stringify(request).includes('042817'));
 const row=(await query('SELECT * FROM operator_password_resets WHERE challenge_id=$1',[request.challengeId])).rows[0];
 assert(!JSON.stringify(row).includes('042817'));assert(row.code_hash);assert(row.code_salt);
 const verified=await h.service.verify({challengeId:request.challengeId,passcode:'042817'},h.context);
 await invalid(()=>h.service.verify({challengeId:request.challengeId,passcode:'042817'},h.context));
 const result=await h.service.complete({resetToken:verified.resetToken,password:'new-password'},h.context);assert.equal(result.ok,true);
 assert.equal(await getOperatorByToken(login.token),null);
 await assert.rejects(()=>loginOperator(h.operator.username,'original-password'));
 assert.equal((await loginOperator(h.operator.username,'new-password')).operator.role,'field_sales');
 await invalid(()=>h.service.complete({resetToken:verified.resetToken,password:'replayed-password'},h.context));
});
test('server enforces resend at exactly 20 seconds and replaces the old code',async()=>{
 const h=await fixture(),first=await h.request();h.advance(19999);const early=await h.request();
 assert.equal(early.challengeId,first.challengeId);assert.equal(early.retryAfter,1);assert.equal(h.mail.length,1);
 h.advance(1);h.setCode('000002');const second=await h.request();assert.notEqual(second.challengeId,first.challengeId);assert.equal(h.mail.length,2);
 await invalid(()=>h.service.verify({challengeId:first.challengeId,passcode:'042817'},h.context));
 await invalid(()=>h.service.verify({challengeId:second.challengeId,passcode:'042817'},h.context));
 assert((await h.service.verify({challengeId:second.challengeId,passcode:'000002'},h.context)).resetToken);
});
test('code expires at exactly 60 seconds; a timely verified grant lasts five minutes',async()=>{
 const good=await fixture(),a=await good.request();good.advance(59999);
 const proof=await good.service.verify({challengeId:a.challengeId,passcode:'042817'},good.context);good.advance(300000);
 await invalid(()=>good.service.complete({resetToken:proof.resetToken,password:'new-password'},good.context));
 const expired=await fixture(),b=await expired.request();expired.advance(60000);
 await invalid(()=>expired.service.verify({challengeId:b.challengeId,passcode:'042817'},expired.context));
});
test('five incorrect guesses exhaust a code; malformed numeric inputs never verify',async()=>{
 const h=await fixture(),r=await h.request();
 for(let i=0;i<5;i++){await invalid(()=>h.service.verify({challengeId:r.challengeId,passcode:'111111'},h.context));}
 await invalid(()=>h.service.verify({challengeId:r.challengeId,passcode:'042817'},h.context));
 const h2=await fixture(),r2=await h2.request();
 for(const passcode of [42817,'42817','0428170',' 042817','042817\n','０４２８１７','abc123',{},null]){
  await invalid(()=>h2.service.verify({challengeId:r2.challengeId,passcode},h2.context));
 }
 assert((await h2.service.verify({challengeId:r2.challengeId,passcode:'042817'},h2.context)).resetToken);
});
test('unknown, mismatched, inactive and email-less accounts receive the same shape without mail',async()=>{
 const h=await fixture();const valid=await h.request();
 for(const identity of [{...h.identity,username:'missing-'+crypto.randomUUID()},{...h.identity,email:'attacker@example.test'}]){
  const result=await h.service.request(identity,h.context);assert.deepEqual(Object.keys(result).sort(),Object.keys(valid).sort());assert.equal(result.expiresIn,60);assert.equal(result.retryAfter,20);
  await invalid(()=>h.service.verify({challengeId:result.challengeId,passcode:'042817'},h.context));
 }
 await query('UPDATE operators SET active=false WHERE id=$1',[h.operator.id]);h.advance(20000);await h.request();assert.equal(h.mail.length,1);
 await query("UPDATE operators SET active=true,email='' WHERE id=$1",[h.operator.id]);h.advance(20000);await h.request();assert.equal(h.mail.length,1);
});
test('concurrent resend sends once; concurrent verification and completion succeed once',async()=>{
 const h=await fixture();const requests=await Promise.all(Array.from({length:6},()=>h.request()));
 assert.equal(new Set(requests.map(r=>r.challengeId)).size,1);assert.equal(h.mail.length,1);
 const results=await Promise.allSettled(Array.from({length:6},()=>h.service.verify({challengeId:requests[0].challengeId,passcode:'042817'},h.context)));
 const proofs=results.filter(r=>r.status==='fulfilled');assert.equal(proofs.length,1);
 const reset=await Promise.allSettled(Array.from({length:6},()=>h.service.complete({resetToken:proofs[0].value.resetToken,password:'new-password'},h.context)));
 assert.equal(reset.filter(r=>r.status==='fulfilled').length,1);
});
test('resend, account email changes and administrator password changes invalidate old grants',async()=>{
 for(const action of ['resend','email','password','deactivate']){
  const h=await fixture(),r=await h.request(),proof=await h.service.verify({challengeId:r.challengeId,passcode:'042817'},h.context);
  if(action==='resend'){h.advance(20000);await h.request();}
  if(action==='email'){await query("UPDATE operators SET email='changed@example.test' WHERE id=$1",[h.operator.id]);}
  if(action==='password'){await updateOperatorPassword(h.operator.id,'admin-password');}
  if(action==='deactivate'){await query('UPDATE operators SET active=false WHERE id=$1',[h.operator.id]);}
  await invalid(()=>h.service.complete({resetToken:proof.resetToken,password:'new-password'},h.context));
 }
});
test('mail failure leaves code unusable; expiry starts after SMTP acceptance',async()=>{
 const bad=await fixture({mailer:{readiness:()=>({configured:true}),send:async()=>{throw new Error('private smtp details');}}});
 const r=await bad.request();await invalid(()=>bad.service.verify({challengeId:r.challengeId,passcode:'042817'},bad.context));
 const h=await fixture({mailer:{readiness:()=>({configured:true}),send:async()=>{h.advance(30000);}}});
 const sent=await h.request();h.advance(59999);assert((await h.service.verify({challengeId:sent.challengeId,passcode:'042817'},h.context)).resetToken);
});
test('identity/IP limits persist across service instances and invalid passwords preserve the grant',async()=>{
 const h=await fixture();for(let i=0;i<6;i++){await h.request();h.advance(20000);}
 await assert.rejects(()=>h.request(),e=>e.status===429);
 const h2=await fixture(),r=await h2.request(),p=await h2.service.verify({challengeId:r.challengeId,passcode:'042817'},h2.context);
 for(const password of ['12345','x'.repeat(257),{},null]){await invalid(()=>h2.service.complete({resetToken:p.resetToken,password},h2.context));}
 assert.equal((await h2.service.complete({resetToken:p.resetToken,password:'allowed-password'},h2.context)).ok,true);
});
