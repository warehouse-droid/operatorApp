// Attempt the requested operational unsplit through the existing application service.
import { query, closeDb } from './src/db.js';
import { unsplitSalesOrder } from './src/dispatch-sales-resplit-repository.js';
import { config } from './src/config.js';
config.netsuite.directAccessEnabled=false;
try {
 const actor=(await query("SELECT id,username FROM operators WHERE lower(username)='testadmin' AND active")).rows[0];
 if(!actor) throw new Error('Requested audit actor is unavailable');
 const result=await unsplitSalesOrder({orderRef:'SOM06964-S1',orderType:'SO',planId:'359',planDate:'2026-10-15',actor,
  sessionId:'codex:SOM06964:unsplit:20261015'});
 console.log(JSON.stringify({at:new Date().toISOString(),applied:true,result},null,2));
} catch(error) {
 console.log(JSON.stringify({at:new Date().toISOString(),applied:false,error:{code:error.code,message:error.message}},null,2));
 process.exitCode=1;
} finally {await closeDb();}
