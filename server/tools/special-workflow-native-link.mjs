// Bounded native-link repair for the user's existing SPREQ-000007 only.
// There is no POST, delete, quantity edit or SPREQ-000006 mutation path.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const root = process.cwd();
const { query, withTransaction, closeDb } = await import(`${root}/src/db.js`);
const { getSpecialStockCase } = await import(`${root}/src/special-stock-request-repository.js`);
let source = readFileSync(`${root}/src/netsuite.js`, 'utf8').replace(/from (["'])\.\/([^"']+)\1/g, (_full, quote, name) => `from ${quote}file://${root}/src/${name}${quote}`);
source += `
export async function readTarget(type,id) {
  if (![['salesOrder',1017068],['purchaseOrder',1017168]].some(pair=>pair[0]===type&&pair[1]===id)) throw Error('Outside repair scope');
  return (await netsuiteRest('/record/v1/'+type+'/'+id+'?expandSubResources=true')).data;
}
export async function patchTarget() {
  return queueNetSuiteMutation(()=>netsuiteRest('/record/v1/purchaseOrder/1017168',{method:'PATCH',
    headers:{'X-NetSuite-PropertyNameValidation':'Error','X-NetSuite-PropertyValueValidation':'Error'},
    body:{createdFrom:{id:'1017068'},item:{items:[{line:1,orderDoc:{id:'1017068'},orderLine:1}]}}}));
}`;
const { readTarget, patchTarget, suiteqlAll } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const commercial = r => r.item.items.map(l => [l.line, Number(l.item.id), Number(l.quantity), String(l.units), Number(l.rate), l.description]);
async function protectedFingerprint() {
  return withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    const { rows } = await query("SELECT id FROM sales_stock_requests WHERE request_ref='SPREQ-000006'");
    assert.equal(rows.length, 1);
    return createHash('sha256').update(JSON.stringify(await getSpecialStockCase(rows[0].id, { audience: 'scm' }))).digest('hex');
  });
}
try {
  const protectedBefore = await protectedFingerprint();
  const d = await getSpecialStockCase(62, { audience: 'scm' });
  assert.equal(d.requestRef, 'SPREQ-000007');
  assert.equal(d.salesOrderId, 1017068); assert.equal(d.purchaseOrderId, 1017168);
  assert.equal(d.purchaseOrderOperationStatus, 'linked');
  const so = await readTarget('salesOrder', 1017068), po = await readTarget('purchaseOrder', 1017168);
  assert.equal(so.tranId, 'SOB121380'); assert.equal(po.tranId, 'POB03934');
  assert.equal(po.entity.id, '331'); assert.equal(po.orderStatus.id, 'B');
  assert.equal(so.orderStatus.id, 'B');
  assert.equal(po.item.items.length, 1);
  assert.ok(!po.createdFrom); assert.ok(!so.item.items[0].createdPo);
  assert.equal(Number(po.item.items[0].quantityReceived || 0), 0);
  assert.equal(Number(po.item.items[0].quantityBilled || 0), 0);
  assert.deepEqual(commercial(so), [[1,2055,500,'865',17,'Unilock Ltd Endura Coping Lineo Buff 123test'],[2,1784,11,'246',40,'PALLET']]);
  assert.deepEqual(commercial(po), [[1,2055,500,'865',5,'Unilock Ltd Endura Coping Lineo Buff 123test']]);
  const beforeLinks = await suiteqlAll('SELECT previousdoc,previousline,nextdoc,nextline,linktype FROM NextTransactionLineLink WHERE nextdoc=1017168');
  assert.equal(beforeLinks.length, 0);
  if (process.argv.at(-1) !== '--apply') {
    console.log(JSON.stringify({ readOnly: true, caseId: 62, so: so.tranId, po: po.tranId, nativeLinks: 0, eligible: true }));
  } else {
    writeFileSync('/tmp/spreq-000007-native-link-before.private.json', JSON.stringify({ so, po, protectedBefore }), { mode: 0o600, flag: 'wx' });
    let error = null;
    try { await patchTarget(); } catch (e) { error = { status: e.status, codes: e.netsuiteErrorCodes, details: e.netsuiteErrorDetails }; }
    const afterSo = await readTarget('salesOrder', 1017068), afterPo = await readTarget('purchaseOrder', 1017168);
    assert.deepEqual(commercial(afterSo), commercial(so)); assert.deepEqual(commercial(afterPo), commercial(po));
    assert.equal(afterSo.orderStatus.id, so.orderStatus.id); assert.equal(afterPo.orderStatus.id, po.orderStatus.id);
    assert.equal(afterPo.memo, po.memo);
    const links = await suiteqlAll('SELECT previousdoc,previousline,nextdoc,nextline,linktype FROM NextTransactionLineLink WHERE nextdoc=1017168');
    assert.equal(await protectedFingerprint(), protectedBefore);
    console.log(JSON.stringify({ so: afterSo.tranId, po: afterPo.tranId, error,
      createdFrom: afterPo.createdFrom?.id || null, createdPo: afterSo.item.items[0].createdPo?.id || null,
      createPo: afterSo.item.items[0].createPo?.id || null, links, commercialValuesUnchanged: true, protectedRequestUnchanged: true }));
  }
} finally { await closeDb(); }
