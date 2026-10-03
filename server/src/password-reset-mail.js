import {normalizeAccountEmail} from './account-email.js';

export function createPasswordResetMailer({env=process.env,loadTransport=async options=>{
  const {default:nodemailer}=await import('nodemailer');return nodemailer.createTransport(options);
}}={}) {
  let transport;
  const readiness=()=>({configured:Boolean(env.BOSS_SMTP_HOST&&env.BOSS_SMTP_USER&&env.BOSS_SMTP_PASSWORD)});
  async function send({to,code}) {
    if(!readiness().configured){throw new Error('SMTP is not configured.');}
    if(typeof code!=='string'||code.length!==6||!/^[0-9]{6}$/.test(code)){throw new Error('Invalid reset code.');}
    const recipient=normalizeAccountEmail(to),sender=normalizeAccountEmail(env.BOSS_SMTP_FROM||'warehouse@mrbininc.com');
    if(!recipient){throw new Error('Account email is missing.');}
    const port=Number(env.BOSS_SMTP_PORT||587);
    if(![465,587].includes(port)){throw new Error('SMTP requires TLS.');}
    if(!transport){transport=await loadTransport({host:env.BOSS_SMTP_HOST,port,secure:port===465,requireTLS:true,
      auth:{user:env.BOSS_SMTP_USER,pass:env.BOSS_SMTP_PASSWORD},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000,
      disableFileAccess:true,disableUrlAccess:true,tls:{minVersion:'TLSv1.2'}});}
    const result=await transport.sendMail({from:{name:'MBBS System',address:sender},to:recipient,subject:'MBBS System — Password reset code',
      text:`Your MBBS password reset code is:\n\n${code}\n\nEnter this 6-digit code within 60 seconds. A new code replaces the previous code.\n\nIf you did not request a password reset, you can ignore this email. Your password has not changed.`,
      headers:{'Auto-Submitted':'auto-generated'},disableFileAccess:true,disableUrlAccess:true});
    if(!result.accepted?.length){throw new Error('SMTP did not accept the recipient.');}
    return result;
  }
  return {readiness,send};
}
