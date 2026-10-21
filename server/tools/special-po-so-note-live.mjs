// Read the example's PO field without creating or changing any NetSuite order.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root = process.cwd();
const {closeDb} = await import(`${root}/src/db.js`);
let source = readFileSync(`${root}/src/netsuite.js`, 'utf8').replace(
  /from (["'])\.\/([^"']+)\1/g, (_match, quote, path) => `from ${quote}file://${root}/src/${path}${quote}`);
source += '\nexport const readExamplePo = () => netsuiteRest("/record/v1/purchaseOrder/1030348", {method:"GET"});';
try {
  const {readExamplePo} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const record = (await readExamplePo()).data;
  assert.equal(record.tranId, 'POB03976');
  const matchingFields = Object.entries(record).filter(([, value]) =>
    typeof value === 'string' && value.includes('SOB121819'));
  assert.ok(matchingFields.length, 'The reference SO must be present on the example PO.');
  console.log(JSON.stringify({readOnly:true, poRef:record.tranId, memo:record.memo,
    matchingFields:Object.fromEntries(matchingFields), orderSubmitted:false}));
} finally {
  await closeDb();
}
