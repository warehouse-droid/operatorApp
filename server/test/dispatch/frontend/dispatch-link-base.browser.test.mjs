import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import v8ToIstanbul from 'v8-to-istanbul';

test('PO and TO submit only the exact base quantity and show the base UOM', async () => {
  const order={id:'SO-LINK-STABILITY',type:'SO',customer:'Isolated customer',sourceYard:'2967',pickupLocations:['2967'],
    address:'30 Isolated Customer Road',items:[{itemId:1784,sku:'PALLET',quantity:16,unit:'EACH',pieces:16}]};
  const requests={po:0,to:0,orders:0};
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(/\.(js|css)$/u.test(url.pathname)) {
      res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':'text/css');
      return res.end(await readFile(new URL(`../../../public${url.pathname}`,import.meta.url)));
    }
    if(!url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type','text/html');
      return res.end('<link rel="stylesheet" href="/dispatch.css"><main id="dispatchApp"></main><script>function requireDispatchLogin(){}</script><script src="/dispatch-address-guard.js"></script><script src="/dispatch-edit-activity.js"></script><script src="/dispatch.js"></script>');
    }
    let result={};
    if(url.pathname==='/api/dispatch/orders') {requests.orders++;result=[order];}
    if(url.pathname.endsWith('/po-allocations')) {requests.po++;result={order:{targetSignature:'same'},salesLines:[],poLines:[],allocations:[]};}
    if(url.pathname==='/api/dispatch/order-dependencies/options') {requests.to++;result={targetSignature:'same',matchingLines:[],transferOrders:[],existingLinks:[]};}
    if(url.pathname.endsWith('/executed-order-reviews')) result={reviews:[]};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
  });
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    if(process.env.PO_COUNT_COVERAGE) await page.coverage.startJSCoverage({resetOnNavigation:false});
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(input=>{
      orders=[normalizeOrder(input)];orderCatalog=structuredClone(orders);trucks=[];fleet=[];
      currentPlanDate=todayLocalDate();currentPlan={id:'link-stability',planDate:currentPlanDate,revision:1,status:'draft',orders:structuredClone(orders),trucks:[]};
      dispatchConfig={plannerOrderPoolMode:'off',plannerCommandMode:'off',googleMapsEnabled:false};
      dispatchSetupLoaded=true;dispatchPlannerSnapshotState='ready';planEditMode=true;
      planEditLeaseToken='test-token';planEditLease={active:true,sessionId:dispatchSessionId,planDate:currentPlanDate};
      localPlanDirty=false;render({save:false});
    },order);
    for(const type of ['po','to']) {
      await page.evaluate(type=>{
        resetActiveLinkModalState();modalType=`${type}-link`;modalOrderId='SO-LINK-STABILITY';
        const draft=getLinkModalDraft(type,modalOrderId);draft.ref=`${type.toUpperCase()}-BASE`;
        const targetLineKey='SO-LINK-STABILITY::1';
        if(type==='po') {
          const candidate={poLineId:10,poRef:'PO-BASE',unitMatch:true,descriptionMatch:true,exactMatch:true};
          poAllocationOptions={targetSignature:'base',salesLines:[{id:1,targetLineKey,itemId:1784,sku:'PALLET',required:{unit:'EACH'},
            available:{salesQty:16,pieces:16},conversions:{},poCandidates:[candidate]}],
            poLines:[{id:10,poRef:'PO-BASE',itemId:1784,required:{unit:'EACH'},available:{salesQty:22,pieces:0}}],allocations:[]};
          applyPoLinkDefaultsForRef(modalOrderId,draft.ref);
        } else {
          orderDependencyOptions={targetSignature:'base',matchingLines:[{targetLineKey,itemId:10374,sku:'PAVER',unit:'SQFT',
            available:{salesQty:5.23,pallets:1,layers:10},suggestedQuantities:{salesQty:5.23},
            transferQuantity:5.23,conversions:{pallets:104.6,layers:10.46}}],existingLinks:[],transferOrders:[]};
        }
        window.requests=[];
        runAtomicDispatchDependencyMutation=async request=>{requests.push(request);return {applied:false,payload:{}};};
        render({save:false,refreshLinkModal:true});
      },type);
      const inputs=page.locator(`[data-${type}-link-qty]`);
      await expect(inputs).toHaveCount(1);
      assert.equal(await inputs.getAttribute(`data-${type}-link-qty`),'salesQty');
      await expect(inputs).toHaveValue(type==='po'?'16':'5.23');
      await expect(inputs.locator('..')).toContainText(type==='po'?'EACH':'SQFT');
      await inputs.fill(type==='po'?'7':'2.615');
      await page.evaluate(type=>document.querySelector(`form[data-form="${type}-link"]`).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})),type);
      await expect.poll(()=>page.evaluate(()=>requests.length)).toBe(1);
      const request=await page.evaluate(()=>requests[0]);
      const payload=request.payload||request.body;
      const lines=payload.lines||payload.allocations;
      assert.equal(lines.length,1);
      assert.equal(lines[0].quantities.salesQty,type==='po'?7:2.615);
      assert.ok(['pallets','layers','sections','pieces'].every(key=>!lines[0].quantities[key]));
    }
    if(process.env.PO_COUNT_COVERAGE) {
      await mkdir('test-artifacts/base-link-browser',{recursive:true});
      await page.screenshot({path:'test-artifacts/base-link-browser/verified.png'});
      for(const entry of (await page.coverage.stopJSCoverage()).filter(entry=>entry.url.endsWith('/dispatch.js'))) {
        const converter=v8ToIstanbul('/app/public/dispatch.js',0,{source:entry.source});
        await converter.load();converter.applyCoverage(entry.functions);
        await writeFile('test-artifacts/base-link-browser/coverage-final.json',JSON.stringify(converter.toIstanbul()));
      }
    }
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
