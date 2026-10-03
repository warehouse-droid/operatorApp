import {normalizeAccountEmail} from './account-email.js';

export function createBossMailer({env=process.env,loadTransport=async options=>{
  const {default:nodemailer}=await import('nodemailer');
  return nodemailer.createTransport(options);
}}={}) {
  let transport;
  const sender=()=>normalizeAccountEmail(env.BOSS_SMTP_FROM||'warehouse@mrbininc.com');
  function readiness() {
    return {configured:Boolean(env.BOSS_SMTP_HOST&&env.BOSS_SMTP_USER&&env.BOSS_SMTP_PASSWORD),
      senderName:'MBBS System',senderAddress:sender()};
  }
  async function send(job,event) {
    if(!readiness().configured){throw new Error('SMTP is not configured.');}
    const to=normalizeAccountEmail(job.email);
    if(!to){throw new Error('Recipient account email is missing.');}
    const port=Number(env.BOSS_SMTP_PORT||587);
    if(![465,587].includes(port)){throw new Error('Use SMTP TLS port 465 or STARTTLS port 587.');}
    if(!transport){transport=await loadTransport({host:env.BOSS_SMTP_HOST,port,secure:port===465,requireTLS:true,
      auth:{user:env.BOSS_SMTP_USER,pass:env.BOSS_SMTP_PASSWORD},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000,
      disableFileAccess:true,disableUrlAccess:true,tls:{minVersion:'TLSv1.2'}});}
    const s=event.snapshot;
    const title=({requested:'Approval requested',approved:'Approved',rejected:'Rejected',rejected_closed:'Rejected',resolved_in_netsuite:'Status changed in NetSuite'})[event.kind]||'Approval updated';
    const base=String(env.APP_BASE_URL||'').replace(/\/$/,'');
    const link=/^https?:\/\//.test(base)?`${base}/boss?request=${Number(event.request_id)}`:'';
    const text=[`${title}: ${s.tranid}`,`Customer: ${s.customerName}`,`Account credit: ${s.creditLimit??'Unavailable'} ${s.currency}`,
      `Current balance: ${s.balance??'Unavailable'} ${s.currency}`,event.actor_name?`By: ${event.actor_name}`:'',
      ({rejected:'The sales order remains Pending Approval in NetSuite.',rejected_closed:'The sales order was closed in NetSuite.'})[event.kind]||'',link?'Open in MBBS: '+link:'Open MBBS → BOSS approvals.'].filter(Boolean).join('\n');
    const result=await transport.sendMail({from:{name:'MBBS System',address:sender()},to,
      subject:`${title} — ${s.tranid}`,text,messageId:`<boss-${Number(job.id)}@${sender().split('@')[1]}>`,
      headers:{'Auto-Submitted':'auto-generated'},disableFileAccess:true,disableUrlAccess:true});
    if(!result.accepted?.length){throw Object.assign(new Error('SMTP did not accept the recipient.'),{responseCode:550});}
    return result;
  }
  return {readiness,send};
}
