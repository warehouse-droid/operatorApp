import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {app} from '../src/server.js';
import {query,closeDb} from '../src/db.js';
import {createOperator} from '../src/auth-repository.js';
import {createSpecialStockCase} from '../src/special-stock-request-repository.js';
if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Use the disposable test runner.');}
let server,browser,base;
const report={refreshes:0};
try {
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key='special_stock_request_workflow'");
  const username='refresh-diagnosis-'+crypto.randomUUID(),password=crypto.randomUUID();
  const actor=await createOperator({username,password,displayName:'TEST Refresh',role:'scm'});
  await createSpecialStockCase({storeLocationId:1,inquiryDate:'2099-01-01',customerName:'TEST Refresh',vendorId:331,vendorName:'Unilock Ltd',fulfillmentMethod:'yard_pickup',lines:[{productName:'Fixture coping',quantity:5,uom:'PCS',rate:10,requiredDate:'2099-02-01'}]}, {operatorId:actor.id,authorizedStoreLocationIds:[1]});
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
  const token=(await (await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})})).json()).token;
  browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});const context=await browser.newContext();
  await context.addInitScript(value=>{localStorage.setItem('mbbs.staff.token',value);localStorage.setItem('mbbs.appSidebar.collapsed','true');},token);
  const page=await context.newPage();await page.goto(base+'/scm/stock-requests?tab=special');
  for(let index=0;index<6;index++) {
    await expect(page.getByRole('heading',{name:'Line responses',exact:true})).toBeVisible();
    await page.reload();report.refreshes++;
  }
  report.passed=true;
} catch(error) {report.error=error.message;report.passed=false;process.exitCode=1;}
finally {
  await fs.writeFile('test-artifacts/stock-check/refresh-diagnosis.json',JSON.stringify(report));console.log(JSON.stringify(report));
  await browser?.close();if(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await closeDb();
}
