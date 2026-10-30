import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {app} from '../../../src/server.js';
import {config} from '../../../src/config.js';
import {query,closeDb} from '../../../src/db.js';
import {updateOperatorPassword,loginOperator} from '../../../src/auth-repository.js';
import {applyLocalMasterDataRows} from '../../../src/mbt/local-master-data-service.js';
import {previewMasterDataImport,applyMasterDataImport} from '../../../src/mbt/master-data-import-service.js';
import {withBrowserCoverageSources} from '../support/browser-source-coverage.js';
after(closeDb);

test('browser: create dump site 3445, retain hours/items on edit, and explain invalid input',{timeout:65000},async()=>{
  const id=`dump-browser-${crypto.randomUUID()}`,actor={operatorId:id,roles:['admin']};
  await query(`INSERT INTO operators(id,username,display_name,password_hash,password_salt,role,roles)
    VALUES($1,$1,'Dump-site browser admin','placeholder','placeholder','admin',ARRAY['admin'])`,[id]);
  await updateOperatorPassword(id,'dump-browser-password');
  const token=(await loginOperator(id,'dump-browser-password')).token;
  config.mbt.enabled=true;config.mbtPhase3.masterDataEnabled=true;
  await query("UPDATE mbt_feature_flags SET enabled=true WHERE flag_key IN ('mbt_enabled','mbt_master_data')");
  await applyLocalMasterDataRows({actor,resource:'local_items',sourceKind:'manual',rows:[{
    itemCode:'DUMPTEST',displayName:'Test dump material',description:'',itemType:'dump',chargeBasis:'per_tonne',
    rentalPeriodDays:null,applicableServiceTypes:['dump_return'],applicableLegacySourceTypes:[],
    binTypeCode:null,netSuiteMappingLocalKey:null,active:true}],reason:'Disposable browser fixture',
    idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:'/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',args:['--no-sandbox','--disable-dev-shm-usage']});
    const context=await browser.newContext({viewport:{width:1450,height:1000}});context.setDefaultTimeout(10000);
    await context.addInitScript(token=>localStorage.setItem('mbbs.staff.token',token),token);
    const page=await context.newPage();await page.coverage.startJSCoverage({resetOnNavigation:false});
    await page.goto(`http://127.0.0.1:${server.address().port}/mbt/config`);
    await page.getByRole('tab',{name:'Dump Sites',exact:true}).click();
    await expect(page.locator('[data-dump-acceptance-item][value="DUMPTEST"]')).toBeVisible();
    await page.locator('#dumpSiteCode').fill('3445');await page.locator('#dumpSiteName').fill('Numeric-code dump site');
    await page.locator('#dumpSiteAddress').fill('3445 Test Road');
    await page.locator('[data-dump-acceptance-item][value="DUMPTEST"]').check();
    await page.locator('#saveDumpSiteButton').click();
    await expect(page.locator('#masterDataMessage')).toHaveText('Dump site created.');
    const row=page.locator('#dumpSiteRows tr').filter({hasText:'Numeric-code dump site'});
    await expect(row).toContainText('3445');await expect(row).toContainText('DUMPTEST');
    await row.getByRole('button',{name:'Edit',exact:true}).click();
    await expect(page.locator('#dumpSiteCode')).toHaveValue('3445');await expect(page.locator('#dumpSiteCode')).toHaveAttribute('readonly','');
    await expect(page.locator('[data-dump-acceptance-item][value="DUMPTEST"]')).toBeChecked();
    await page.locator('#dumpSiteName').fill('Numeric-code dump revised');await page.locator('#dumpSiteReason').fill('Update test site');
    await page.locator('#saveDumpSiteButton').click();await expect(page.locator('#masterDataMessage')).toHaveText('Dump site updated.');
    const stored=(await query(`SELECT s.dump_site_code,s.display_name,s.revision,
      (SELECT count(*)::int FROM mbt_dump_site_opening_hours h WHERE h.dump_site_id=s.dump_site_id) AS days
      FROM mbt_dump_sites s WHERE dump_site_code='3445'`)).rows[0];
    assert.deepEqual(stored,{dump_site_code:'3445',display_name:'Numeric-code dump revised',revision:'2',days:5});
    await page.locator('#dumpSiteCode').fill('BAD CODE');await page.locator('#dumpSiteName').fill('Retained input');
    await page.locator('[data-dump-acceptance-item][value="DUMPTEST"]').check();
    let submissions=0;page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/mbt/config/dump-sites') submissions++;});
    await page.locator('#saveDumpSiteButton').click();await expect(page.locator('#masterDataMessage')).toContainText('code');
    assert.equal(submissions,0);await expect(page.locator('#dumpSiteName')).toHaveValue('Retained input');
    await page.locator('#dumpSiteCode').fill('north-dump');
    const monday=page.locator('.mbt-dump-hours-row').first();await monday.locator('[data-dump-closes]').fill('06:00');
    await page.locator('#saveDumpSiteButton').click();await expect(page.locator('#masterDataMessage')).toContainText('closing time');
    assert.equal(submissions,0);await monday.locator('[data-dump-closes]').fill('17:00');
    await page.locator('#saveDumpSiteButton').click();await expect(page.locator('#masterDataMessage')).toHaveText('Dump site created.');
    await expect(page.locator('#dumpSiteRows')).toContainText('NORTH-DUMP');
    const hyphenRow=page.locator('#dumpSiteRows tr').filter({hasText:'NORTH-DUMP'});
    await hyphenRow.getByRole('button',{name:'Inactivate',exact:true}).click();
    await expect(hyphenRow).toContainText('Inactive');
    await hyphenRow.getByRole('button',{name:'Activate',exact:true}).click();
    await expect(hyphenRow.getByRole('button',{name:'Inactivate',exact:true})).toBeVisible();
    page.once('dialog',dialog=>dialog.accept());await hyphenRow.getByRole('button',{name:'Delete',exact:true}).click();
    await expect(page.locator('#masterDataMessage')).toHaveText('Unused dump site deleted.');
    assert.equal((await query("SELECT count(*)::int AS count FROM mbt_dump_sites WHERE dump_site_code='NORTH-DUMP'")).rows[0].count,0);
    const imported=await previewMasterDataImport({actor,resource:'dump_sites',sourceKind:'csv',fileName:'dump-sites.csv',
      content:Buffer.from('dump_site_code,display_name,country_code,item_code,accepted,scale_ticket_required,active\n2967,Numeric CSV site,CA,DUMPTEST,true,true,true\n150-yard,Hyphen CSV site,CA,DUMPTEST,true,true,true'),
      defaults:{sourceAccountId:'local'},correlationId:crypto.randomUUID(),requestId:crypto.randomUUID()});
    const applied=await applyMasterDataImport({actor,resource:'dump_sites',batchId:imported.batchId,normalizedHash:imported.normalizedHash,
      targetRevisionToken:imported.targetRevisionToken,reason:'Verify numeric CSV sites',idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID()});
    assert.deepEqual(applied.body.counts,{created:2,updated:0,unchanged:0,conflicted:0});
    assert.deepEqual((await query("SELECT dump_site_code FROM mbt_dump_sites WHERE dump_site_code IN ('2967','150-YARD') ORDER BY dump_site_code")).rows,
      [{dump_site_code:'150-YARD'},{dump_site_code:'2967'}]);
    writeFileSync('test-artifacts/dump-site-browser-v8.json',JSON.stringify(await withBrowserCoverageSources(page,await page.coverage.stopJSCoverage())));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
