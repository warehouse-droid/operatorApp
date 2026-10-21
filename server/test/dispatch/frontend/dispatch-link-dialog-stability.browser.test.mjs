import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import v8ToIstanbul from 'v8-to-istanbul';

test('PO and TO dialogs retain DOM, draft, focus and scroll through notices and order-feed updates', async () => {
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
      await page.evaluate(async type=>{
        resetActiveLinkModalState();modalType=`${type}-link`;modalOrderId='SO-LINK-STABILITY';render({save:false});
        if(type==='po')await loadPoAllocationOptions(modalOrderId);else await loadOrderDependencyOptions(orderById(modalOrderId));
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const input=document.getElementById(`${type}LinkRef`);
        input.value=`${type.toUpperCase()}-TYPED-REFERENCE`;input.focus();input.setSelectionRange(3,7);
        captureActiveLinkModalDraft();
        window.keptDialog=document.querySelector('[data-link-modal="true"]');window.keptInput=input;
        const scroll=keptDialog.querySelector('.modal-body');
        scroll.style.height='120px';scroll.style.overflow='auto';scroll.scrollTop=45;
        window.keptScroll=scroll.scrollTop;
        getLinkModalDraft(type,modalOrderId).quantities['SO-LINK-STABILITY::1']={salesQty:'16'};
      },type);
      const initial={...requests};
      const result=await page.evaluate(async type=>{
        routeNotice='Background notice / alert';render({save:false});
        const afterNotice=document.querySelector('[data-link-modal="true"]')===keptDialog;
        await runQueuedDispatchOrderPoolRefresh();
        renderDispatchNoticePatch();renderDispatchExecutionPatch();render({save:false});
        const input=document.getElementById(`${type}LinkRef`);
        return {afterNotice,sameDialog:document.querySelector('[data-link-modal="true"]')===keptDialog,
          sameInput:input===keptInput,focused:document.activeElement===keptInput,value:input.value,
          selection:[input.selectionStart,input.selectionEnd],scroll:keptDialog.querySelector('.modal-body').scrollTop,
          expectedScroll:keptScroll,quantities:getLinkModalDraft(type,modalOrderId).quantities};
      },type);
      assert.equal(result.afterNotice,true,`${type}: notice must not replace the popup`);
      assert.equal(result.sameDialog,true,`${type}: order updates must not replace the popup`);
      assert.equal(result.sameInput,true);assert.equal(result.focused,true);
      assert.equal(result.value,`${type.toUpperCase()}-TYPED-REFERENCE`);
      assert.deepEqual(result.selection,[3,7]);assert.equal(result.scroll,result.expectedScroll);
      assert.equal(result.quantities['SO-LINK-STABILITY::1'].salesQty,'16');
      assert.equal(requests[type],initial[type],`${type}: no background option reload`);
      assert.ok(requests.orders>initial.orders,'order feed still updates');
      await page.locator(`[data-action="${type==='po'?'refresh-po-link-options':'refresh-to-link-match'}"]`).click();
      await expect.poll(()=>requests[type]).toBe(initial[type]+1);
      await expect(page.locator(`#${type}LinkRef`)).toHaveValue(`${type.toUpperCase()}-TYPED-REFERENCE`);
      assert.equal(await page.evaluate(()=>document.querySelector('[data-link-modal="true"]')===keptDialog),false,'explicit refresh is still allowed');
      if(type==='po') {
        // Exercise real click/submit handlers with an accepted server response:
        // deliberate link changes must still repaint the retained dialog.
        await page.evaluate(()=>{
          window.originalAtomicMutation=runAtomicDispatchDependencyMutation;window.linkMutations=[];
          runAtomicDispatchDependencyMutation=async request=>{
            linkMutations.push(request);
            return {applied:true,payload:{allocations:[],options:{order:{targetSignature:'updated'},salesLines:[],poLines:[],allocations:[]}}};
          };
          poAllocationOptions.allocations=[{id:77,poOrderRef:'PO-TYPED-REFERENCE',itemName:'PALLET',salesQty:16}];
          render({save:false,refreshLinkModal:true});
          window.keptDialog=document.querySelector('[data-link-modal="true"]');
        });
        await page.locator('[data-action="cancel-po-link"]').click();
        await expect(page.locator('[data-action="cancel-po-link"]')).toHaveCount(0);
        assert.equal(await page.evaluate(()=>document.querySelector('[data-link-modal="true"]')===keptDialog),false);
        await page.evaluate(()=>{
          poAllocationOptions.allocations=[{id:78,poOrderRef:'PO-TYPED-REFERENCE',itemName:'PALLET',salesQty:16}];
          render({save:false,refreshLinkModal:true});
          window.keptDialog=document.querySelector('[data-link-modal="true"]');
          document.querySelector('form[data-form="po-link"]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
        });
        await expect(page.locator('#poLinkRef')).toHaveValue('');
        assert.equal(await page.evaluate(()=>document.querySelector('[data-link-modal="true"]')===keptDialog),false);
        assert.deepEqual(await page.evaluate(()=>linkMutations.map(request=>request.method)),['DELETE','POST']);
        await page.evaluate(()=>{runAtomicDispatchDependencyMutation=originalAtomicMutation;});
      }
    }
    await page.evaluate(()=>{modalOrderId='SO-SECOND';orders.push({...orders[0],id:modalOrderId});render({save:false});});
    await expect(page.locator('[data-link-modal="true"]')).toContainText('SO-SECOND');
    await page.evaluate(()=>{resetActiveLinkModalState();render({save:false});});
    await expect(page.locator('[data-link-modal="true"]')).toHaveCount(0);
    await mkdir('test-artifacts/link-dialog',{recursive:true});
    await page.screenshot({path:'test-artifacts/link-dialog/verified.png'});
    if(process.env.PO_COUNT_COVERAGE) {
      const coverage=await page.coverage.stopJSCoverage();
      for(const entry of coverage.filter(entry=>entry.url.endsWith('/dispatch.js'))) {
        const converter=v8ToIstanbul('/app/public/dispatch.js',0,{source:entry.source});
        await converter.load();converter.applyCoverage(entry.functions);
        await writeFile('test-artifacts/link-dialog/coverage-final.json',JSON.stringify(converter.toIstanbul()));
      }
    }
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
