import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {app} from '../../../src/server.js';
import {config} from '../../../src/config.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator,loginOperator} from '../../../src/auth-repository.js';
import {rental} from '../support/bin-collection-request-fixtures.js';
import {nextVersion} from '../support/frontdesk-current-actions-fixtures.js';
import {withBrowserCoverageSources} from '../support/browser-source-coverage.js';
after(closeDb);
test('an open Front Desk page refreshes action configuration after a rate changes',{timeout:90000},async()=>{
  const f=await rental(false,'garbage'),current=await nextVersion(f);
  const username=`action-rate-${crypto.randomUUID()}`,password='synthetic-current-action-password';
  await createOperator({username,displayName:'Rate browser',password,roles:['mbt_frontdesk']});
  const token=(await loginOperator(username,password)).token;
  config.mbt.enabled=true;config.mbtPhase3.frontdeskOperationsEnabled=true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_frontdesk_operations')");
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let browser;
  try {
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});
    const context=await browser.newContext({timezoneId:'UTC'});await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),token);
    const page=await context.newPage();page.setDefaultTimeout(10000);await page.coverage.startJSCoverage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/mbt/frontdesk`);
    await expect(page.locator('#openNewContractOrder')).toBeEnabled();
    await page.locator('#customerSearch').fill(f.marker);await page.locator('#customerResults button').first().click();
    await page.getByRole('button',{name:new RegExp(f.contract.contractNumber)}).click();
    for(const turn of [0,1]) {
      const version=turn===0 ? current : await nextVersion(f,45000);
      const response=page.waitForResponse(r=>r.url().includes('/customer-charge/configuration?'));
      await page.getByRole('button',{name:'Add bin',exact:true}).click();
      const configResponse=await response;
      assert.equal(new URL(configResponse.url()).searchParams.get('contractId'),f.contractId);
      assert.equal((await configResponse.json()).rateCardVersionId,version);
      await expect(page.locator('#customerChargeDialog')).toBeVisible();
      await page.getByRole('button',{name:'Close customer charge dialog',exact:true}).click();
    }
    const latest=await nextVersion(f,55000);
    await page.locator('#openNewContractOrder').click();await page.locator('#orderKind').selectOption('bin');
    await page.locator('#createQuoteButton').click();
    await expect(page.locator(`#chargeServiceCode option[value="${latest}"]`)).toHaveCount(1);
    await page.getByRole('button',{name:'Close customer charge dialog',exact:true}).click();
    assert.deepEqual(errors,[]);
    writeFileSync('test-artifacts/frontdesk-current-actions-browser-v8.json',JSON.stringify(await withBrowserCoverageSources(page,await page.coverage.stopJSCoverage())));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
