import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';

const base='https://test.mbbsoperation.com';
const report={passed:false,base,pageErrors:[],serverErrors:[],checks:[]};
const browser=await chromium.launch({args:['--no-sandbox']});
try {
 const page=await browser.newPage({viewport:{width:390,height:844}});
 page.on('pageerror',error=>report.pageErrors.push(error.message));
 page.on('response',response=>{if(response.url().startsWith(base)&&response.status()>=500)report.serverErrors.push({path:new URL(response.url()).pathname,status:response.status()});});
 const start=Date.now();
 await page.goto(base+'/',{waitUntil:'domcontentloaded'});
 await expect(page.locator('[name=username]')).toBeVisible();
 await expect(page.locator('[name=password]')).toBeVisible();
 await expect(page.locator('button[type=submit]')).toBeEnabled();
 report.checks.push({name:'Public staff login form renders',ms:Date.now()-start});
 await page.locator('[name=username]').fill('smoke-nonexistent-'+randomUUID());
 await page.locator('[name=password]').fill('invalid-smoke-probe');
 const staff=page.waitForResponse(response=>response.url()===base+'/api/auth/login');
 const driver=page.waitForResponse(response=>response.url()===base+'/api/driver/login');
 await page.locator('button[type=submit]').click();
 assert.equal((await staff).status(),401);assert.equal((await driver).status(),401);
 await expect(page.locator('.login-notice')).toBeVisible();
 await expect(page.locator('button[type=submit]')).toBeEnabled();
 report.checks.push({name:'Nonexistent credentials return an error and leave the login form usable'});
 await page.screenshot({path:'test-artifacts/operator-responsiveness/public-login.png'});
 await page.reload({waitUntil:'domcontentloaded'});
 await expect(page.locator('[name=username]')).toBeVisible();
 await page.goto(base+'/driver',{waitUntil:'domcontentloaded'});
 await expect(page.locator('#driverLogin')).toBeVisible();
 await expect(page.locator('#driverPassword')).toBeVisible();
 report.checks.push({name:'Public Driver login renders'});
 assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.serverErrors,[]);
 report.passed=true;
 console.log(JSON.stringify(report));
} catch(error) {report.error=error.stack;throw error;}
finally {
 report.finishedAt=new Date().toISOString();
 writeFileSync('test-artifacts/operator-responsiveness/public-login-smoke.json',JSON.stringify(report,null,2));
 await browser.close();
}
