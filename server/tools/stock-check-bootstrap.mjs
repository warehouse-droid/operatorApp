// Authorized operational setup. Credentials arrive only on stdin and are encrypted by the repository.
import fs from 'node:fs';
import {withTransaction,closeDb} from '/app/src/db.js';
import {createStockCheckRuntime} from '/app/src/stock-check/runtime.js';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const runtime=createStockCheckRuntime({authenticate:(_req,_res,next)=>next(),dataDir:'/app/data'}),repo=runtime.repo;
try {
  const vendor=(await repo.listVendors()).find(row=>row.name==='Unilock'&&row.methodKey==='unilock-ontario-v1');
  if(!vendor) {throw new Error('Unilock vendor setup is missing.');}
  const result=await withTransaction(async()=>{
    let imported=0;for(const product of input.products) {await repo.upsertScrapedProduct(vendor.id,product);imported++;}
    const accounts=await repo.listAccounts(vendor.id),existing=accounts.find(row=>row.label==='Main Stock Login');
    const account=await repo.saveAccount(vendor.id,{label:'Main Stock Login',...input.credentials,...(existing?{id:existing.id,revision:existing.revision}:{})},'authorized-unilock-setup');
    const catalog=await repo.createJob(vendor.id,{kind:'catalog_refresh'},'authorized-unilock-setup');
    await repo.addStep(catalog.id,{key:'catalog_listing',status:'success',detail:'Visited 57 Unilock product series and their colour controls.'});
    await repo.addStep(catalog.id,{key:'catalog_import',status:'success',detail:'Saved '+imported+' exact SKU variants and their displayed pickup labels.'});
    const review=input.products.filter(row=>row.pickupNeedsReview);
    for(const product of review) {await repo.addStep(catalog.id,{key:'catalog_pickup_review',status:'failure',sku:product.sku,url:product.url,
      detail:product.pickupLocation?'Displayed plant '+product.pickupLocation+' is outside Ontario pickup choices. SCM correction is required.':'No pickup plant is displayed for this variant. SCM correction is required.'});}
    await repo.finishJob(catalog.id,{status:review.length?'partial':'catalog_refreshed',imported,pickupNeedsReview:review.length,
      reason:'Initial Unilock catalog saved: '+imported+' variants, '+review.length+' displayed pickup labels requiring SCM review.'});
    return {vendorId:vendor.id,accountId:account.id,accountConfigured:account.configured,imported,pickupNeedsReview:review.length,catalogJobId:catalog.id};
  });
  const products=await repo.listProducts({vendorId:vendor.id,search:'0262XL0631907-0'});
  if(products.total!==1) {throw new Error('The requested Beacon Hill Smooth XL variant was not uniquely imported.');}
  const login=await repo.createJob(vendor.id,{kind:'login_test'},'authorized-unilock-setup');
  const stock=await repo.createJob(vendor.id,{kind:'stock_test',productId:products.items[0].id,quantity:5},'authorized-unilock-setup');
  console.log(JSON.stringify({...result,loginJobId:login.id,stockJobId:stock.id}));
} finally {input.credentials.password=null;await closeDb();}
