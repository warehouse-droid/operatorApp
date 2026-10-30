import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { MBT_ADMIN_GATE_DEFINITIONS } from '../src/mbt/feature-gate-catalog.js';

const root=process.argv[2]||'.';
const file=path.join(root,'public/mbt-gates.js');
const source=fs.readFileSync(file,'utf8');
const browser=await chromium.launch({args:['--no-sandbox']});
try{
  for(const width of [390,1280]){
    const page=await browser.newPage({viewport:{width,height:900}});
    const errors=[],writes=[];
    page.on('pageerror',error=>errors.push(error.message));
    const gates=MBT_ADMIN_GATE_DEFINITIONS.filter(gate=>gate.gateGroup==='operator_netsuite_posting')
      .map(gate=>({...gate,configured:false,effective:false,environmentAllowed:true,revision:1}));
    const inventory={gates,netSuiteDirectAccessAllowed:true,environmentRootAllowed:true};
    await page.route('https://exchange-gates.invalid/**',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.pathname==='/'){return route.fulfill({contentType:'text/html; charset=utf-8',body:
        '<!doctype html><meta charset="utf-8"><section class="mbt-status"></section><input id="gateReason"><div id="operatorNetSuiteGateMatrix"></div><div id="gateList"></div><script>localStorage.setItem("mbbs.staff.token","synthetic-exchange-gate-token")</script><script src="/mbt-gates.js"></script>'});}
      if(url.pathname==='/mbt-gates.js'){return route.fulfill({contentType:'application/javascript; charset=utf-8',body:source});}
      let body={};
      if(url.pathname==='/api/auth/me'){body={operator:{role:'admin',roles:['admin']}};}
      if(url.pathname==='/api/mbt/config/gates'){body=inventory;}
      if(request.method()==='PUT'){
        const key=decodeURIComponent(url.pathname.split('/').at(-1));
        const gate=gates.find(candidate=>candidate.flagKey===key),input=request.postDataJSON();
        assert.ok(gate);assert.equal(input.expectedRevision,gate.revision);
        assert.equal(input.reason,'Enable stock exchange posting');
        assert.ok(request.headers()['idempotency-key']);
        writes.push({key,enabled:input.enabled});
        gate.configured=input.enabled;gate.effective=input.enabled&&gate.environmentAllowed;gate.revision++;
        body={flag:gate};
      }
      return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.goto('https://exchange-gates.invalid/');
    const matrix=page.locator('#operatorNetSuiteGateMatrix');
    await expect(matrix.locator('thead th')).toHaveText(['Yard','Customer Pickup → IF','Receiving → IR','Delivery Prep → IF','Stock Return → CM','Pallet Return → CM','Stock exchange → IT']);
    await expect(matrix.locator('[data-gate-toggle*="_stock_exchange_it_"]')).toHaveCount(3);
    await expect(matrix.locator('[data-gate-toggle*="_return_cm_"]')).toHaveCount(8);
    await expect(matrix.locator('[data-gate-toggle*="_return_ra_"]')).toHaveCount(0);
    await expect(matrix.locator('tbody tr').filter({has:page.locator('th',{hasText:'12441'})}).locator('td').last()).toHaveText('Not available');
    const button=yard=>matrix.locator(`[data-gate-toggle="operator_netsuite_stock_exchange_it_${yard}"]`);
    await button('3445').click();
    await expect(page.locator('.mbt-status')).toContainText('Audit reason required');
    assert.equal(writes.length,0);
    await page.locator('#gateReason').fill('Enable stock exchange posting');
    for(const yard of ['3445','2967','150']){
      await button(yard).click();await expect(button(yard)).toHaveText('Turn off');
      await expect(button(yard).locator('..')).toContainText('Creates IT');
    }
    await button('3445').click();await expect(button('3445')).toHaveText('Turn on');
    await expect(button('3445').locator('..')).toContainText('Local only');
    assert.deepEqual(writes,[...['3445','2967','150'].map(yard=>({key:`operator_netsuite_stock_exchange_it_${yard}`,enabled:true})),
      {key:'operator_netsuite_stock_exchange_it_3445',enabled:false}]);
    assert.ok(gates.filter(gate=>gate.operatorFunction!=='stock_exchange').every(gate=>!gate.configured));
    assert.deepEqual(errors,[]);
    await page.close();
    console.log(`Exchange admin controls ${width}px: three yards, audit reason, exact switch writes, state readback and existing controls passed`);
  }
}finally{await browser.close();}
assert.equal(fs.readFileSync(file,'utf8'),source);
console.log(JSON.stringify({passed:true,sourceHash:createHash('sha256').update(source).digest('hex')}));
