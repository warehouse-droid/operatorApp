import crypto from 'node:crypto';
import {promisify} from 'node:util';
import {query,withTransaction} from './db.js';
import {updateOperatorPassword} from './auth-repository.js';

const scrypt=promisify(crypto.scrypt);
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const invalid=()=>Object.assign(new Error('This code or reset session is invalid or expired. Request a new code.'),{status:400});
const limited=()=>Object.assign(new Error('Too many attempts. Please try again in 10 minutes.'),{status:429});
const timestamp=value=>new Date(value).getTime();
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

export function numericResetCode(randomInt=crypto.randomInt) {
  return String(randomInt(0,1000000)).padStart(6,'0');
}

async function consumeLimit(key,maximum,time) {
  const row=await query(`INSERT INTO operator_password_reset_limits(key_hash,started_at,requests) VALUES($1,$2,1)
    ON CONFLICT(key_hash) DO UPDATE SET
      started_at=CASE WHEN operator_password_reset_limits.started_at <= $2::timestamptz-interval '10 minutes' THEN $2 ELSE operator_password_reset_limits.started_at END,
      requests=CASE WHEN operator_password_reset_limits.started_at <= $2::timestamptz-interval '10 minutes' THEN 1 ELSE operator_password_reset_limits.requests+1 END
    RETURNING requests`,[digest(key),new Date(time)]);
  return row.rows[0].requests<=maximum;
}

function identity(input) {
  if(typeof input?.username!=='string'||typeof input?.email!=='string'){throw invalid();}
  const username=input.username.trim().toLowerCase(),email=input.email.trim().toLowerCase();
  if(!username||username.length>200||email.length>254||!/^\S+@\S+\.\S+$/.test(email)){throw invalid();}
  return {username,email,key:digest(JSON.stringify([username,email]))};
}

function response(row,time) {
  return {challengeId:row.challenge_id,expiresIn:Math.max(0,Math.ceil((timestamp(row.code_expires_at||new Date(time+60000))-time)/1000)),
    retryAfter:Math.max(0,Math.ceil((timestamp(row.resend_at)-time)/1000))};
}

async function currentAccount(row,lock=false) {
  if(!row?.operator_id){return null;}
  const result=await query(`SELECT id,active,email,password_hash FROM operators WHERE id=$1${lock?' FOR UPDATE':''}`,[row.operator_id]);
  const account=result.rows[0];
  return account?.active&&String(account.email||'').trim().toLowerCase()===row.email&&account.password_hash===row.password_version?account:null;
}

