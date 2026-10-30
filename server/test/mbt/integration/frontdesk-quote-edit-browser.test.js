import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {app} from '../../../src/server.js';
import {config} from '../../../src/config.js';
import {query,closeDb} from '../../../src/db.js';
import {createOperator,loginOperator} from '../../../src/auth-repository.js';
import {createFrontdeskQuote,issueFrontdeskQuote} from '../../../src/mbt/frontdesk-service.js';
import {createFrontdeskPrerequisites,frontdeskDistanceResolver,frontdeskTaxResolver} from '../support/frontdesk-fixtures.js';
import {withBrowserCoverageSources} from '../support/browser-source-coverage.js';
after(closeDb);
test('draft quote browser: edit restores inputs, cancel keeps draft, recalculate retains number, issue removes edit',{timeout:90000},async()=>{
  const f=await createFrontdeskPrerequisites({label:crypto.randomUUID()}),username=`quote-edit-${crypto.randomUUID()}`,password='synthetic-quote-browser-password';
  const operator=await createOperator({username,displayName:'Quote editor',password,roles:['mbt_frontdesk']});
  const actor={operatorId:String(operator.id),roles:['mbt_frontdesk']};
  const token=(await loginOperator(username,password)).token;
  config.mbt.enabled=true;config.mbtPhase3.frontdeskOperationsEnabled=true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_frontdesk_operations')");
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let browser;
  try {
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});
    const context=await browser.newContext({timezoneId:'UTC'});await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),token);
    const page=await context.newPage();page.setDefaultTimeout(10000);await page.coverage.startJSCoverage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    // Replace only the external pricing adapters; use the real quote services.
    await page.route('**/api/mbt/frontdesk/quotes**',async route=>{
      const parts=new URL(route.request().url()).pathname.split('/'),quoteId=parts[5],input={...route.request().postDataJSON(),actor,
        ...(quoteId?{quoteId}:{}),idempotencyKey:route.request().headers()['idempotency-key'],correlationId:crypto.randomUUID(),requestId:crypto.randomUUID()};
      try {
        const result=parts[6]==='issue'?await issueFrontdeskQuote(input):await createFrontdeskQuote(input,{resolveDistance:frontdeskDistanceResolver(f),resolveTaxPolicy:frontdeskTaxResolver});
        await route.fulfill({status:result.status,json:result.body});
      } catch(error) {await route.fulfill({status:error.status || 500,json:{error:error.message,code:error.code}});}
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/mbt/frontdesk`);
    await expect(page.locator('#openNewContractOrder')).toBeEnabled();
    await page.locator('#customerSearch').fill(f.marker);await page.locator('#customerResults button').first().click();
    await page.locator('#openNewContractOrder').click();await page.locator('#orderKind').selectOption('bin');await page.locator('#createQuoteButton').click();
    const dialog=page.locator('#customerChargeDialog');
    await dialog.locator('#chargeServiceCode').selectOption(f.rateCardVersionId);
    await dialog.locator('#binContentCode').selectOption('garbage');await dialog.locator('#chargeBinType').selectOption('14YD');
    await dialog.locator('#chargeDeliveryItemCode').selectOption(f.deliveryItemCode);
    await dialog.locator('#chargeDeliveryAt').fill('2037-08-03T12:00');await dialog.locator('#chargeReturnAt').fill('2037-08-17T12:00');
    await dialog.locator('#billingAddressText').fill('100 Billing Road');await dialog.locator('#serviceAddressText').fill('200 Site Road');await dialog.locator('#contractTelephone').fill('4165550123');
    await dialog.locator('#previewCustomerCharge').click();await expect(dialog).not.toBeVisible();
    const number=await page.locator('#quoteCard h2').textContent();
    await page.getByRole('button',{name:'Edit quote',exact:true}).click();
    await expect(dialog.locator('#binContentCode')).toHaveValue('garbage');await expect(dialog.locator('#chargeBinType')).toHaveValue('14YD');
    await expect(dialog.locator('#billingAddressText')).toHaveValue('100 Billing Road');await expect(dialog.locator('#chargeDeliveryAt')).toHaveValue('2037-08-03T12:00');
    await dialog.locator('#binDiscountCad').fill('50');await dialog.locator('#binDiscountReason').fill('Agreed discount');
    await dialog.getByRole('button',{name:'Close customer charge dialog',exact:true}).click();await expect(page.locator('#quoteCard h2')).toHaveText(number);
    await page.getByRole('button',{name:'Edit quote',exact:true}).click();await expect(dialog.locator('#binDiscountCad')).toHaveValue('0');
    await dialog.locator('#binDiscountCad').fill('50');await dialog.locator('#binDiscountReason').fill('Agreed discount');
    await dialog.locator('#previewCustomerCharge').click();await expect(dialog).not.toBeVisible();
    await expect(page.locator('#quoteCard h2')).toHaveText(number);await expect(page.locator('#quoteCard')).toContainText('Revision 2');
    await expect(page.locator('#quoteCard')).toContainText('425.00');
    await page.getByRole('button',{name:'Issue quote',exact:true}).click();await expect(page.locator('#quoteCard')).toContainText('ISSUED');
    await expect(page.getByRole('button',{name:'Edit quote',exact:true})).toHaveCount(0);assert.deepEqual(errors,[]);
    writeFileSync('test-artifacts/quote-edit-browser-v8.json',JSON.stringify(await withBrowserCoverageSources(page,await page.coverage.stopJSCoverage())));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
