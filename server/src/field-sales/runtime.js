import { createFieldSalesRepository } from './repository.js';
import { createCityImporter } from './importer.js';
import { createNetSuiteCatalogReader } from './netsuite-catalog.js';
import { createSalesCatalog } from './catalog.js';
import { createOrderPublisher } from './orders.js';
import { createFieldSalesRouter } from './router.js';
import { callFieldSalesRestlet } from '../netsuite.js';

export function createFieldSalesRuntime({maps,browserMap}) {
  const postingEnabled=process.env.FIELD_SALES_NETSUITE_WRITES_ENABLED==='true';
  const repo=createFieldSalesRepository(undefined,{postingEnabled,transport:callFieldSalesRestlet});
  const transport=callFieldSalesRestlet;
  const importer=createCityImporter(repo),catalog=createSalesCatalog(repo,{reader:createNetSuiteCatalogReader()});
  const publisher=createOrderPublisher(repo,{transport,enabled:postingEnabled});
  let timers=[],importing=false;
  const log=error=>console.error('[field-sales worker]',error.message);
  const importTick=async()=>{if(importing){return;}importing=true;try{await importer.tick();}catch(e){log(e);}finally{importing=false;}};
  return {repo,router:createFieldSalesRouter({repo,catalog,importer,maps,browserMap,postingEnabled,integrationHealth:()=>transport('order.health')}),start(){
    if(timers.length){return;}
    timers=[setInterval(()=>publisher.tick().catch(log),15000),setInterval(importTick,60000)];
    timers.forEach(t=>t.unref());
  },stop(){timers.forEach(clearInterval);timers=[];}};
}