/** @param {{mailer?:{readiness:()=>{configured:boolean},send:(input:{to:string,code:string})=>Promise<unknown>},now?:()=>number,generateCode?:()=>string,logger?:{error:(message:string)=>void}}} options */
export function createPasswordResetService({mailer,now=Date.now,generateCode=numericResetCode,logger=console}={}) {
  async function limitIp(context,scope,maximum) {
    if(!await consumeLimit(`${scope}:${context?.ip||'unknown'}`,maximum,now())){throw limited();}
  }
  async function reserve(input) {
    const person=identity(input),time=now();
    // Cleanup also covers anonymous identities; no ever-growing in-memory maps.
    await query("DELETE FROM operator_password_resets WHERE requested_at<$1::timestamptz-interval '1 day'",[new Date(time)]);
    await query("DELETE FROM operator_password_reset_limits WHERE started_at<$1::timestamptz-interval '1 day'",[new Date(time)]);
    return withTransaction(async()=>{
      await query(`INSERT INTO operator_password_resets(identity_hash,challenge_id,requested_at,resend_at)
        VALUES($1,$2,$3,$3) ON CONFLICT(identity_hash) DO NOTHING`,[person.key,crypto.randomUUID(),new Date(time)]);
      const existing=(await query('SELECT * FROM operator_password_resets WHERE identity_hash=$1 FOR UPDATE',[person.key])).rows[0];
      const lockedTime=now();
      if(timestamp(existing.resend_at)>lockedTime){return {row:existing};}
      if(!await consumeLimit('identity:'+person.key,6,lockedTime)){return {rateLimited:true};}
      const account=(await query('SELECT id,email,password_hash,active FROM operators WHERE username=$1',[person.username])).rows[0];
      const eligible=account?.active&&String(account.email||'').trim().toLowerCase()===person.email;
      const code=generateCode();
      if(typeof code!=='string'||code.length!==6||!/^[0-9]{6}$/.test(code)){throw new Error('Invalid code generator.');}
      const salt=crypto.randomBytes(16).toString('hex'),hash=(await scrypt(code,salt,64)).toString('hex');
      const updated=await query(`UPDATE operator_password_resets SET operator_id=$2,email=$3,password_version=$4,
        challenge_id=$5,code_hash=$6,code_salt=$7,code_expires_at=NULL,requested_at=$8,resend_at=$9,attempts=0,
        proof_hash=NULL,proof_expires_at=NULL WHERE identity_hash=$1 RETURNING *`,
      [person.key,eligible?account.id:null,person.email,eligible?account.password_hash:null,crypto.randomUUID(),hash,salt,new Date(lockedTime),new Date(lockedTime+20000)]);
      return {row:updated.rows[0],code,send:Boolean(eligible)};
    });
  }
  async function request(input,context={}) {
    await limitIp(context,'request',60);
    if(!mailer?.readiness().configured){throw Object.assign(new Error('Password reset email is temporarily unavailable. Please contact your administrator.'),{status:503});}
    const reserved=await reserve(input);
    if(reserved.rateLimited){throw limited();}
    let row=reserved.row;
    if(reserved.send){
      try {
        await mailer.send({to:row.email,code:reserved.code});
        const delivered=await query(`UPDATE operator_password_resets SET code_expires_at=$2
          WHERE challenge_id=$1 AND code_hash IS NOT NULL RETURNING *`,[row.challenge_id,new Date(now()+60000)]);
        row=delivered.rows[0]||row;
      } catch {
        // Never log SMTP credentials, recipient, code or request body.
        logger.error('Password reset email delivery failed.');
        await query('UPDATE operator_password_resets SET code_hash=NULL,code_expires_at=NULL WHERE challenge_id=$1',[row.challenge_id]);
      }
    }
    return response(row,now());
  }
  async function verify(input,context={}) {
    await limitIp(context,'verify',100);
    if(!uuid(input?.challengeId)||typeof input?.passcode!=='string'||input.passcode.length!==6||!/^[0-9]{6}$/.test(input.passcode)){throw invalid();}
    const result=await withTransaction(async()=>{
      const row=(await query('SELECT * FROM operator_password_resets WHERE challenge_id=$1 FOR UPDATE',[input.challengeId])).rows[0];
      if(!row?.code_hash||!row.code_expires_at||timestamp(row.code_expires_at)<=now()||row.attempts>=5||!await currentAccount(row)){return null;}
      const actual=await scrypt(input.passcode,row.code_salt,64),expected=Buffer.from(row.code_hash,'hex');
      if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected)){
        await query('UPDATE operator_password_resets SET attempts=attempts+1 WHERE challenge_id=$1',[row.challenge_id]);return null;
      }
      // Recheck after the potentially slow hash computation.
      if(timestamp(row.code_expires_at)<=now()){return null;}
      const resetToken=crypto.randomBytes(32).toString('base64url');
      await query(`UPDATE operator_password_resets SET code_hash=NULL,code_expires_at=NULL,
        proof_hash=$2,proof_expires_at=$3 WHERE challenge_id=$1`,[row.challenge_id,digest(resetToken),new Date(now()+300000)]);
      return {resetToken};
    });
    if(!result){throw invalid();}return result;
  }
  async function complete(input,context={}) {
    await limitIp(context,'complete',60);
    if(typeof input?.password!=='string'||input.password.length<6||input.password.length>256){throw Object.assign(new Error('Password must be 6 to 256 characters.'),{status:400});}
    if(typeof input?.resetToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.resetToken)){throw invalid();}
    const ok=await withTransaction(async()=>{
      const row=(await query('SELECT * FROM operator_password_resets WHERE proof_hash=$1 FOR UPDATE',[digest(input.resetToken)])).rows[0];
      if(!row?.proof_expires_at||!await currentAccount(row,true)||timestamp(row.proof_expires_at)<=now()){return false;}
      await updateOperatorPassword(row.operator_id,input.password);
      await query('UPDATE operator_password_resets SET proof_hash=NULL,proof_expires_at=NULL,code_hash=NULL WHERE identity_hash=$1',[row.identity_hash]);
      return true;
    });
    if(!ok){throw invalid();}return {ok:true};
  }
  return {request,verify,complete};
}
