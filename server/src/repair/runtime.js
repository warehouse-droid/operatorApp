import {createRepairRepository} from './repository.js';
import {createRepairNetSuite} from './netsuite.js';
import {createRepairRouter} from './router.js';
import {createRepairMedia} from './media.js';
import {createRepairDirectory} from './directory.js';
import {createRepairOperations} from './operations.js';
import {createRepairPush} from './push.js';
import {repairNetSuiteRecord,suiteqlAll} from '../netsuite.js';
export function createRepairRuntime({authenticate,authenticateDriver,config,dataDir,logger=console}){
 const enabled=()=>config.repair?.enabled===true;
 const repo=createRepairRepository(),adapter=createRepairNetSuite({record:repairNetSuiteRecord,queryAll:suiteqlAll});
 const media=createRepairMedia({repo,dataDir}),directory=createRepairDirectory({repo,adapter,enabled}),operations=createRepairOperations({repo,adapter,enabled:()=>config.repair?.postingEnabled===true}),push=createRepairPush(config);
 let timer;
 // Financial documents are posted only by an authenticated Office POST action.
 const tick=async()=>{if(!enabled())return;try{await push.tick();}catch{logger.error('[Repair] Background processing failed.');}};
 return {repo,router:createRepairRouter({repo,authenticate,authenticateDriver,enabled,directory,media,operations,push,appBaseUrl:config.appBaseUrl,logger}),start(){if(!timer){timer=setInterval(()=>void tick(),30000);timer.unref();void tick();}},stop(){if(timer)clearInterval(timer);timer=null;}};
}
