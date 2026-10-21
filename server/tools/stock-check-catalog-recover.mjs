import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {allowedPortalUrl} from '../src/stock-check/domain.js';
import {readPortalDocument,selectedProductFromDocument} from '../src/stock-check/unilock-dom.js';
const dir=process.argv[2];
let summary=JSON.parse(await fs.readFile(path.join(dir,'summary.json'),'utf8'));
let products=JSON.parse(await fs.readFile(path.join(dir,'products.json'),'utf8'));
try {
  const recovery=JSON.parse(await fs.readFile(path.join(dir,'recovery.json'),'utf8'));
  summary={...summary,errors:recovery.failures};products=JSON.parse(await fs.readFile(path.join(dir,'products-complete.json'),'utf8'));
} catch(error) {if(error.code!=='ENOENT') {throw error;}}
const browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});
const failures=[];let recovered=0;
try {
  const context=await browser.newContext();const page=await context.newPage();
  for(const error of summary.errors) {
    try {
      const url=allowedPortalUrl(error.url).href;
      const response=await context.request.get(url,{timeout:30000,maxRedirects:0});
      if(!response.ok()) {throw new Error('HTTP '+response.status());}
      const doc=await readPortalDocument(page,await response.text());
      const product=selectedProductFromDocument(doc,{productUrl:url,expectedSku:error.sku,allowUnmappedPickup:true});
      products.push({...product,scrapedAt:new Date().toISOString()});recovered++;
    } catch(cause) {failures.push({...error,reason:cause.message});}
    if(recovered%20===0) {console.log(JSON.stringify({recovered,failed:failures.length}));}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  const unique=[...new Map(products.map(row=>[row.sku,row])).values()];
  await fs.writeFile(path.join(dir,'products-complete.json'),JSON.stringify(unique,null,2)+'\n');
  await fs.writeFile(path.join(dir,'recovery.json'),JSON.stringify({finishedAt:new Date().toISOString(),imported:unique.length,
    pickupNeedsReview:unique.filter(row=>row.pickupNeedsReview).length,failures},null,2)+'\n');
  console.log(JSON.stringify({finished:true,imported:unique.length,recovered,failures:failures.length}));
} finally {await browser.close();}
