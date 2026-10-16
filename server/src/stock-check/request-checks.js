import {query,withTransaction} from '../db.js';
import {config} from '../config.js';
import {StockCheckError} from './domain.js';
import {isUnilock,lineFingerprint,matchLineProducts} from './line-matching.js';
import {createOllamaMatcher} from './ollama-matching.js';
import {stockCheckMaterial} from './line-description.js';

const productChoice=product=>product?Object.fromEntries(['id','revision','sku','name','colour','size','pickupLocation','pickupNeedsReview'].map(key=>[key,product[key]])):null;

async function requestLines(id,lock=false) {
  const request=await query('SELECT id FROM sales_stock_requests WHERE id=$1'+(lock?' FOR SHARE':''),[id]);
  if(!request.rows.length) {throw new StockCheckError('Stock request not found.',404);}
  const {rows}=await query(`SELECT l.*,s.vendor_name AS case_vendor,s.workflow_kind,i.item_description AS inventory_description FROM sales_special_stock_lines l
    JOIN sales_special_stock_cases s ON s.request_id=l.request_id
    LEFT JOIN inventory_items i ON s.workflow_kind='backorder' AND i.item_id=l.regular_item_id WHERE l.request_id=$1 AND l.removed_at IS NULL
    AND s.workflow_kind IN ('special','backorder') ORDER BY l.line_number,l.id`+(lock?' FOR SHARE OF l,s':''),[id]);
  return rows.map(row=>({lineId:Number(row.id),vendorName:row.response_vendor_name||row.brand||row.case_vendor,
    ...stockCheckMaterial(row),color:row.color,size:row.size,
    vendorReference:row.vendor_reference,quantity:Number(row.requested_quantity),uom:row.requested_uom}))
    .filter(line=>isUnilock(line.vendorName)).map(line=>({...line,fingerprint:lineFingerprint(line)}));
}
function validateSelections(input,lines) {
  if(!Array.isArray(input?.lines) || !input.lines.length || input.lines.length>100) {throw new StockCheckError('Select between 1 and 100 Unilock lines.');}
  const seen=new Set();
  return input.lines.map(selection=>{
    const line=lines.find(row=>row.lineId===selection?.lineId);
    if(!line || seen.has(line.lineId) || !Number.isSafeInteger(selection.productId) || selection.productId<1) {throw new StockCheckError('Select an exact catalogue variant for each Unilock line.');}
    seen.add(line.lineId);
    if(selection.fingerprint!==line.fingerprint) {throw new StockCheckError('The request material changed. Refresh before checking stock.',409,'STOCK_CHECK_LINE_CHANGED');}
    return {line,productId:selection.productId};
  });
}
export function createRequestStockChecks(repo,{matcher=createOllamaMatcher({settings:()=>config.ollama})}={}) {
  async function vendorId() {
    const vendors=(await repo.listVendors()).filter(v=>v.active && v.methodKey==='unilock-ontario-v1' && isUnilock(v.name));
    if(vendors.length!==1) {throw new StockCheckError('Configure one active Unilock vendor in Stock Check setup.',422);}
    return vendors[0].id;
  }
  async function latestJobs(id) {
    const {rows}=await query(`SELECT DISTINCT ON (payload->'requestLine'->>'lineId') id
      FROM scm_stock_check_jobs WHERE payload->'requestLine'->>'requestId'=$1
      ORDER BY payload->'requestLine'->>'lineId',created_at DESC,id DESC`,[String(id)]);
    const jobs=[];
    for(const row of rows) {jobs.push(await repo.getJob(row.id));}
    return jobs;
  }
  async function snapshot(id) {
    const lines=await requestLines(id);
    if(!lines.length) {return {data:{requestId:id,vendorId:null,lines:[]},products:[]};}
    const vendor=await vendorId(),products=[];
    for(let offset=0;;offset+=500) {
      const page=await repo.listProducts({vendorId:vendor,offset,limit:500});products.push(...page.items);
      if(products.length>=page.total) {break;}
    }
    const jobs=await latestJobs(id);
    return {products,data:{requestId:id,vendorId:vendor,lines:lines.map(line=>{
      const job=jobs.find(row=>row.payload.requestLine.lineId===line.lineId)??null,
        stale=Boolean(job && job.payload.requestLine.fingerprint!==line.fingerprint);
      const match=line.descriptionMissing?{product:null,candidates:[]}:matchLineProducts(line,products),saved=!stale && job?products.find(row=>row.id===job.productId):null;
      return {...line,candidates:match.candidates.map(productChoice),product:productChoice(saved??match.product),job,stale,
        ...(line.descriptionMissing?{aiMatch:{status:'review',reason:'The item description is missing. Select a catalogue variant to continue.'}}:{})};
    })}};
  }
  async function get(id) {return (await snapshot(id)).data;}
  async function match(id) {
    const before=await snapshot(id),unresolved=before.data.lines.filter(line=>!line.product&&!line.descriptionMissing);
    if(!unresolved.length) {return before.data;}
    // No database locks or transactions are held while the local model runs.
    const matches=await matcher.match(unresolved,before.products),after=await snapshot(id);
    if(JSON.stringify(before.data.lines.map(line=>line.fingerprint))!==JSON.stringify(after.data.lines.map(line=>line.fingerprint)) ||
      before.data.vendorId!==after.data.vendorId || JSON.stringify(before.products)!==JSON.stringify(after.products)) {
      throw new StockCheckError('The request or catalogue changed while matching. Refresh and try again.',409,'STOCK_CHECK_LINE_CHANGED');
    }
    return {...after.data,lines:after.data.lines.map(line=>{
      const result=matches.find(row=>row.lineId===line.lineId);
      return line.product || !result?line:{...line,product:productChoice(result.product),aiMatch:result.aiMatch};
    })};
  }
  async function start(id,input,actor) {
    await withTransaction(async()=>{
      const lines=await requestLines(id,true),selections=validateSelections(input,lines),vendor=await vendorId();
      await query('SELECT pg_advisory_xact_lock(19671123,$1)',[vendor]);
      const jobs=await latestJobs(id);
      for(const {line,productId} of selections) {
        const existing=jobs.find(job=>job.payload.requestLine.lineId===line.lineId &&
          job.payload.requestLine.fingerprint===line.fingerprint && ['queued','running'].includes(job.status));
        if(existing) {
          if(existing.productId!==productId) {throw new StockCheckError('This line already has a check in progress for another variant. Wait for it to finish.',409);}
          continue;
        }
        await repo.createJob(vendor,{kind:'stock_test',productId,quantity:1},actor,
          {queueLimit:100,requestLine:{requestId:id,lineId:line.lineId,fingerprint:line.fingerprint,
            description:[line.productName,line.color,line.size].filter(Boolean).join(' · '),quantity:line.quantity,uom:line.uom}});
      }
    });
    return get(id);
  }
  return {get,match,start};
}
