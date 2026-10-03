import {eligibleBossIds} from './boss-approval-domain.js';

export function createBossApprovalRuntime({repo,service,remote,mailer,enqueue,logger=console}) {
  let nextBootstrapAt=0;
  const running=new Set();
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer=null;
  async function bootstrap() {
    if((await repo.settings()).bootstrap_complete){return;}
    for(const row of await remote.pending()){
      await enqueue({orderType:'sales_order',netsuiteOrderId:Number(row.id),tranid:row.tranid,availableAt:new Date(Date.now()+10000)});
    }
    await repo.markBootstrapped();
  }
  async function sendEmail(job) {
    const event=await repo.emailContent(job);
    const people=await repo.roster();
    const person=people.find(p=>p.operatorId===job.operator_id);
    const permitted=person?.active&&person.roles?.includes('boss')&&event
      &&(event.kind!=='requested'||(['pending','processing'].includes(event.status)&&eligibleBossIds(event.current_snapshot.ownerId,people).includes(job.operator_id)));
    if(!permitted){await repo.finishEmail(job,'cancelled');return;}
    try {
      await mailer.send({...job,email:event.current_email},event);
      await repo.finishEmail(job,'sent');
    }catch(error){
      // Explicit SMTP refusals and connection failures are safe to retry. A lost
      // DATA acknowledgement is ambiguous; surface it for review, not duplicates.
      const retry=error.responseCode>=400&&error.responseCode<500||['ECONNECTION','ECONNREFUSED','EDNS'].includes(error.code);
      const status=retry?'pending':error.responseCode>=500?'failed':'uncertain';
      await repo.finishEmail(job,status,retry?'Temporary SMTP failure; delivery will retry.':status==='failed'?'SMTP rejected delivery. Check the account email and server mail settings.':'Delivery outcome unknown. Check SMTP logs before retrying.');
    }
  }
  async function lane(name,work) {
    if(running.has(name)){return;}
    running.add(name);
    try{await work();}
    catch(error){logger.error(`BOSS ${name} worker:`,error.message);}
    finally{running.delete(name);}
  }
  async function tick() {
    await Promise.allSettled([
      lane('decisions',async()=>{
      // Already attempted commands still reconcile when intake is paused.
      for(let i=0;i<5;i++) {const c=await repo.claimCommand();if(!c){break;}await service.processCommand(c);}
      }),
      lane('sources',async()=>{
      if((await repo.settings()).enabled){
        for(let i=0;i<5;i++) {const job=await repo.claimSource();if(!job){break;}await service.processSource(job);}
      }
      }),
      lane('email',async()=>{
      if(mailer.readiness().configured){
        for(let i=0;i<10;i++) {const job=await repo.claimEmail();if(!job){break;}await sendEmail(job);}
      }
      }),
      lane('backfill',async()=>{
      if((await repo.settings()).enabled&&Date.now()>=nextBootstrapAt){
        nextBootstrapAt=Date.now()+60000;
        await bootstrap();
      }
      })
    ]);
  }
  function start(){if(!timer){timer=setInterval(()=>void tick(),5000);timer.unref?.();void tick();}}
  function stop(){if(timer){clearInterval(timer);}timer=null;}
  return {tick,start,stop,sendEmail};
}
