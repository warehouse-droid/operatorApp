import assert from 'node:assert/strict';import crypto from 'node:crypto';
const hashes={},htmlRoutes={};
let publicReadRetries=0;
async function read(url,options={}){
 for(let attempt=1;attempt<=3;attempt++){
  try{return await fetch(url,{...options,signal:AbortSignal.timeout(30000)});}
  catch(error){
   if(attempt===3||!url.startsWith('https://test.mbbsoperation.com/')||error.cause?.code!=='UND_ERR_CONNECT_TIMEOUT')throw error;
   publicReadRetries++;
   console.error(JSON.stringify({publicReadRetry:attempt,path:new URL(url).pathname,code:error.cause.code}));
   await new Promise(resolve=>setTimeout(resolve,attempt*1000));
  }
 }
}
for(const base of ['http://127.0.0.1:3000','https://test.mbbsoperation.com']){
 const health=await read(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 for(const [file,hash] of Object.entries(hashes)){if(!file.startsWith('public/'))continue;
 const path=file.endsWith('.html')?(htmlRoutes[file]||"/scm/POTOschedule"):'/'+file.slice(7);
 const response=await read(base+path,{headers:{'Cache-Control':'no-cache','User-Agent':'Mozilla/5.0'}});assert.equal(response.status,200,path);
 const body=(await response.text()).replace(/<script type="module" src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/[^>]+><\/script>\n/g,'');
 assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash,path);
 }
 const protectedRoute=await read(base+'/api/scm/schedule-preferences/scm');assert.equal(protectedRoute.status,401);
}
const {query,closeDb}=await import('./src/db.js');
try {
 const columns=(await query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='scm_schedule_user_preferences' AND column_name=ANY($1::text[])",[['order_kinds','methods','dropoff_points']])).rows;
 assert.equal(columns.length,3);
 const note=(await query('SELECT netsuite_note FROM purchase_orders WHERE netsuite_id=1030348')).rows[0];
 assert.equal(note.netsuite_note,'for SOB121819');
 console.log(JSON.stringify({health:true,publicAssets:true,preferencesProtected:true,preferenceColumns:true,notePreserved:true,publicReadRetries,poRef:'POB03976',poNote:note.netsuite_note}));
} finally {await closeDb();}
