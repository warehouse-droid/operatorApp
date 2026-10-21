// Read-only live validation. Credentials remain inside the production process.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createStockCheckRuntime} from '/app/src/stock-check/runtime.js';
import {readPortalDocument} from '/app/src/stock-check/unilock-dom.js';
import {parseAvailability,sanitizeFailure} from '/app/src/stock-check/domain.js';
import {query,closeDb} from '/app/src/db.js';

const runtime=createStockCheckRuntime({authenticate:(_req,_res,next)=>next(),dataDir:'/app/data'});
let credentials=null,browser=null;
try {
  credentials=await runtime.repo.getCredentials(1,1);
  browser=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage();
  page.setDefaultTimeout(30000);
  await page.goto('https://ontario.order.unilock.com/login.aspx',{waitUntil:'domcontentloaded'});
  await page.locator('#txtUserName').fill(credentials.username);
  await page.locator('[id$="_txtPassword"]').fill(credentials.password);
  await Promise.all([page.waitForEvent('framenavigated',{predicate:frame=>frame===page.mainFrame()}),
    page.locator('[id$="_bLogin"]').click()]);
  await page.goto('https://ontario.order.unilock.com/shoppingCart.aspx',{waitUntil:'domcontentloaded'});
  const cart=await readPortalDocument(page);
  const rows=cart.cartRows.map(row=>({sku:row.sku,quantity:row.quantity,uom:row.uom,
    availabilityText:row.availabilityText,availabilityAmbiguous:row.availabilityAmbiguous,
    parsed:parseAvailability(row.availabilityText)}));
  await page.goto('https://ontario.order.unilock.com/products/products/urban?child=02U1183661507-0',
    {waitUntil:'domcontentloaded'});
  const urban=await readPortalDocument(page);
  assert.equal(urban.selected?.sku,'02U1183661507-0');
  const availability=parseAvailability(urban.productBundleAvailability);
  assert.equal(availability.status,'in_production');
  assert.equal(availability.eta,'2026-10-20');
  const legacy=await runtime.repo.getJob('3de7631b-f79d-4cc2-a199-0b0ea77c23db');
  const raw=await query('SELECT result FROM scm_stock_check_jobs WHERE id=$1',[legacy.id]);
  assert.equal(legacy.result.status,'availability_unverified');
  assert.equal(legacy.result.verifiedQuantity,null);
  assert.equal(raw.rows[0].result.status,'stock_confirmed');
  const catalog=await query('SELECT count(*)::int AS count FROM scm_stock_check_products WHERE vendor_id=1');
  console.log(JSON.stringify({at:new Date().toISOString(),readOnly:true,cart:rows,
    urban:{sku:urban.selected.sku,stockLabel:urban.stockLabel,
      availabilityText:urban.productBundleAvailability,source:urban.productAvailabilitySource,parsed:availability},
    legacy:{id:legacy.id,presentedStatus:legacy.result.status,
      acceptedQuantity:legacy.result.acceptedQuantity,verifiedQuantity:legacy.result.verifiedQuantity,
      storedStatus:raw.rows[0].result.status,auditPreserved:true},catalogCount:catalog.rows[0].count}));
} catch(error) {
  console.error(sanitizeFailure(error,[credentials?.password]));process.exitCode=1;
} finally {
  if(credentials) {credentials.password=null;}
  await browser?.close();await closeDb();
}
