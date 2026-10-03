import test from 'node:test';
import assert from 'node:assert/strict';
import {createBossMailer} from '../../../src/boss-approval-mail.js';

const env={BOSS_SMTP_HOST:'smtp.gmail.com',BOSS_SMTP_USER:'warehouse@mrbininc.com',BOSS_SMTP_PASSWORD:'test-only-placeholder',APP_BASE_URL:'https://example.test'};
test('System sender uses the real company Gmail address and TLS; no secrets in readiness',async()=>{
 let options,mail;
 const mailer=createBossMailer({env,loadTransport:async opts=>{options=opts;return {sendMail:async input=>{mail=input;return {accepted:[input.to]};}};}});
 await mailer.send({id:4,email:'tony@example.test'},{kind:'approved',actor_name:'Jason Pu',request_id:2,snapshot:{tranid:'SO123',customerName:'Acme',currency:'CAD',creditLimit:'100',balance:'120'}});
 assert.deepEqual(mail.from,{name:'MBBS System',address:'warehouse@mrbininc.com'});
 assert.equal(options.requireTLS,true);assert.equal(options.port,587);assert.equal(mail.to,'tony@example.test');
 assert.match(mail.text,/Jason Pu/);assert.match(mail.text,/https:\/\/example.test\/boss\?request=2/);
 assert(!JSON.stringify(mailer.readiness()).includes(env.BOSS_SMTP_PASSWORD));
});
test('missing SMTP credentials do not cause an attempted send',async()=>{
 let calls=0;const mailer=createBossMailer({env:{},loadTransport:async()=>{calls++;}});
 assert.equal(mailer.readiness().configured,false);await assert.rejects(()=>mailer.send({},{}));assert.equal(calls,0);
});
test('mail rejects header injection before reaching the transport',async()=>{
 let calls=0;const mailer=createBossMailer({env,loadTransport:async()=>({sendMail:async()=>{calls++;}})});
 await assert.rejects(()=>mailer.send({email:'a@example.test\r\nBcc: secret@example.test'},{}));assert.equal(calls,0);
});
test('real Nodemailer builds the System From header and a stable message ID without sending mail',async()=>{
 let library;
 try{library=await import('nodemailer');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND'){throw error;}library=await import('/workspace/node_modules/nodemailer/dist/esm/nodemailer.js');}
 let mime;
 const mailer=createBossMailer({env,loadTransport:async()=>{
  const transport=library.default.createTransport({streamTransport:true,buffer:true});
  return {sendMail:async input=>{const result=await transport.sendMail(input);mime=result.message.toString();return {...result,accepted:[input.to]};}};
 }});
 await mailer.send({id:9,email:'boss@example.test'},{kind:'rejected',actor_name:'Tony Tan',request_id:7,snapshot:{tranid:'SO777',customerName:'Acme',balance:'120',creditLimit:'100',currency:'CAD'}});
 assert.match(mime,/From: MBBS System <warehouse@mrbininc.com>/);assert.match(mime,/Message-ID: <boss-9@mrbininc.com>/);assert.match(mime,/To: boss@example.test/);
});
