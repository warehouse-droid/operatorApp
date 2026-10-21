/* global PROBE_MODE, netsuiteRest, queueNetSuiteMutation, suiteqlAll, query, crypto */
// Appended to the existing NetSuite transport module by the bounded Python runner.
// It never changes any order other than the explicitly authorized SOB121380.
const probeAssert = (await import('node:assert/strict')).default;
const probeFs = await import('node:fs');
const probeDb = await import('file:///app/src/db.js');
const probeRepository = await import('file:///app/src/special-stock-request-repository.js');
const probeNumeric = PROBE_MODE.endsWith('-numeric');
const probeAmount = PROBE_MODE.endsWith('-amount');
const probeName = `SOB121380-rest-percent${probeAmount ? '-amount' : probeNumeric ? '-numeric' : ''}`;
const probePath = `/tmp/${probeName}-before.private.json`;
const probeResultPath = `/tmp/${probeName}-result.json`;
const probeUrl = '/record/v1/salesOrder/1017068';
const probeHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const probeRead = async () => (await netsuiteRest(probeUrl + '?expandSubResources=true', { method: 'GET' })).data;
const probeValues = record => ({ entity: record.entity?.id, location: record.location?.id, total: record.total,
  subTotal: record.subtotal ?? record.subTotal, taxTotal: record.taxTotal, memo: record.memo,
  lines: record.item.items.map(line => ({ key: line.lineUniqueKey, line: line.line, item: line.item.id,
    quantity: line.quantity ?? null, units: line.units ?? null, rate: line.rate, amount: line.amount,
    price: line.price?.id ?? null, description: line.description || '', closed: line.isClosed,
    taxCode: line.taxCode?.id ?? null, createdPo: line.createdPo?.id ?? null })) });
