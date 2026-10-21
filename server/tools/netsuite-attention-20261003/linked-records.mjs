import fs from 'node:fs';
import {closeDb} from '../../src/db.js';
import {fetchItemFulfillmentFromNetSuite,fetchItemReceiptFromNetSuite} from '../../src/netsuite.js';
// Input is private read-only SuiteQL evidence collected by remote-sources.mjs.
const input=JSON.parse(process.env.INVESTIGATION_SOURCE_EVIDENCE || fs.readFileSync('/tmp/netsuite-attention-sources.json','utf8'));
try {
 const work=[...new Map(input.linked.map(l=>[l.id,{id:Number(l.id),type:l.type,reference:l.tranid}])).values()];
 const results=[];let cursor=0;
 await Promise.all(Array.from({length:3},async()=>{while(cursor<work.length){const item=work[cursor++];try{
  const record=await (item.type==='ItemShip'?fetchItemFulfillmentFromNetSuite:fetchItemReceiptFromNetSuite)(item.id);
  results.push({...item,record});
 }catch(error){results.push({...item,error:error.message});}}}));
 console.log(JSON.stringify({at:new Date().toISOString(),results},null,2));
}finally{await closeDb();}
