import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {createPasswordResetMailer} from '../../../src/password-reset-mail.js';
import {staffReturnPath} from '../../../public/staff-login-routes.js';

test('System mail uses configured Gmail TLS and preserves the six digits',async()=>{
 let options,message;const mail=createPasswordResetMailer({env:{BOSS_SMTP_HOST:'smtp.gmail.com',BOSS_SMTP_USER:'warehouse@example.test',BOSS_SMTP_PASSWORD:'test-only'},
  loadTransport:async opts=>{options=opts;return {sendMail:async input=>{message=input;return {accepted:['staff@example.test']};}};}});
 assert.equal(mail.readiness().configured,true);await mail.send({to:'staff@example.test',code:'042817'});
 assert.equal(message.from.name,'MBBS System');assert.equal(message.from.address,'warehouse@mrbininc.com');
 assert.match(message.text,/042817/);assert.match(message.text,/60 seconds/);assert.equal(message.to,'staff@example.test');
 assert.equal(options.requireTLS,true);assert.equal(options.port,587);assert.equal(options.disableFileAccess,true);assert.equal(options.disableUrlAccess,true);
 await assert.rejects(()=>mail.send({to:'staff@example.test',code:'abc123'}));
});
test('return path allowlist rejects external URLs, login loops and unauthorized staff destinations',()=>{
 assert.equal(staffReturnPath('/field-sales/?view=day#route',['field_sales']),'/field-sales/?view=day#route');
 assert.equal(staffReturnPath('/dispatch/schedule?q=abc',['dispatcher']),'/dispatch/schedule?q=abc');
 for(const path of ['//evil.test','/\\evil.test','https://evil.test','javascript:alert(1)','/login.html','/driver','/api/auth/logout','/admin/accounts']){
  assert.equal(staffReturnPath(path,['field_sales']),'');
 }
 fc.assert(fc.property(fc.string(),value=>{
  const result=staffReturnPath(value,['admin']);
  if(result){assert.equal(new URL(result,'https://example.test').origin,'https://example.test');assert(!result.includes('\\'));}
 }),{numRuns:500,seed:20261003});
});
