import crypto from 'node:crypto';
import {query,withTransaction} from '../db.js';
import {StockCheckError,cleanText,normalizeProduct,effectiveProduct,matchingProducts,EDITABLE_PRODUCT_FIELDS,publicAccount,validateQuantity,stockCheckResultView} from './domain.js';
import {sealCredentials,openCredentials} from './vault.js';

const conflict=()=>{throw new StockCheckError('This record changed. Reload it before saving.',409,'STOCK_CHECK_REVISION_CONFLICT');};
const missing=()=>{throw new StockCheckError('The stock-check record was not found.',404,'STOCK_CHECK_NOT_FOUND');};
const normalize=input=>normalizeProduct(input,{allowUnmappedPickup:true});
const productView=row=>({...effectiveProduct({...row.source_data,overrides:row.overrides},{allowUnmappedPickup:true}),
  id:row.id,vendorId:row.vendor_id,revision:row.revision,source:row.source_data,overrides:row.overrides,
  manualCreated:row.manual_created,lastScrapedAt:row.last_scraped_at,updatedAt:row.updated_at});
const vendorView=row=>({id:row.id,name:row.name,methodKey:row.method_key,selectedAccountId:row.selected_account_id,
  active:row.active,revision:row.revision,methodVerifiedAt:row.method_verified_at});
const jobView=row=>({id:row.id,vendorId:row.vendor_id,accountId:row.account_id,productId:row.product_id,
  kind:row.kind,status:row.status,payload:row.payload,progress:row.progress,result:stockCheckResultView(row.result),
  cancelRequested:row.cancel_requested,createdAt:row.created_at,startedAt:row.started_at,finishedAt:row.finished_at});
async function audit(vendorId,actor,action,id,detail={}) {
  await query('INSERT INTO scm_stock_check_audit(vendor_id,actor,action,target_id,detail) VALUES($1,$2,$3,$4,$5)',[vendorId,String(actor),action,String(id),detail]);
}

