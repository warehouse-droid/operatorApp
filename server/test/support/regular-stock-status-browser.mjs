import {expect} from '@playwright/test';
const active=['pending_scm','pending_sales','waiting_stock','in_progress'];
const choices=value=>value==='active'?active:value==='all'?[]:value.split(',');
export async function expectRegularStatuses(page,role,value){
  await expect.poll(()=>page.locator(`[data-${role}-stock-filter="unifiedStatus"]:checked`).evaluateAll(inputs=>inputs.map(input=>input.value))).toEqual(choices(value));
}
export async function chooseRegularStatuses(page,role,value){
  const menu=page.locator('[data-yard-filter="unifiedStatus"]');
  if(!await menu.evaluate(el=>el.open))await menu.locator('summary').click();
  await menu.locator('[data-yard-filter-clear]').click();
  await expectRegularStatuses(page,role,'all');
  if(!await menu.evaluate(el=>el.open))await menu.locator('summary').click();
  for(const status of choices(value))await menu.locator(`[value="${status}"]`).check();
  await menu.locator('[data-yard-filter-apply]').click();
  await expectRegularStatuses(page,role,value);
}
export async function dismissRegularAlerts(page){
  page.setDefaultTimeout(10000);
  await page.addLocatorHandler(page.locator('.regular-stock-popup[open]'),async()=>{
    for(let count=0;count<300&&await page.locator('.regular-stock-popup[open]').count();count++){
      await page.locator('.regular-stock-popup[open] button').click();
    }
  });
}
