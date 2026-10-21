import {query,closeDb} from './src/db.js';
import {suiteqlAll,prepareSpecialClosurePlanInNetSuite} from './src/netsuite.js';
try {
 const d=(await query(`SELECT request_id,sales_order_netsuite_id AS so,purchase_order_netsuite_id AS po,close_status,closure_review FROM sales_special_stock_cases WHERE request_id=90`)).rows[0];
 console.log(JSON.stringify({caseId:d.request_id,so:d.so,po:d.po,closeStatus:d.close_status,review:d.closure_review}));
 for(const id of [d.so,d.po]){
  const rows=await suiteqlAll(`SELECT t.id,t.tranid,t.type,t.status,BUILTIN.DF(t.status) AS status_text,tl.id AS line,tl.uniquekey,tl.item,BUILTIN.DF(tl.item) AS item_name,tl.quantity,tl.quantityshiprecv,tl.quantitybilled,tl.rate,tl.isclosed,i.itemtype,i.isfulfillable FROM transaction t JOIN transactionline tl ON tl.transaction=t.id JOIN item i ON i.id=tl.item WHERE t.id=${Number(id)} AND tl.mainline='F' AND tl.taxline='F' ORDER BY tl.id`);
  console.log(JSON.stringify({id,rows}));
 }
 const native=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{
  if(String(url).includes('/record/v1/')) {
   if(options?.method && options.method!=='GET')throw Error('READ ONLY inspection');
   const r=await native(url,options);
   const raw=await r.clone().json();
   console.log(JSON.stringify({record:raw.id,status:raw.orderStatus,lines:raw.item?.items?.map(l=>({line:l.line,item:l.item?.id,quantity:l.quantity,quantityFulfilled:l.quantityFulfilled,quantityBilled:l.quantityBilled,rate:l.rate,amount:l.amount,isClosed:l.isClosed}))}));
   return r;
  }
  return native(url,options);
 };
 try {await prepareSpecialClosurePlanInNetSuite({orders:[{id:Number(d.so),kind:'sales_order'},{id:Number(d.po),kind:'purchase_order'}]});}
 catch(e){console.log(JSON.stringify({preflightError:e.message}));}
} finally {await closeDb();}