export function createStockCheckRepository({credentialKey}) {
  async function getVendor(id) {
    const {rows}=await query('SELECT * FROM scm_stock_check_vendors WHERE id=$1',[id]);
    if(!rows[0]) {missing();} return vendorView(rows[0]);
  }
  async function listVendors() {
    const {rows}=await query('SELECT * FROM scm_stock_check_vendors ORDER BY name,id');return rows.map(vendorView);
  }
  async function saveVendor(input,actor) {
    const name=cleanText(input.name,120,'Vendor name'),methodKey=cleanText(input.methodKey??'pending',80,'Scrape method');
    if(!name || !['pending','unilock-ontario-v1'].includes(methodKey)) {throw new StockCheckError('Enter a vendor name and a supported method.');}
    return withTransaction(async()=>{
      let row;
      if(input.id) {
        const current=await getVendor(input.id);
        if(current.revision!==Number(input.revision)) {conflict();}
        const selected=input.selectedAccountId===undefined?current.selectedAccountId:input.selectedAccountId;
        if(selected!==null) {
          const check=await query('SELECT id FROM scm_stock_check_accounts WHERE id=$1 AND vendor_id=$2 AND active',[selected,input.id]);
          if(!check.rows.length) {throw new StockCheckError('Select an active account belonging to this vendor.',400,'STOCK_CHECK_ACCOUNT_MISMATCH');}
        }
        const result=await query('UPDATE scm_stock_check_vendors SET name=$2,method_key=$3,selected_account_id=$4,active=$5,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$6 RETURNING *',
          [input.id,name,methodKey,selected,input.active??current.active,current.revision]);row=result.rows[0];if(!row) {conflict();}
      } else {
        const result=await query('INSERT INTO scm_stock_check_vendors(name,method_key) VALUES($1,$2) RETURNING *',[name,methodKey]);row=result.rows[0];
      }
      await audit(row.id,actor,'vendor_saved',row.id);return vendorView(row);
    });
  }
  async function listAccounts(vendorId) {
    const {rows}=await query('SELECT a.*,a.id=v.selected_account_id AS selected FROM scm_stock_check_accounts a JOIN scm_stock_check_vendors v ON v.id=a.vendor_id WHERE a.vendor_id=$1 ORDER BY a.id',[vendorId]);
    return rows.map(publicAccount);
  }
  async function getCredentials(vendorId,accountId) {
    const {rows}=await query('SELECT * FROM scm_stock_check_accounts WHERE vendor_id=$1 AND id=$2 AND active',[vendorId,accountId]);
    if(!rows[0]) {missing();}return openCredentials(await credentialKey(),rows[0].encrypted_secret,Number(vendorId),Number(accountId));
  }
  async function saveAccount(vendorId,input,actor) {
    const label=cleanText(input.label,100,'Account label'),username=cleanText(input.username,100,'Login ID');
    if(!label || !username) {throw new StockCheckError('Enter an account label and login ID.');}
    if(!input.id && !input.password) {throw new StockCheckError('Enter a login ID and password for this vendor account.',400,'STOCK_CHECK_CREDENTIALS_REQUIRED');}
    return withTransaction(async()=>{
      await getVendor(vendorId);let id=input.id,previous=null;
      if(id) {
        const {rows}=await query('SELECT * FROM scm_stock_check_accounts WHERE id=$1 AND vendor_id=$2 FOR UPDATE',[id,vendorId]);
        if(!rows[0]) {missing();}if(rows[0].revision!==Number(input.revision)) {conflict();}
        previous=rows[0];
      } else {
        const {rows}=await query('INSERT INTO scm_stock_check_accounts(vendor_id,label,username) VALUES($1,$2,$3) RETURNING id',[vendorId,label,username]);id=rows[0].id;
      }
      const secret=input.password?{username,password:input.password}:{...openCredentials(await credentialKey(),previous.encrypted_secret,Number(vendorId),Number(id)),username};
      const sealed=sealCredentials(await credentialKey(),secret,Number(vendorId),Number(id));
      await query('UPDATE scm_stock_check_accounts SET label=$3,username=$4,encrypted_secret=$5,active=$6,revision=revision+1,last_verified_at=NULL,last_error=NULL,updated_at=now() WHERE vendor_id=$1 AND id=$2',
        [vendorId,id,label,username,sealed,input.active!==false]);
      if(input.active!==false) {await query('UPDATE scm_stock_check_vendors SET selected_account_id=$2,revision=revision+1 WHERE id=$1 AND selected_account_id IS NULL',[vendorId,id]);}
      else {await query('UPDATE scm_stock_check_vendors SET selected_account_id=NULL,revision=revision+1 WHERE id=$1 AND selected_account_id=$2',[vendorId,id]);}
      await audit(vendorId,actor,'account_saved',id,{label});return (await listAccounts(vendorId)).find(row=>row.id===id);
    });
  }
  async function getProduct(vendorId,id) {
    const {rows}=await query('SELECT * FROM scm_stock_check_products WHERE vendor_id=$1 AND id=$2',[vendorId,id]);
    if(!rows[0]) {missing();}return productView(rows[0]);
  }
  async function listProducts({vendorId,search='',offset=0,limit=100,reviewOnly=false}={}) {
    const {rows}=await query('SELECT * FROM scm_stock_check_products WHERE ($1::int IS NULL OR vendor_id=$1) ORDER BY sku,id',[vendorId??null]);
    let items=rows.map(productView);if(search) {items=matchingProducts(items,search);}if(reviewOnly) {items=items.filter(row=>row.pickupNeedsReview);}
    const start=Math.max(0,Number(offset)||0),size=Math.min(500,Math.max(1,Number(limit)||100));
    return {total:items.length,items:items.slice(start,start+size),offset:start,limit:size};
  }
  async function upsertScrapedProduct(vendorId,input) {
    const source=normalize(input);
    const {rows}=await query(`INSERT INTO scm_stock_check_products(vendor_id,sku,source_data,last_scraped_at) VALUES($1,$2,$3,now())
      ON CONFLICT(vendor_id,sku) DO UPDATE SET source_data=excluded.source_data,last_scraped_at=now(),updated_at=now(),
      revision=scm_stock_check_products.revision+CASE WHEN scm_stock_check_products.source_data IS DISTINCT FROM excluded.source_data THEN 1 ELSE 0 END RETURNING *`,[vendorId,source.sku,source]);
    return productView(rows[0]);
  }
  async function saveProduct(vendorId,input,actor) {
    return withTransaction(async()=>{
      if(!input.id) {
        const source=normalize(input);
        const {rows}=await query('INSERT INTO scm_stock_check_products(vendor_id,sku,source_data,manual_created,updated_by) VALUES($1,$2,$3,true,$4) RETURNING *',[vendorId,source.sku,source,String(actor)]);
        await audit(vendorId,actor,'product_created',rows[0].id);return productView(rows[0]);
      }
      const current=await getProduct(vendorId,input.id),overrides={};
      if(current.revision!==Number(input.revision)) {conflict();}
      if(!input.overrides || typeof input.overrides!=='object' || Array.isArray(input.overrides)) {throw new StockCheckError('Product corrections must be a field object.');}
      for(const [key,value] of Object.entries(input.overrides)) {
        if(!EDITABLE_PRODUCT_FIELDS.includes(key)) {throw new StockCheckError('This product field cannot be edited.');}
        overrides[key]=cleanText(value,key.endsWith('Url')||key==='url'?2000:240,key);
      }
      effectiveProduct({...current.source,overrides},{allowUnmappedPickup:true});
      const {rows}=await query('UPDATE scm_stock_check_products SET overrides=$3,revision=revision+1,updated_by=$4,updated_at=now() WHERE vendor_id=$1 AND id=$2 AND revision=$5 RETURNING *',[vendorId,input.id,overrides,String(actor),current.revision]);
      if(!rows[0]) {conflict();}await audit(vendorId,actor,'product_corrected',input.id,{fields:Object.keys(overrides)});return productView(rows[0]);
    });
  }
  async function createJob(vendorId,input,actor,{queueLimit=10,requestLine=null}={}) {
    return withTransaction(async()=>{
    await query('SELECT pg_advisory_xact_lock(19671123,$1)',[vendorId]);
    const vendor=await getVendor(vendorId);
    if(!vendor.active || vendor.methodKey!=='unilock-ontario-v1') {throw new StockCheckError('This vendor method has not been defined and tested.',422,'STOCK_CHECK_METHOD_PENDING');}
    if(!['catalog_refresh','login_test','stock_test'].includes(input.kind)) {throw new StockCheckError('Select a supported check.');}
    const queued=await query("SELECT count(*)::int AS count FROM scm_stock_check_jobs WHERE vendor_id=$1 AND status IN ('queued','running')",[vendorId]);
    if(queued.rows[0].count>=queueLimit) {throw new StockCheckError('Wait for an active vendor check to finish before adding more.',429,'STOCK_CHECK_QUEUE_FULL');}
    let account=null,product=null;const payload={methodKey:vendor.methodKey};
    if(input.kind!=='catalog_refresh') {
      account=(await listAccounts(vendorId)).find(row=>row.id===Number(input.accountId??vendor.selectedAccountId) && row.active && row.configured);
      if(!account) {throw new StockCheckError('Save and select a vendor login in Vendor Setup.',422,'STOCK_CHECK_LOGIN_REQUIRED');}
      payload.accountRevision=account.revision;
    }
    if(input.kind==='stock_test') {
      product=await getProduct(vendorId,input.productId);
      if(product.pickupNeedsReview) {throw new StockCheckError('SCM must correct the pickup point before testing this product.',422,'STOCK_CHECK_PICKUP_REVIEW_REQUIRED');}
      payload.product={...normalize(product),id:product.id,revision:product.revision};payload.quantity=validateQuantity(input.quantity);
    }
    if(requestLine) {payload.requestLine=requestLine;}
    const {rows}=await query('INSERT INTO scm_stock_check_jobs(id,vendor_id,account_id,product_id,kind,payload,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [crypto.randomUUID(),vendorId,account?.id??null,product?.id??null,input.kind,payload,String(actor)]);return jobView(rows[0]);
    });
  }
  async function getJob(id) {
    const {rows}=await query('SELECT * FROM scm_stock_check_jobs WHERE id=$1',[id]);if(!rows[0]) {missing();}
    const steps=await query('SELECT key,status,detail,sku,url,screenshot,created_at AS "createdAt" FROM scm_stock_check_steps WHERE job_id=$1 ORDER BY id',[id]);
    return {...jobView(rows[0]),steps:steps.rows};
  }
  async function listJobs(vendorId) {
    const {rows}=await query('SELECT * FROM scm_stock_check_jobs WHERE ($1::int IS NULL OR vendor_id=$1) ORDER BY created_at DESC LIMIT 30',[vendorId??null]);return rows.map(jobView);
  }
  async function claimNextJob() {
    const {rows}=await query(`UPDATE scm_stock_check_jobs SET status='running',started_at=now(),heartbeat_at=now() WHERE id=(
      SELECT id FROM scm_stock_check_jobs WHERE status='queued' AND NOT cancel_requested ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
    return rows[0]?jobView(rows[0]):null;
  }
  async function addStep(id,step) {
    if(!['success','failure','info'].includes(step.status)) {throw new StockCheckError('Invalid step status.');}
    await query('INSERT INTO scm_stock_check_steps(job_id,key,status,detail,sku,url,screenshot) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id,cleanText(step.key,80),step.status,cleanText(step.detail,1000),step.sku??null,step.url??null,step.screenshot??null]);
  }
  async function updateProgress(id,progress) {await query('UPDATE scm_stock_check_jobs SET progress=$2,heartbeat_at=now() WHERE id=$1',[id,progress]);}
  async function finishJob(id,result,status='completed') {await query('UPDATE scm_stock_check_jobs SET status=$2,result=$3,finished_at=now() WHERE id=$1',[id,status,result]);}
  async function cancelJob(id) {await query("UPDATE scm_stock_check_jobs SET cancel_requested=true,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE id=$1",[id]);return getJob(id);}
  async function recoverInterrupted() {await query(`UPDATE scm_stock_check_jobs SET status='failed',finished_at=now(),result=$1 WHERE status='running'`,
    [{status:'scrape_failure',reason:'The application restarted during this check. SCM must review the vendor cart before retrying.'}]);}
  async function recordAccountVerification(vendorId,accountId,success,error=null) {
    await query('UPDATE scm_stock_check_accounts SET last_verified_at=CASE WHEN $3 THEN now() ELSE NULL END,last_error=$4 WHERE vendor_id=$1 AND id=$2',[vendorId,accountId,success,error]);
    if(success) {await query('UPDATE scm_stock_check_vendors SET method_verified_at=now() WHERE id=$1',[vendorId]);}
  }
  return {listVendors,getVendor,saveVendor,listAccounts,saveAccount,getCredentials,listProducts,getProduct,upsertScrapedProduct,saveProduct,
    createJob,getJob,listJobs,claimNextJob,addStep,updateProgress,finishJob,cancelJob,recoverInterrupted,recordAccountVerification};
}
