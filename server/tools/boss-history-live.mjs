// Read-only production verification. Run through stdin from the app working directory.
import './src/config.js';
import assert from 'node:assert/strict';
import {query,closeDb} from './src/db.js';
import {createBossRepository} from './src/boss-approval-repository.js';
import {listAudit} from './src/auth-repository.js';
import {createBossMailer} from './src/boss-approval-mail.js';
try{
 const repo=createBossRepository(),principals=await repo.roster();
 const readiness=createBossMailer().readiness();assert(readiness.configured);
 const statuses=(await query('SELECT status,count(*)::int AS count FROM boss_approval_requests GROUP BY status ORDER BY status')).rows;
 const delivery=(await query(`SELECT e.kind,n.email_status,count(*)::int AS count,count(DISTINCT e.request_id)::int AS orders,
  count(DISTINCT n.operator_id)::int AS recipients FROM boss_approval_notifications n JOIN boss_approval_events e ON e.id=n.event_id
  GROUP BY e.kind,n.email_status ORDER BY e.kind,n.email_status`)).rows;
 const sample=(await query('SELECT e.id,e.kind,e.snapshot FROM boss_approval_events e ORDER BY e.id LIMIT 1')).rows[0];
 if(sample){const rows=await listAudit({tranid:sample.snapshot.tranid,action:'boss.approval.'+sample.kind});assert(rows.some(r=>r.id==='boss:'+sample.id));}
 const searches=[];
 for(const person of principals){
  if(!person.operatorId||!person.active){continue;}
  const actor={id:person.operatorId,role:'boss',roles:person.roles,active:true};
  for(const queue of ['pending','history']){
   const result=await repo.list(actor,{queue,search:'SOV023',status:'approved'});
   searches.push({boss:person.name,fromTab:queue,matches:result.requests.length});
  }
 }
 console.log(JSON.stringify({smtpConfigured:true,sender:readiness.senderAddress,enabled:(await repo.settings()).enabled,
  configuredBosses:principals.filter(p=>p.operatorId&&p.ownerId&&p.active&&p.email).length,statuses,delivery,priorEventsInAudit:Boolean(sample),searches}));
}finally{await closeDb();}
