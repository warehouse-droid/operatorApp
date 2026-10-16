import path from 'node:path';
import {createMbrRepository} from './repository.js';
import {loadLinkKey} from './credentials.js';
import {createMbrRouter} from './router.js';

export function createMbrRuntime({authenticate,config,dataDir,logger=console}) {
  const enabled=()=>config.mbr.enabled;
  let keyPromise=null,timer=null,running=false;
  const repo=createMbrRepository({baseUrl:config.appBaseUrl,linkKey:()=>{
    if(!keyPromise) {keyPromise=loadLinkKey(path.join(dataDir,'.mbr-signing-link-key')).catch(error=>{keyPromise=null;throw error;});}
    return keyPromise;
  }});
  const tick=async()=>{
    if(!enabled() || running) {return;}
    running=true;
    try {await repo.expireDue();}
    catch {logger.error('[MBR Contracts] Automatic expiration failed.');}
    finally {running=false;}
  };
  return {repo,router:createMbrRouter({repo,authenticate,enabled,logger}),tick,
    start(){if(timer){return;}timer=setInterval(()=>void tick(),60000);timer.unref();void tick();},
    stop(){if(timer){clearInterval(timer);timer=null;}}};
}
