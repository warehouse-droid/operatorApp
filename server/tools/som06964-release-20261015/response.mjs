import {query,withTransaction,closeDb} from './src/db.js';
import {config} from './src/config.js';
config.netsuite.directAccessEnabled=false;
const {loadDispatchOrdersForResponse}=await import('./src/server.js');
const {getDispatchOrderCatalogOrder,listDispatchOrderPool}=await import('./src/dispatch-order-catalog-repository.js');
const {assertSalesDeliveryPlanningAllowed}=await import('./src/dispatch-fulfilled-so-repository.js');
try{const data=await withTransaction(async()=>{
 await query('SET TRANSACTION READ ONLY');await query("SET LOCAL statement_timeout='30s'");
 const orders=await loadDispatchOrdersForResponse({type:'SO',search:'SOM06964',exactOrderRefs:['SOM06964'],includeCompletedScmSearch:true});
 const catalog=await getDispatchOrderCatalogOrder('SOM06964');
 const pool=await listDispatchOrderPool({type:'SO',search:'SOM06964'});
 let allowed;try{await assertSalesDeliveryPlanningAllowed(['SOM06964']);allowed=true;}catch(e){allowed={code:e.code,message:e.message};}
 return{at:new Date().toISOString(),orders,catalog,pool,allowed};
});console.log(JSON.stringify(data,null,2));}finally{await closeDb();}
