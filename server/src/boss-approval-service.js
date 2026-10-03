import {APPROVED_SO_STATUSES,bossError,eligibleBossIds,normalizeSnapshot,requireBoss,snapshotFingerprint,validDecision} from './boss-approval-domain.js';

const changedMessage='The order or customer credit information changed. Refresh and confirm again.';
const pendingMessage=command=>'NetSuite still reports Pending Approval. The order has not been '+(command.action==='reject'?'closed.':'accepted.');
export function createBossApprovalService({repo,remote}) {
  async function decide(actor,raw) {
    const input=validDecision(raw);
    const existing=await repo.existingCommand(actor,input);
    if(existing){return existing;}
    const request=await repo.detail(actor,input.requestId);
    if(request.status!=='pending'||request.revision!==input.expectedRevision){throw bossError(changedMessage,409,'BOSS_STALE');}
    const current=normalizeSnapshot(await remote.read(request.snapshot.orderId));
    if(snapshotFingerprint(current)!==snapshotFingerprint(request.snapshot)){
      await repo.refreshRequest(request.id,current);
      throw bossError(changedMessage,409,'BOSS_STALE');
    }
    return repo.claimDecision(actor,input);
  }
  async function canSend(command,snapshot) {
    if(!(await repo.settings()).enabled){throw bossError('BOSS approvals are paused.',409);}
    const actor=await repo.accountActor(command.actorId);
    const people=await repo.roster();
    requireBoss(actor,people);
    if(!eligibleBossIds(snapshot.ownerId,people).includes(actor.id)){throw bossError('This request is now assigned to another BOSS.',403);}
    if(snapshotFingerprint(snapshot)!==command.fingerprint){throw bossError(changedMessage,409);}
  }
  /** @param {any} command @param {{attempted?:boolean,writeError?:{netsuiteResponseReceived?:boolean,status?:number}|null}} [options] */
  async function reconcile(command,{attempted=false,writeError=null}={}) {
    let snapshot;
    try {snapshot=normalizeSnapshot(await remote.read(command.snapshot.orderId));}
    catch{
      return repo.finishCommand(command,{outcome:'uncertain',error:'Waiting for NetSuite to confirm the decision result.'});
    }
    if(command.action==='reject'&&snapshot.status==='H'){
      return repo.finishCommand(command,{outcome:'rejected',snapshot});
    }
    if(command.action!=='reject'&&APPROVED_SO_STATUSES.includes(snapshot.status)){
      return repo.finishCommand(command,{outcome:'approved',snapshot});
    }
    if(snapshot.status!=='A'){
      return repo.finishCommand(command,{outcome:'resolved',snapshot,external:true});
    }
    // A response to a synchronous PATCH can confirm rejection. A transport failure
    // cannot: keep reconciling reads, without automatically repeating the write.
    const definiteFailure=attempted && (!writeError || (writeError.netsuiteResponseReceived && Number(writeError.status)>=400 && Number(writeError.status)<500));
    return repo.finishCommand(command,{outcome:definiteFailure?'failed':'uncertain',error:definiteFailure?pendingMessage(command):'Checking the decision result with NetSuite. No second request has been sent.'});
  }
  async function processCommand(command) {
    if(command.remote_attempted_at||command.status==='uncertain'){return reconcile(command);}
    let snapshot;
    try {
      snapshot=normalizeSnapshot(await remote.read(command.snapshot.orderId));
      if(APPROVED_SO_STATUSES.includes(snapshot.status)){
        return repo.finishCommand(command,{outcome:'approved',snapshot,external:true});
      }
      if(snapshot.status!=='A'){return repo.finishCommand(command,{outcome:'resolved',snapshot,external:true});}
      await canSend(command,snapshot);
    }catch(error){
      return repo.finishCommand(command,{outcome:'failed',error:error.status===403||error.status===409?error.message:'Unable to verify the latest NetSuite order. Refresh and try again.'});
    }
    if(!await repo.beginRemote(command)){return;}
    let writeError=null;
    try {
      const send=command.action==='reject'?remote.close:remote.approve;
      await send(command.snapshot.orderId,{expectedVersion:command.snapshot.orderVersion,beforeSend:async()=>{
        try {await canSend(command,normalizeSnapshot(await remote.read(command.snapshot.orderId)));}
        catch(error){throw Object.assign(error,{bossNoWrite:true});}
      }});
    }catch(error){
      if(error.bossNoWrite){return repo.finishCommand(command,{outcome:'failed',error:'The latest order could not be '+(command.action==='reject'?'closed':'approved')+' safely. Refresh and confirm again.'});}
      writeError=error;
    }
    return reconcile(command,{attempted:true,writeError});
  }
  async function processSource(job) {
    try {return await repo.applySource(job,await remote.read(Number(job.order_id)));}
    catch(error){await repo.failSource(job,error);return null;}
  }
  return {decide,processCommand,processSource};
}