async function probeProtected() {
  const rows = (await query(`SELECT jsonb_build_object('r',to_jsonb(r),'c',to_jsonb(c),
    'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM sales_special_stock_lines l WHERE request_id=r.id),
    'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM sales_special_stock_order_lines o WHERE request_id=r.id)) AS state
    FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id WHERE r.request_ref='SPREQ-000006'`)).rows;
  probeAssert.equal(rows.length, 1); return probeHash(rows[0].state);
}
function probeExpected(record) {
  probeAssert.equal(record.tranId, 'SOB121380');
  probeAssert.equal(Number(record.entity.id), 8444);
  probeAssert.deepEqual(record.item.items.map(line => [Number(line.item.id), Number(line.quantity), Number(line.rate)]), [[2055, 50, 17], [1784, 11, 40]]);
  probeAssert.equal(Number(record.total), 1457.7);
  for (const line of record.item.items) {
    probeAssert.equal(Number(line.quantityFulfilled || 0), 0);
    probeAssert.equal(Number(line.quantityBilled || 0), 0);
    probeAssert.notEqual(line.isClosed, true);
  }
}
async function probeRestore(before, after) {
  probeAssert.equal(after.tranId, before.tranId);
  const keys = before.item.items.map(line => String(line.lineUniqueKey));
  probeAssert.deepEqual(after.item.items.filter(line => Number(line.item.id) !== 10716).map(line => String(line.lineUniqueKey)), keys);
  probeAssert.ok(after.item.items.every(line => keys.includes(String(line.lineUniqueKey)) || Number(line.item.id) === 10716));
  const items = before.item.items.map(line => ({ line: Number(line.line), item: { id: String(line.item.id) },
    quantity: Number(line.quantity), units: line.units, price: line.price || { id: '-1' }, rate: Number(line.rate), description: line.description || '' }));
  await queueNetSuiteMutation(() => netsuiteRest(probeUrl + '?replace=item', { method: 'PATCH', body: { item: { items } } }));
  const restored = await probeRead(); probeAssert.deepEqual(probeValues(restored), probeValues(before));
  return restored;
}
try {
  if (PROBE_MODE.startsWith('prepare')) {
    probeAssert.equal(probeFs.existsSync(probePath), false, 'Preserve the existing test checkpoint');
    const detail = await probeRepository.getSpecialStockCase(62, { audience: 'scm' });
    probeAssert.equal(detail.requestRef, 'SPREQ-000007');
    probeAssert.equal(detail.dispatchPlanning.anyPlanned, false); probeAssert.equal(detail.quantityReview.status, 'approved');
    const before = await probeRead(); probeExpected(before);
    const statuses = await suiteqlAll("SELECT id,status FROM transaction WHERE id IN (1017068,1017168) ORDER BY id");
    probeAssert.deepEqual(statuses.map(row => [Number(row.id), row.status]), [[1017068, 'B'], [1017168, 'B']]);
    const material = before.item.items[0], pallet = before.item.items[1];
    const discount = { item: { id: '10716' }, price: { id: '-1' }, rate: probeAmount ? -150 : probeNumeric ? -15 : '-15%', location: { id: before.location.id } };
    if (material.taxCode) discount.taxCode = material.taxCode;
    const body = { item: { items: [{ line: material.line, price: { id: '-1' }, rate: 20 }, discount, { line: pallet.line }] } };
    const checkpoint = { before, beforeValues: probeValues(before), detail, body, protectedHash: await probeProtected() };
    probeFs.writeFileSync(probePath, JSON.stringify(checkpoint), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ prepared: true, order: before.tranId, method: 'PATCH', path: probeUrl + '?replace=item', body,
      beforeTotal: before.total, expectedTotal: 1457.7, expectedMaterialSubtotal: 850, writes: 0 }));
  } else if (PROBE_MODE.startsWith('verify')) {
    const checkpoint = JSON.parse(probeFs.readFileSync(probePath, 'utf8'));
    const result = JSON.parse(probeFs.readFileSync(probeResultPath, 'utf8'));
    const current = await probeRead();
    probeAssert.deepEqual(probeValues(current), checkpoint.beforeValues);
    probeAssert.equal(await probeProtected(), checkpoint.protectedHash);
    const detail = await probeRepository.getSpecialStockCase(62, { audience: 'scm' });
    const localValues = value => ({ salesOrderId: value.salesOrderId, purchaseOrderId: value.purchaseOrderId,
      salesOrderLines: value.salesOrderLines, purchaseOrderLines: value.purchaseOrderLines,
      quantityReview: value.quantityReview, attention: value.attention, attentionReason: value.attentionReason });
    probeAssert.deepEqual(localValues(detail), localValues(checkpoint.detail));
    const rows = await suiteqlAll("SELECT id,status,foreigntotal FROM transaction WHERE id IN (1017068,1017168) ORDER BY id");
    probeAssert.deepEqual(rows.map(row => [Number(row.id), row.status, Number(row.foreigntotal)]), [[1017068, 'B', 1457.7], [1017168, 'B', -282.5]]);
    result.finalVerified = true;
    result.finalLocalStateUnchanged = true;
    result.finalSoTotal = Number(current.total);
    result.finalPoTotal = -282.5;
    probeFs.writeFileSync(probeResultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ order: current.tranId, finalVerified: true, localStateUnchanged: true,
      soTotal: current.total, poStatus: 'Pending Receipt', protectedRequestUnchanged: true }));
  } else {
    probeAssert.equal(probeFs.existsSync(probeResultPath), false, 'This REST test already ran; inspect its saved result');
    const checkpoint = JSON.parse(probeFs.readFileSync(probePath, 'utf8'));
    probeAssert.deepEqual(probeValues(await probeRead()), checkpoint.beforeValues);
    probeAssert.equal(await probeProtected(), checkpoint.protectedHash);
    const detail = await probeRepository.getSpecialStockCase(62, { audience: 'scm' });
    probeAssert.equal(detail.revision, checkpoint.detail.revision);
    probeAssert.equal(detail.dispatchPlanning.anyPlanned, false);
    const result = { order: 'SOB121380', customPriceLevel: -1, requestedRate: probeAmount ? -150 : probeNumeric ? -15 : '-15%', transport: 'restRecord' };
    try {
      await queueNetSuiteMutation(() => netsuiteRest(probeUrl + '?replace=item', { method: 'PATCH', body: checkpoint.body }));
      let after = await probeRead();
      if (probeAmount) {
        probeAssert.equal(Number(after.total), 1457.7);
        result.beforeReorder = after.item.items.map(line => ({ line: line.line, key: line.lineUniqueKey, item: line.item.id }));
        const material = after.item.items.find(line => Number(line.item.id) === 2055);
        const discount = after.item.items.find(line => Number(line.item.id) === 10716);
        const pallet = after.item.items.find(line => Number(line.item.id) === 1784);
        probeAssert.ok(material && discount && pallet);
        await queueNetSuiteMutation(() => netsuiteRest(probeUrl + '?replace=item', { method: 'PATCH', body: {
          item: { items: [material, discount, pallet].map(line => ({ line: line.line })) }
        } }));
        after = await probeRead();
        result.keyedReorderPreservedPosition = after.item.items.map(line => Number(line.item.id)).join(',') === '2055,10716,1784';
      }
      const rows = await suiteqlAll("SELECT uniquekey,rate,ratepercent FROM transactionline WHERE transaction=1017068 AND item=10716 AND taxline='F'");
      const exact = after.item.items.map(line => Number(line.item.id)).join(',') === '2055,10716,1784'
        && Number(after.total) === 1457.7 && rows.length === 1
        && (probeAmount ? Number(rows[0].rate) === -150 && rows[0].ratepercent == null : Number(rows[0].ratepercent) === -0.15);
      result.accepted = true; result.percentageVerified = exact; result.afterValues = probeValues(after); result.discountRows = rows;
      // This probe always restores its baseline. The user-requested conversion
      // will subsequently use the production REST workflow and its saved journal.
      await probeRestore(checkpoint.before, after); result.restored = true;
    } catch (error) {
      result.accepted = false; result.error = error.message;
      const current = await probeRead();
      if (JSON.stringify(probeValues(current)) !== JSON.stringify(checkpoint.beforeValues)) {
        await probeRestore(checkpoint.before, current); result.restored = true;
      } else result.unchanged = true;
    }
    probeAssert.equal(await probeProtected(), checkpoint.protectedHash);
    result.protectedRequestUnchanged = true;
    probeFs.writeFileSync(probeResultPath, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify(result));
  }
} finally { await probeDb.closeDb(); }
process.exit(0);
