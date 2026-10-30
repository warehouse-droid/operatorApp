import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {app} from '../../../src/server.js';
import {closeDb} from '../../../src/db.js';
import {getDriverDayJobs} from '../../../src/driver-repository.js';
import {getBinOrderWorkflow} from '../../../src/mbt/bin-order-workflow-service.js';
import {cargoFixture,saveCargo} from '../support/bin-cargo-fixtures.js';
import {run} from '../support/bin-planning-fixtures.js';
import {availableDriverExecutionPlanDate} from '../support/driver-bin-fixtures.js';
import {withBrowserCoverageSources} from '../support/browser-source-coverage.js';
after(closeDb);
test('driver browser: cargo pickup and destination show material quantity, action and physical BIN',{timeout:60000},async()=>{
  const f=await cargoFixture({ordered:true,planDate:await availableDriverExecutionPlanDate()});await saveCargo(f);
  const part=(await getBinOrderWorkflow(f.frontVisitId)).parts[0];
  await run(f,'assign',{visitId:part.visitId,expectedVisitRevision:part.revision});await run(f,'confirm');
  const jobs=(await getDriverDayJobs(f.driverLogin,{date:f.planDate,allowBin:true})).jobs.filter(j=>j.mbt);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:'/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();await page.coverage.startJSCoverage({resetOnNavigation:false});
    await page.goto(`http://127.0.0.1:${server.address().port}/driver`);
    await page.waitForFunction(()=>typeof renderDriverBinSummary==='function' && window.DriverBinUI);
    for(const job of jobs) {
      const label=await page.evaluate(job=>{
        document.querySelector('[data-cargo-test]')?.remove();const element=document.createElement('section');element.dataset.cargoTest='';
        element.innerHTML=renderDriverBinSummary({...job,status:'pending'});document.body.append(element);return driverBinActionLabel(job);
      },job);
      assert.equal(label,job.mbt.actionName);
      await expect(page.locator('[data-cargo-test]')).toContainText(f.assetCode);
      await expect(page.locator('[data-cargo-test]')).toContainText(part.reference);
      if(job.mbt.actionCode!=='collect_empty_bin') {
        await expect(page.locator('[data-cargo-test]')).toContainText('Gravel');await expect(page.locator('[data-cargo-test]')).toContainText('2600 lb');
        await expect(page.locator('[data-cargo-test]')).toContainText('1 yd³');
      }
    }
    writeFileSync('test-artifacts/bin-cargo-driver-browser-v8.json',JSON.stringify(await withBrowserCoverageSources(page,await page.coverage.stopJSCoverage())));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
