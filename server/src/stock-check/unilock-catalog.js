import {chromium} from 'playwright';
import {allowedPortalUrl,UNILOCK_ORIGIN,StockCheckError,sanitizeFailure} from './domain.js';
import {readPortalDocument,selectedProductFromDocument} from './unilock-dom.js';

function checkCancelled(signal) {
  if(signal?.aborted) {throw new StockCheckError('The catalog refresh was cancelled.',409,'STOCK_CHECK_CANCELLED');}
}
async function delay(milliseconds,signal) {
  checkCancelled(signal);
  if(milliseconds>0) {await new Promise(resolve=>setTimeout(resolve,milliseconds));}
  checkCancelled(signal);
}

export async function scrapeUnilockCatalog({baseUrl=UNILOCK_ORIGIN,allowTestOrigin=false,throttleMs=250,retainUnmapped=false,
  signal,onProduct=async()=>{},onStep=async()=>{},onProgress=async()=>{},launchOptions={}}={}) {
  checkCancelled(signal);
  const originOptions={baseUrl,allowTestOrigin};
  const safe=value=>allowedPortalUrl(value,originOptions).href;
  safe('/SearchDWwithAttributes.aspx?SimpleSearchFlag=simple');
  const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],...launchOptions});
  let context;
  const products=[],errors=[],visitedSkus=new Set(),masters=new Map(),listingPages=new Set();
  let seriesVisited=0,coloursVisited=0,variantsSeen=0;
  try {
    context=await browser.newContext({viewport:{width:1280,height:900}});
    const page=await context.newPage();
    async function fetchDocument(url,fields=null,event='') {
      await delay(throttleMs,signal);
      let target=safe(url),response;
      for(let redirect=0;redirect<9;redirect++) {
        response=fields===null?await context.request.get(target,{timeout:30000,maxRedirects:0}):
          await context.request.post(target,{form:{...fields,__EVENTTARGET:event,__EVENTARGUMENT:''},timeout:30000,maxRedirects:0});
        const location=response.headers().location;
        if(![301,302,303,307,308].includes(response.status()) || !location) {break;}
        target=safe(new URL(location,target).href); fields=null;
      }
      if(!response.ok()) {throw new StockCheckError('The vendor catalog page returned HTTP '+response.status()+'.',502,'STOCK_CHECK_PORTAL_HTTP');}
      const html=await response.text();
      if(Buffer.byteLength(html)>8*1024*1024) {throw new StockCheckError('The vendor catalog page exceeded the supported size.');}
      const doc=await readPortalDocument(page,html);
      doc.url=target; return doc;
    }
    async function reportFailure(detail) {
      errors.push(detail);
      await onStep({key:'catalog_variant',status:'failure',detail:detail.reason,sku:detail.sku??null,url:detail.url});
    }
    async function progress(current='') {
      await onProgress({seriesTotal:masters.size,seriesVisited,coloursVisited,variantsSeen,imported:products.length,failed:errors.length,current});
    }
    async function addVariant(sku,masterUrl) {
      if(!sku || visitedSkus.has(sku)) {return;}
      visitedSkus.add(sku); variantsSeen++;
      const source=new URL(masterUrl); source.searchParams.set('child',sku);
      let product;
      try {
        const doc=await fetchDocument(source.href);
        product=selectedProductFromDocument(doc,{productUrl:source.href,expectedSku:sku,...originOptions,allowUnmappedPickup:retainUnmapped});
      } catch(error) {
        if(error.code==='STOCK_CHECK_CANCELLED') {throw error;}
        await reportFailure({sku,url:source.href,reason:sanitizeFailure(error)}); await progress(sku); return;
      }
      product.scrapedAt=new Date().toISOString();
      if(product.pickupNeedsReview) {
        await reportFailure({sku,url:source.href,reason:product.pickupLocation?
          'Displayed plant '+product.pickupLocation+' is outside the Ontario pickup choices. SCM pickup review is required.':
          'The selected product has no displayed pickup point. SCM pickup review is required.'});
      }
      await onProduct(product); products.push(product); await progress(sku);
    }
    function collectMasters(doc,url) {
      for(const product of doc.products) {
        let parsed;
        try {parsed=new URL(safe(new URL(product.url,url).href));} catch {continue;}
        if(!/^\/products\/products\/[a-z0-9-]+$/iu.test(parsed.pathname)) {continue;}
        parsed.search='';masters.set(parsed.href,product.name);
      }
    }
    async function discoverListings() {
      const pending=['/SearchDWwithAttributes.aspx?SimpleSearchFlag=simple'];
      while(pending.length) {
        const url=safe(pending.shift());
        if(listingPages.has(url)) {continue;}
        if(listingPages.size>=100) {throw new StockCheckError('Catalog pagination exceeded the supported limit; refresh was stopped.');}
        listingPages.add(url);
        let doc=await fetchDocument(url);
        const pageSize=doc.selects.find(select=>/PageSize/iu.test(select.id) && select.options.some(option=>option.value==='200'));
        if(pageSize && pageSize.value!=='200') {
          doc=await fetchDocument(new URL(doc.formAction||url,url).href,{...doc.fields,[pageSize.name]:'200'},pageSize.name);
        }
        collectMasters(doc,url);
        for(const next of doc.pagination.filter(row=>/next/iu.test(row.label))) {
          if(next.url && !next.url.startsWith('javascript:')) {pending.push(new URL(next.url,url).href);}
          else if(next.event) {
            const another=await fetchDocument(new URL(doc.formAction||url,url).href,doc.fields,next.event);
            collectMasters(another,url);
          }
        }
      }
      if(!masters.size) {throw new StockCheckError('No product series were returned by the vendor catalog.',502,'STOCK_CHECK_CATALOG_EMPTY');}
      await onStep({key:'catalog_listing',status:'success',detail:'Found '+masters.size+' product series across '+listingPages.size+' listing pages.'});
    }
    async function visitColours(doc,masterUrl) {
      const colours=doc.colours.map(row=>({event:row.event,id:row.id}));
      for(const colour of colours) {
        checkCancelled(signal);
        let selected;
        try {
          if(!/\$rptFinish\$.*\$colorFinishId$/u.test(colour.event)) {throw new StockCheckError('The colour control could not be identified.');}
          selected=await fetchDocument(new URL(doc.formAction||masterUrl,masterUrl).href,doc.fields,colour.event);
        } catch(error) {
          if(error.code==='STOCK_CHECK_CANCELLED') {throw error;}
          await reportFailure({url:masterUrl,reason:sanitizeFailure(error)});continue;
        }
        doc=selected; coloursVisited++;
        for(const child of doc.children) {await addVariant(child.sku,masterUrl);}
      }
      return {doc,colours};
    }
    async function visitMasters() {
      for(const [masterUrl,name] of masters) {
        checkCancelled(signal);
        let doc;
        try {doc=await fetchDocument(masterUrl);}
        catch(error) {
          if(error.code==='STOCK_CHECK_CANCELLED') {throw error;}
          await reportFailure({url:masterUrl,reason:sanitizeFailure(error)});seriesVisited++;continue;
        }
        for(const child of doc.children) {await addVariant(child.sku,masterUrl);}
        if(doc.selected?.sku) {await addVariant(doc.selected.sku,masterUrl);}
        const result=await visitColours(doc,masterUrl);doc=result.doc;
        if(!result.colours.length && !doc.children.length && !doc.selected?.sku) {
        await reportFailure({url:masterUrl,reason:'No selectable colour/size variants were returned for '+name+'.'});
      }
      seriesVisited++; await progress(name);
      await onStep({key:'catalog_series',status:'success',detail:'Read selected variant labels for '+name+'.',url:masterUrl});
      }
    }
    await discoverListings();await progress();await visitMasters();
    return {products,errors,summary:{seriesTotal:masters.size,seriesVisited,coloursVisited,variantsSeen,imported:products.length,failed:errors.length}};
  } finally {await context?.close().catch(()=>{});await browser.close();}
}
