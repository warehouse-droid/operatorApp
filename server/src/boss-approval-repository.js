import crypto from 'node:crypto';
import { query, withTransaction } from './db.js';
import { BOSS_IDENTITIES, APPROVED_SO_STATUSES, bossError, eligibleBossIds, requireBoss, normalizeSnapshot, snapshotFingerprint, positiveId, validDecision, snapshotReady } from './boss-approval-domain.js';
import { normalizeAccountEmail } from './account-email.js';

const requestView = r => r && ({id:Number(r.id),orderId:Number(r.order_id),cycle:r.cycle,status:r.status,revision:Number(r.revision),snapshot:r.snapshot,
  assignedTo:r.recipients,actorName:r.actor_name,createdAt:r.created_at,completedAt:r.completed_at,lastError:r.last_error,closedInNetSuite:Boolean(r.netsuite_closed)});
const closedEvidence="EXISTS(SELECT 1 FROM boss_approval_events e WHERE e.request_id=boss_approval_requests.id AND e.kind='rejected_closed') AS netsuite_closed";
const commandView = r => r && ({...r,requestId:Number(r.request_id),actorId:r.actor_id,actorName:r.actor_name,commandId:r.id});
export function createBossRepository(db = {query, transaction:withTransaction}) {
  const one = async (sql,params=[]) => (await db.query(sql,params)).rows[0] || null;
  const rows = async (sql,params=[]) => (await db.query(sql,params)).rows;
  const settings = async () => one('SELECT * FROM boss_approval_settings WHERE id=1');
  const roster = async () => (await rows(`SELECT p.*,o.active,o.roles,o.email FROM boss_approval_principals p LEFT JOIN operators o ON o.id=p.operator_id
    ORDER BY CASE p.key WHEN 'tony_tan' THEN 1 WHEN 'jason_pu' THEN 2 ELSE 3 END`)).map(r=>({key:r.key,name:r.name,ownerId:r.owner_id==null?null:String(r.owner_id),operatorId:r.operator_id,active:r.active,roles:r.roles,email:r.email||''}));
  async function authorize(actor) { const people=await roster(); requireBoss(actor,people); return people; }
  async function accountActor(id) { return one('SELECT id,display_name,role,roles,active,email FROM operators WHERE id=$1',[id]); }
  async function configure(input,actorId) {
    if (!Array.isArray(input.principals) || input.principals.length!==3 || typeof input.enabled!=='boolean') { throw bossError('Configure all three BOSS identities.'); }
    const principals=input.principals.map(p=>({key:p.key,operatorId:p.operatorId||null,ownerId:p.ownerId?positiveId(p.ownerId):null}));
    if (new Set(principals.map(p=>p.key)).size!==3 || principals.some(p=>!BOSS_IDENTITIES.includes(p.key))) { throw bossError('Choose the three named BOSS identities.'); }
    return db.transaction(async()=>{
      const current=await one('SELECT * FROM boss_approval_settings WHERE id=1 FOR UPDATE');
      if(Number(current.revision)!==Number(input.revision)){throw bossError('Settings changed. Refresh and try again.',409);}
      // Clear bindings first so exchanging two accounts or owner values is safe.
      await db.query('UPDATE boss_approval_principals SET operator_id=NULL,owner_id=NULL');
      for(const p of principals){await db.query('UPDATE boss_approval_principals SET operator_id=$2,owner_id=$3 WHERE key=$1',[p.key,p.operatorId,p.ownerId]);}
      const people=await roster();
      if(input.enabled && people.some(p=>!p.ownerId||!p.operatorId||!p.active||!p.roles?.includes('boss')||!normalizeAccountEmail(p.email))){throw bossError('Each BOSS needs a verified owner ID, active BOSS account and account email.');}
      await db.query('UPDATE boss_approval_settings SET enabled=$1,revision=revision+1,updated_by=$2,updated_at=now() WHERE id=1',[input.enabled,actorId]);
      // Re-evaluate pending assignments after configuration changes.
      await db.query("UPDATE boss_approval_sources SET generation=generation+1,available_at=now() WHERE order_id IN (SELECT order_id FROM boss_approval_requests WHERE status='pending')");
      return {settings:await settings(),principals:people};
    });
  }
  async function observe(observation) {
    if(observation.orderType!=='sales_order'||!observation.status){return;}
    await db.query(`INSERT INTO boss_approval_sources(order_id,tranid,observed_status,observed_at)
      SELECT $1,$2,$3,now() WHERE $3='A' OR EXISTS(SELECT 1 FROM boss_approval_sources WHERE order_id=$1)
      ON CONFLICT(order_id) DO UPDATE SET tranid=EXCLUDED.tranid,
      observed_status=EXCLUDED.observed_status,observed_at=now(),generation=boss_approval_sources.generation+1,available_at=now(),
      phase=CASE WHEN EXCLUDED.observed_status<>'A' THEN EXCLUDED.observed_status ELSE boss_approval_sources.phase END`,
    [positiveId(observation.netsuiteOrderId),observation.tranid||'',observation.status]);
  }
  async function claimSource() {
    return one(`WITH due AS (SELECT order_id FROM boss_approval_sources WHERE generation>enriched_generation
      AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at,order_id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE boss_approval_sources s SET lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',attempts=attempts+1
      FROM due WHERE s.order_id=due.order_id RETURNING s.*`);
  }
  /** @param {any} request @param {string} kind @param {any[]} people @param {{id?:string,name:string}|null} [actor] */
  async function addEvent(request,kind,people,actor=null) {
    const event=await one(`INSERT INTO boss_approval_events(request_id,kind,actor_id,actor_name,snapshot)
      VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *`,[request.id,kind,actor?.id||null,actor?.name||null,JSON.stringify(request.snapshot)]);
    const audience=kind==='requested'?people.filter(p=>request.recipients.includes(p.operatorId)):people;
    for(const p of audience.filter(p=>p.operatorId&&p.active&&p.roles?.includes('boss'))){
      await db.query(`INSERT INTO boss_approval_notifications(event_id,operator_id,email) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[event.id,p.operatorId,p.email]);
    }
    return event;
  }
  /** @param {any} request @param {string} status @param {any[]} people @param {{id?:string,name:string}|null} [actor] @param {string} [kind] @param {any} [savedSnapshot] */
  async function finishRequest(request,status,people,actor=null,kind=status,savedSnapshot=request.snapshot) {
    const done=await one(`UPDATE boss_approval_requests SET status=$2,revision=revision+1,completed_at=now(),
      actor_id=$3,actor_name=$4,last_error='',snapshot=$5::jsonb WHERE id=$1 RETURNING *`,[request.id,status,actor?.id||null,actor?.name||'NetSuite',JSON.stringify(savedSnapshot)]);
    await addEvent(done,kind,people,actor||{name:'NetSuite'});
    return done;
  }
  function sourceLeaseIsCurrent(source,job) {
    return source.lease_token===job.lease_token&&Number(source.generation)===Number(job.generation)&&new Date(source.lease_until)>new Date();
  }
  async function applySource(job,input) {
    const snapshot=normalizeSnapshot(input);const fingerprint=snapshotFingerprint(snapshot);
    if(snapshot.orderId!==Number(job.order_id)){throw bossError('NetSuite returned a different order.',502);}
    return db.transaction(async()=>{
      const source=await one('SELECT * FROM boss_approval_sources WHERE order_id=$1 FOR UPDATE',[job.order_id]);
      if(!sourceLeaseIsCurrent(source,job)){
        await db.query('UPDATE boss_approval_sources SET lease_until=NULL,lease_token=NULL WHERE order_id=$1 AND lease_token=$2',[job.order_id,job.lease_token]);return null;
      }
      const people=await roster();
      let request=await one('SELECT * FROM boss_approval_requests WHERE order_id=$1 ORDER BY cycle DESC LIMIT 1 FOR UPDATE',[job.order_id]);
      if(snapshot.status==='A'){
        const recipients=eligibleBossIds(snapshot.ownerId,people);
        if(!request || (!['pending','processing'].includes(request.status)&&source.phase!=='A')){
          request=await one(`INSERT INTO boss_approval_requests(order_id,cycle,status,snapshot,fingerprint,recipients)
            VALUES($1,$2,'pending',$3::jsonb,$4,$5::text[]) RETURNING *`,[snapshot.orderId,(request?.cycle||0)+1,JSON.stringify(snapshot),fingerprint,recipients]);
          await addEvent(request,'requested',people);
        }else if(request.status==='pending'){
          const recipientChange=JSON.stringify(request.recipients)!==JSON.stringify(recipients);
          const changed=request.fingerprint!==fingerprint||recipientChange;
          const previousRecipients=request.recipients;
          request=await one(`UPDATE boss_approval_requests SET snapshot=$2::jsonb,fingerprint=$3,recipients=$4::text[],
            revision=revision+$5 WHERE id=$1 RETURNING *`,[request.id,JSON.stringify(snapshot),fingerprint,recipients,changed?1:0]);
          if(recipientChange){await addEvent(request,'requested',people.filter(p=>!previousRecipients.includes(p.operatorId)));}
        }
      }else if(request?.status==='pending'){
        request=await finishRequest(request,APPROVED_SO_STATUSES.includes(snapshot.status)?'approved':'resolved',people,null,'resolved_in_netsuite');
      }
      await db.query(`UPDATE boss_approval_sources SET enriched_generation=$2,phase=$3,snapshot=$4::jsonb,
        lease_token=NULL,lease_until=NULL,attempts=0,last_error='' WHERE order_id=$1`,[job.order_id,job.generation,snapshot.status,JSON.stringify(snapshot)]);
      return requestView(request);
    });
  }
  async function failSource(job,error) {
    await db.query(`UPDATE boss_approval_sources SET lease_token=NULL,lease_until=NULL,last_error=$3,
      available_at=now()+interval '1 second'*LEAST(3600,30*power(2,LEAST(attempts,7))) WHERE order_id=$1 AND lease_token=$2`,[job.order_id,job.lease_token,String(error.message||error).slice(0,1000)]);
  }
  function allowed(request,actor,people) {
    requireBoss(actor,people);
    if(['pending','processing'].includes(request.status) && !eligibleBossIds(request.snapshot.ownerId,people).includes(actor.id)){throw bossError('This request is assigned to another BOSS.',403,'BOSS_NOT_ASSIGNED');}
  }
  async function detail(actor,id) {
    const people=await authorize(actor);const r=await one('SELECT *,'+closedEvidence+' FROM boss_approval_requests WHERE id=$1',[positiveId(id)]);
    if(!r){throw bossError('Approval request not found.',404);}
    allowed(r,actor,people);
    return {...requestView(r),events:await rows('SELECT kind,actor_name AS "actorName",snapshot,created_at AS "createdAt" FROM boss_approval_events WHERE request_id=$1 ORDER BY id DESC',[r.id])};
  }
  async function list(actor,params={}) {
    const people=await authorize(actor);const history=params.queue==='history';
    const search=String(params.search||'').trim().slice(0,100);const limit=30;
    const offset=Math.floor(Math.max(0,Math.min(100000,Number(params.offset)||0)));
    const completed="status IN ('approved','rejected','resolved')";
    const pending="(status IN ('pending','processing') AND $1=ANY(recipients))";
    const condition=search?`(${pending} OR ${completed})`:history?completed:pending;
    const order=search?"CASE WHEN status IN ('pending','processing') THEN 0 ELSE 1 END,COALESCE(completed_at,created_at) DESC,id DESC":history?'completed_at DESC,id DESC':'created_at,id';
    const values=[actor.id,`%${search.replace(/[\\%_]/g,'\\$&')}%`,search?'':params.status||'',limit+1,offset];
    const records=await rows(`SELECT *,${closedEvidence} FROM boss_approval_requests WHERE ${condition}
      AND ($2='%%' OR snapshot->>'tranid' ILIKE $2 OR snapshot->>'customerName' ILIKE $2)
      AND ($3='' OR status=$3) AND $1::text IS NOT NULL
      ORDER BY ${order} LIMIT $4 OFFSET $5`,values);
    const requests=records.slice(0,limit).filter(r=>!['pending','processing'].includes(r.status)||eligibleBossIds(r.snapshot.ownerId,people).includes(actor.id)).map(requestView);
    return {requests,hasMore:records.length>limit,nextOffset:offset+limit,enabled:(await settings()).enabled};
  }
  async function existingCommand(actor,input) {
    await authorize(actor);const command=await one('SELECT * FROM boss_approval_commands WHERE id=$1',[input.commandId]);
    if(command && (command.actor_id!==actor.id||Number(command.request_id)!==Number(input.requestId)||command.action!==input.action)){throw bossError('Decision ID already used.',409);}
    return commandView(command);
  }
  async function claimDecision(actor,raw) {
    const input=validDecision(raw);
    return db.transaction(async()=>{
      const people=await authorize(actor);
      const r=await one('SELECT * FROM boss_approval_requests WHERE id=$1 FOR UPDATE',[input.requestId]);
      if(!r){throw bossError('Approval request not found.',404);}
      const replay=await existingCommand(actor,input);if(replay){return replay;}
      allowed(r,actor,people);
      if(!(await settings()).enabled){throw bossError('BOSS approvals are not enabled.',409);}
      if(r.status!=='pending'||Number(r.revision)!==input.expectedRevision){throw bossError('This request changed or was already decided. Refresh it.',409,'BOSS_STALE');}
      if(input.action==='accept'&&!snapshotReady(r.snapshot)){throw bossError('Financial information is unavailable. Refresh before accepting.',409);}
      const person=requireBoss(actor,people);
      const c=await one(`INSERT INTO boss_approval_commands(id,request_id,actor_id,actor_name,action,status,snapshot,fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,[input.commandId,r.id,actor.id,person.name,input.action,'queued',JSON.stringify(r.snapshot),r.fingerprint]);
      await db.query("UPDATE boss_approval_requests SET status='processing',revision=revision+1,last_error='' WHERE id=$1",[r.id]);
      return commandView(c);
    });
  }
  async function refreshRequest(id,input) {
    const snapshot=normalizeSnapshot(input);const fingerprint=snapshotFingerprint(snapshot);
    return db.transaction(async()=>{
      const r=await lockRequestAndSource(id);
      if(r?.status!=='pending'){return;}
      if(snapshot.orderId!==Number(r.order_id)){throw bossError('NetSuite returned a different order.',502);}
      const people=await roster();
      if(snapshot.status!=='A'){
        await finishRequest(r,APPROVED_SO_STATUSES.includes(snapshot.status)?'approved':'resolved',people,null,'resolved_in_netsuite');
        await db.query('UPDATE boss_approval_sources SET phase=$2 WHERE order_id=$1',[r.order_id,snapshot.status]);return;
      }
      const recipients=eligibleBossIds(snapshot.ownerId,people);
      const updated=await one('UPDATE boss_approval_requests SET snapshot=$2::jsonb,fingerprint=$3,recipients=$4,revision=revision+1 WHERE id=$1 RETURNING *',[id,JSON.stringify(snapshot),fingerprint,recipients]);
      const newPeople=people.filter(p=>recipients.includes(p.operatorId)&&!r.recipients.includes(p.operatorId));
      if(newPeople.length){await addEvent(updated,'requested',newPeople);}
    });
  }
  async function lockRequestAndSource(id) {
    const identity=await one('SELECT order_id FROM boss_approval_requests WHERE id=$1',[id]);
    if(!identity){return null;}
    // All workers take source then request to avoid deadlocks with enrichment.
    await db.query('SELECT order_id FROM boss_approval_sources WHERE order_id=$1 FOR UPDATE',[identity.order_id]);
    return one('SELECT * FROM boss_approval_requests WHERE id=$1 FOR UPDATE',[id]);
  }
  async function claimCommand() {
    return db.transaction(async()=>{
      await db.query(`UPDATE boss_approval_commands SET status=CASE WHEN remote_attempted_at IS NULL THEN 'queued' ELSE 'uncertain' END,
        lease_token=NULL,lease_until=NULL WHERE status='sending' AND lease_until<now()`);
      return commandView(await one(`WITH due AS (SELECT id FROM boss_approval_commands WHERE status IN ('queued','uncertain') AND available_at<=now()
        AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
        UPDATE boss_approval_commands c SET lease_token=gen_random_uuid(),lease_until=now()+interval '10 minutes',attempts=attempts+1
        FROM due WHERE c.id=due.id RETURNING c.*`));
    });
  }
  async function beginRemote(command) {
    return Boolean(await one(`UPDATE boss_approval_commands SET status='sending',remote_attempted_at=now(),updated_at=now()
      WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND status='queued' AND remote_attempted_at IS NULL RETURNING id`,[command.id,command.lease_token]));
  }
  /** @param {any} command @param {{outcome:'approved'|'rejected'|'resolved'|'failed'|'uncertain',error?:string,snapshot?:ReturnType<typeof normalizeSnapshot>|null,external?:boolean}} result */
  async function finishCommand(command,{outcome,error='',snapshot=null,external=false}) {
    return db.transaction(async()=>{
      const r=await lockRequestAndSource(command.requestId);
      const owned=await one('SELECT * FROM boss_approval_commands WHERE id=$1 AND lease_token=$2 AND lease_until>now() FOR UPDATE',[command.id,command.lease_token]);
      if(!owned){return false;}
      const people=await roster();
      const completed=['approved','rejected','resolved'].includes(outcome);
      if(completed){
        // The durable command is exactly what the BOSS reviewed. Read-back and
        // later customer refreshes must never replace these historical figures.
        const kind=external?'resolved_in_netsuite':outcome==='rejected'?'rejected_closed':'approved';
        await finishRequest(r,outcome,people,external?null:{id:owned.actor_id,name:owned.actor_name},kind,external?r.snapshot:owned.snapshot);
        await db.query("UPDATE boss_approval_sources SET phase=$2,generation=generation+1,available_at=now() WHERE order_id=$1",[r.order_id,snapshot?.status||'B']);
      }else if(outcome==='failed'){
        await db.query("UPDATE boss_approval_requests SET status='pending',revision=revision+1,last_error=$2 WHERE id=$1",[r.id,error]);
        await db.query('UPDATE boss_approval_sources SET generation=generation+1,available_at=now() WHERE order_id=$1',[r.order_id]);
      }
      const status=completed?'succeeded':outcome;
      await db.query(`UPDATE boss_approval_commands SET status=$3,last_error=$4,updated_at=now(),lease_token=NULL,lease_until=NULL,
        available_at=now()+interval '30 seconds' WHERE id=$1 AND lease_token=$2`,[command.id,command.lease_token,status,String(error).slice(0,1000)]);
      return true;
    });
  }
  async function notifications(actor) {
    const people=await authorize(actor);
    const knownOwners=people.filter(p=>p.ownerId).map(p=>p.ownerId);
    const ownOwners=people.filter(p=>p.operatorId===actor.id&&p.ownerId).map(p=>p.ownerId);
    const visible=`n.operator_id=$1 AND n.email_status<>'cancelled' AND
      (r.status NOT IN ('pending','processing') OR r.snapshot->>'ownerId' IS NULL
        OR r.snapshot->>'ownerId'<>ALL($2::text[]) OR r.snapshot->>'ownerId'=ANY($3::text[]))`;
    const values=[actor.id,knownOwners,ownOwners];
    const entries=await rows(`SELECT n.id,n.read_at AS "readAt",n.created_at AS "createdAt",e.kind,e.actor_name AS "actorName",
      e.request_id AS "requestId",e.snapshot FROM boss_approval_notifications n JOIN boss_approval_events e ON e.id=n.event_id
      JOIN boss_approval_requests r ON r.id=e.request_id WHERE ${visible} ORDER BY n.id DESC LIMIT 100`,values);
    const count=await one(`SELECT count(*)::int AS n FROM boss_approval_notifications n JOIN boss_approval_events e ON e.id=n.event_id
      JOIN boss_approval_requests r ON r.id=e.request_id WHERE ${visible} AND n.read_at IS NULL`,values);
    return {notifications:entries.map(n=>({...n,id:Number(n.id),requestId:Number(n.requestId)})),unread:count.n};
  }
  async function markRead(actor,id) {
    await authorize(actor);await db.query('UPDATE boss_approval_notifications SET read_at=COALESCE(read_at,now()) WHERE operator_id=$1 AND id=$2',[actor.id,positiveId(id)]);
    return {ok:true};
  }
  async function claimEmail() {
    // SMTP acceptance followed by a crash is ambiguous; do not resend blindly.
    await db.query("UPDATE boss_approval_notifications SET email_status='uncertain',last_error='Delivery outcome unknown; review SMTP logs.' WHERE email_status='sending' AND lease_until<now()");
    return one(`WITH due AS (SELECT id FROM boss_approval_notifications WHERE email_status='pending' AND available_at<=now()
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE boss_approval_notifications n SET email_status='sending',attempts=attempts+1,
      lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes' FROM due WHERE n.id=due.id RETURNING n.*`);
  }
  async function emailContent(job) {
    return one(`SELECT e.*,r.status,r.recipients,r.snapshot AS current_snapshot,o.active,o.roles,o.email AS current_email FROM boss_approval_events e
      JOIN boss_approval_requests r ON r.id=e.request_id JOIN operators o ON o.id=$2 WHERE e.id=$1`,[job.event_id,job.operator_id]);
  }
  async function finishEmail(job,status,error='') {
    await db.query(`UPDATE boss_approval_notifications SET email_status=$3,last_error=$4,lease_token=NULL,lease_until=NULL,
      available_at=now()+interval '1 second'*LEAST(3600,30*power(2,LEAST(attempts,7))) WHERE id=$1 AND lease_token=$2
      AND lease_until>now() AND email_status='sending'`,[job.id,job.lease_token,status,String(error).slice(0,1000)]);
  }
  const health = async()=>({sources:await rows("SELECT last_error,count(*)::int AS count FROM boss_approval_sources WHERE last_error<>'' GROUP BY last_error"),
    emails:await rows('SELECT email_status,count(*)::int AS count FROM boss_approval_notifications GROUP BY email_status'),
    decisions:await rows('SELECT status,count(*)::int AS count FROM boss_approval_commands GROUP BY status')});
  return {settings,roster,configure,observe,claimSource,applySource,failSource,detail,list,existingCommand,claimDecision,refreshRequest,
    claimCommand,beginRemote,finishCommand,notifications,markRead,claimEmail,emailContent,finishEmail,accountActor,health,
    markBootstrapped:()=>db.query('UPDATE boss_approval_settings SET bootstrap_complete=true WHERE id=1'),
    newCommandId:()=>crypto.randomUUID()};
}
