import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {pool} from '../db.js';
import {createStockCheckRepository} from './repository.js';
import {loadCredentialKey} from './vault.js';
import {createStockCheckRouter} from './router.js';
import {scrapeUnilockCatalog} from './unilock-catalog.js';
import {checkUnilockStock,verifyUnilockLogin} from './unilock-stock.js';
import {StockCheckError,sanitizeFailure} from './domain.js';
import {createRequestStockChecks} from './request-checks.js';

export function createStockCheckRuntime({authenticate,dataDir,logger=console,
  adapters={catalog:scrapeUnilockCatalog,stock:checkUnilockStock,login:verifyUnilockLogin},repository=null}) {
  let keyPromise=null,timer=null,running=false,initialized=false,activeController=null;
  const credentialKey=()=>{keyPromise??=loadCredentialKey(path.join(dataDir,'.stock-check-credential-key')).catch(error=>{keyPromise=null;throw error;});return keyPromise;};
  const repo=repository??createStockCheckRepository({credentialKey}),evidenceDir=path.join(dataDir,'stock-check','evidence');
  async function screenshot(jobId,key,data) {
    if(!Buffer.isBuffer(data) || data.length>2*1024*1024 || data[0]!==255 || data[1]!==216) {throw new StockCheckError('The screenshot evidence could not be saved.');}
    const directory=path.join(evidenceDir,jobId);await fs.mkdir(directory,{recursive:true,mode:0o700});
    const filename=key.replace(/[^a-z0-9_-]/gu,'_')+'-'+crypto.randomUUID()+'.jpg';
    await fs.writeFile(path.join(directory,filename),data,{mode:0o600,flag:'wx'});return filename;
  }
  async function execute(job) {
    const controller=new AbortController();activeController=controller;
    const deadline=setTimeout(()=>controller.abort(),job.kind==='catalog_refresh'?60*60*1000:5*60*1000);
    const heartbeat=setInterval(()=>void repo.getJob(job.id).then(current=>{
      if(current.cancelRequested) {controller.abort();}
    }).catch(()=>controller.abort()),1000);
    let credentials=null;
    const callbacks={signal:controller.signal,onStep:step=>repo.addStep(job.id,step),
      onBaseline:snapshot=>repo.updateProgress(job.id,{phase:'cart_baseline',...snapshot}),
      onScreenshot:(key,data)=>screenshot(job.id,key,data)};
    try {
      if(job.kind==='catalog_refresh') {
        const result=await adapters.catalog({...callbacks,retainUnmapped:true,
          onProduct:product=>repo.upsertScrapedProduct(job.vendorId,product),onProgress:progress=>repo.updateProgress(job.id,progress)});
        await repo.finishJob(job.id,{status:result.errors.length?'partial':'catalog_refreshed',...result.summary,
          reason:result.errors.length?'Catalog saved with '+result.errors.length+' variants requiring SCM review.':'Catalog refresh completed.',errors:result.errors.slice(0,300)});
        return;
      }
      const accounts=await repo.listAccounts(job.vendorId),account=accounts.find(row=>row.id===job.accountId);
      if(!account || !account.active || account.revision!==job.payload.accountRevision) {throw new StockCheckError('The vendor login changed after this check was queued. Run a new check.');}
      credentials=await repo.getCredentials(job.vendorId,job.accountId);
      const options={...callbacks,credentials};
      const result=job.kind==='login_test'?await adapters.login(options):await adapters.stock({...options,product:job.payload.product,quantity:job.payload.quantity});
      if(job.kind==='login_test') {await repo.recordAccountVerification(job.vendorId,job.accountId,result.status==='login_verified',result.status==='login_verified'?null:result.reason);}
      await repo.finishJob(job.id,result,controller.signal.aborted?'cancelled':result.status==='scrape_failure'?'failed':'completed');
    } catch(error) {
      const reason=sanitizeFailure(error,[credentials?.password]);
      await repo.addStep(job.id,{key:'worker_failure',status:'failure',detail:reason});
      await repo.finishJob(job.id,{status:'scrape_failure',reason},controller.signal.aborted?'cancelled':'failed');
    } finally {clearInterval(heartbeat);clearTimeout(deadline);activeController=null;credentials=null;}
  }
  async function tick() {
    if(running) {return;}running=true;let client,locked=false;
    try {
      client=await pool.connect();const lock=await client.query('SELECT pg_try_advisory_lock(19671122,288) AS locked');locked=lock.rows[0].locked;
      if(!locked) {return;}
      if(!initialized) {await repo.recoverInterrupted();initialized=true;}
      const job=await repo.claimNextJob();if(job) {await execute(job);}
    } catch {logger.error('[Stock Check] Background check failed.');}
    finally {if(locked) {await client.query('SELECT pg_advisory_unlock(19671122,288)').catch(()=>{});}client?.release();running=false;}
  }
  return {repo,evidenceDir,router:createStockCheckRouter({repo,authenticate,evidenceDir,requestChecks:createRequestStockChecks(repo)}),tick,
    start(){if(timer) {return;}timer=setInterval(()=>void tick(),2000);timer.unref();void tick();},
    stop(){clearInterval(timer);timer=null;activeController?.abort();}};
}
