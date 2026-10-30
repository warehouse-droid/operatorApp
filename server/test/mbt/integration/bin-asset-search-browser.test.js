import test from 'node:test';
import {readFileSync,writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';

test('BIN search: 205 choices, unavailable bins hidden, selection retained, keyboard and empty results',async()=>{
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try {
    const page=await browser.newPage();
    await page.coverage.startJSCoverage();
    await page.setContent('<form><label>Physical bin<select required><option value="">Choose bin</option></select></label><button>Save</button></form>');
    await page.evaluate(()=>{
      const select=document.querySelector('select');
      for(let i=1;i<=205;i++) select.add(new Option(`BIN-${String(i).padStart(3,'0')} · 20YD · Yard ${i%2?'3445':'150'}`,String(i)));
      const unavailable=new Option('UNAVAILABLE · 20YD · 3445','unavailable');unavailable.disabled=true;select.add(unavailable);
      window.submissions=0;document.querySelector('form').onsubmit=event=>{event.preventDefault();window.submissions++;};
    });
    // The feature must exist on the real planning page as well as this 200+ bin fixture.
    const html=readFileSync('public/mbt-planning.html','utf8');
    const script=html.match(/src="(\/bin-asset-search\.js)[^"]*"/);
    expect(script,'Planning loads the shared searchable bin control').not.toBeNull();
    await page.route('http://bin-search.test/bin-asset-search.js',route=>route.fulfill({contentType:'text/javascript',body:readFileSync(`public${script[1]}`,'utf8')}));
    await page.addScriptTag({url:'http://bin-search.test/bin-asset-search.js'});
    await page.evaluate(()=>BinAssetSearch.attach(document.querySelector('select')));
    const search=page.getByRole('searchbox',{name:'Search bins'}),select=page.getByLabel('Physical bin');
    await expect(select.locator('option')).toHaveCount(206);
    await expect(select.locator('[value="unavailable"]')).toHaveCount(0);
    await search.fill('bin-205');await expect(select.locator('option')).toHaveText(['Choose bin','BIN-205 · 20YD · Yard 3445']);
    await select.selectOption('205');await search.fill('no such bin');
    await expect(select).toHaveValue('205');await expect(page.locator('[data-bin-search-status]')).toContainText('No matching bins');
    await search.press('Enter');expect(await page.evaluate(()=>window.submissions)).toBe(0);
    await search.fill('20yd 150');await expect(select.locator('option')).toHaveCount(104);
    await select.selectOption('204');await search.fill('');await expect(select).toHaveValue('204');
    await expect(select.locator('option')).toHaveCount(206);
    await page.getByRole('button',{name:'Save'}).click();expect(await page.evaluate(()=>window.submissions)).toBe(1);
    await search.fill('<img src=x onerror=alert(1)>');await expect(page.locator('img')).toHaveCount(0);
    writeFileSync('test-artifacts/bin-asset-search-browser-v8.json',JSON.stringify(await page.coverage.stopJSCoverage()));
  } finally {await browser.close();}
});
