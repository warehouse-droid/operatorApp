import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { query, withTransaction, closeDb } from '../src/db.js';
import { getSpecialStockCase } from '../src/special-stock-request-repository.js';
import { buildSpecialQuote, createSpecialQuoteService } from '../src/special-stock-documents.js';
import { quotePdf } from '../src/field-sales/pdf.js';
import { pdfText } from '../test/field-sales/pdf-text.js';

// A guarded, one-off correction of the two requests explicitly named by Sales.
// The default mode is read-only. --apply commits both corrections atomically.
const targets = [
  { id: 85, ref: 'SPREQ-000019', revision: 1, quantity: 1, materialCount: 1 },
  { id: 88, ref: 'SPREQ-000020', revision: 1, quantity: 5, materialCount: 4 }
];
const apply = process.argv.includes('--apply');
let remoteCalls = 0;
globalThis.fetch = async () => { remoteCalls += 1; throw new Error('This correction must not call an external service.'); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const readRow = async (target, lock = false) => (await query(`
  SELECT to_jsonb(r) AS request, to_jsonb(c) AS special
  FROM sales_stock_requests r JOIN sales_special_stock_cases c ON c.request_id=r.id
  WHERE r.id=$1 AND r.request_ref=$2 ${lock ? 'FOR UPDATE OF r,c' : ''}`,
  [target.id, target.ref])).rows[0];
const snapshot = async target => {
  const row = await readRow(target);
  const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
  const materials = (await query('SELECT * FROM sales_special_stock_lines WHERE request_id=$1 ORDER BY id', [target.id])).rows;
  const orders = (await query('SELECT * FROM sales_special_stock_order_lines WHERE request_id=$1 ORDER BY id', [target.id])).rows;
  return { request: omit(row.request, ['revision', 'updated_at']),
    special: omit(row.special, ['pallet_total', 'pallet_rate', 'updated_at']), materials, orders };
};
function checkCase(row, target, updated = false) {
  assert(row, `${target.ref} must exist at the expected ID`);
  assert.equal(Number(row.request.revision), target.revision + (updated ? 1 : 0));
  assert.equal(row.request.status, 'submitted', 'Keep the requests in their New/submitted state');
  assert.equal(row.special.close_status, 'active');
  assert.equal(row.special.attention, false);
  assert.deepEqual(row.special.quantity_review, {});
  assert.deepEqual(row.special.vendor_discount_review, {});
  for (const kind of ['sales_order', 'purchase_order']) {
    assert.equal(row.special[`${kind}_netsuite_id`], null);
    assert.equal(row.special[`${kind}_skipped`], false);
    assert.equal(row.special[`${kind}_operation_status`], 'idle');
    assert.equal(row.special[`${kind}_operation_id`], null);
    assert.equal(row.special[`${kind}_submission_started_at`], null);
  }
  if (updated) {
    assert.equal(Number(row.special.pallet_total), target.quantity);
    assert.equal(Number(row.special.pallet_rate), 40);
  } else {
    assert.equal(row.special.pallet_total, null);
    assert.equal(row.special.pallet_rate, null);
  }
}
async function checkQuote(target, detail, company, baseline) {
  assert.equal(detail.palletTotal, target.quantity);
  assert.equal(detail.palletRate, 40);
  const quote = buildSpecialQuote(detail, company);
  const pallets = quote.snapshot.lines.filter(line => line.description === 'PALLET');
  assert.equal(pallets.length, 1, 'The quote must contain exactly one PALLET charge');
  assert.equal(pallets[0].quantity, String(target.quantity));
  assert.equal(pallets[0].unit, 'EACH');
  assert.equal(pallets[0].unitRate, '40');
  assert.equal(pallets[0].amountMinor, target.quantity * 4000);
  assert.deepEqual(quote.snapshot.lines.filter(line => line.description !== 'PALLET'), baseline.snapshot.lines);
  assert.equal(quote.snapshot.subtotalMinor, baseline.snapshot.subtotalMinor + target.quantity * 4000);
  const pdf = await quotePdf(quote);
  const text = pdfText(pdf);
  assert.equal(text.split('PALLET').length, 2, 'The rendered PDF must show one PALLET line');
  assert.match(text, new RegExp(`${target.quantity}EACHPALLET\\$40\\.00\\$${target.quantity * 40}\\.00`));
  return { requestRef: target.ref, palletQuantity: target.quantity, unit: 'EACH', salesRate: 40,
    palletSubtotal: target.quantity * 40, revision: detail.revision, requestStatus: detail.status,
    quoteVerified: true, pdfSha256: createHash('sha256').update(pdf).digest('hex') };
}

try {
  const before = new Map(), baselines = new Map();
  const result = await withTransaction(async () => {
    if (!apply) await query('SET TRANSACTION READ ONLY');
    await query("SET LOCAL lock_timeout='5s'");
    await query("SET LOCAL statement_timeout='30s'");
    const source = (await query(`SELECT c.pallet_rate, l.unit_rate FROM sales_stock_requests r
      JOIN sales_special_stock_cases c ON c.request_id=r.id
      JOIN sales_special_stock_order_lines l ON l.request_id=r.id AND l.order_kind='sales_order' AND l.item_id=1784
      WHERE r.request_ref='SPREQ-000017' AND r.id=83`)).rows;
    assert.equal(source.length, 1, 'The existing reviewed PALLET sales rate must be available');
    assert.equal(Number(source[0].pallet_rate), 40);
    assert.equal(Number(source[0].unit_rate), 40);
    const item = (await query('SELECT item_name,stock_unit FROM inventory_items WHERE item_id=1784')).rows[0];
    assert.deepEqual(item, { item_name: 'PALLET', stock_unit: 'EACH' });
    const company = (await query('SELECT data FROM field_sales_settings WHERE singleton')).rows[0]?.data?.companies?.MBBS;
    // Lock in a stable order, check both targets, and calculate the quotes before any mutation.
    for (const target of targets) {
      checkCase(await readRow(target, apply), target);
      const saved = await snapshot(target);
      assert.equal(saved.materials.length, target.materialCount);
      assert.equal(saved.orders.length, 0);
      before.set(target.id, saved);
      const detail = await getSpecialStockCase(target.id, { audience: 'sales' });
      const baseline = buildSpecialQuote(detail, company);
      baselines.set(target.id, baseline);
      await checkQuote(target, { ...detail, palletTotal: target.quantity, palletRate: 40 }, company, baseline);
    }
    if (apply) for (const target of targets) {
      const updated = await query(`UPDATE sales_special_stock_cases SET pallet_total=$2,pallet_rate=40,updated_at=now()
        WHERE request_id=$1 AND pallet_total IS NULL AND pallet_rate IS NULL`, [target.id, target.quantity]);
      assert.equal(updated.rowCount, 1);
      const revision = await query(`UPDATE sales_stock_requests SET revision=revision+1,updated_at=now()
        WHERE id=$1 AND request_ref=$2 AND revision=$3 RETURNING revision`, [target.id, target.ref, target.revision]);
      assert.equal(revision.rowCount, 1);
      assert.equal(Number(revision.rows[0].revision), 2);
      await query(`INSERT INTO sales_special_stock_events(request_id,event_type,actor_id,audience,details)
        VALUES($1,'special_quote_pallet_updated',NULL,'all',$2::jsonb)`, [target.id, JSON.stringify({
        source: 'user_requested_pallet_addition', requestRef: target.ref, previousQuantity: null,
        quantity: target.quantity, uom: 'EACH', salesRate: 40, currency: 'CAD', rateSource: 'SPREQ-000017 reviewed Sales Order PALLET rate'
      })]);
    }
    const verified = [];
    for (const target of targets) {
      checkCase(await readRow(target), target, apply);
      assert.deepEqual(await snapshot(target), before.get(target.id), 'All other request fields, items, pricing, stock, and orders must remain unchanged');
      const detail = await getSpecialStockCase(target.id, { audience: 'sales' });
      verified.push({ ...(await checkQuote(target, apply ? detail : { ...detail, palletTotal: target.quantity, palletRate: 40 }, company, baselines.get(target.id))),
        unchangedDataSha256: digest(before.get(target.id)) });
    }
    assert.equal(remoteCalls, 0);
    return { applied: apply, readOnly: !apply, requests: verified, otherItemsUnchanged: true, requestStatusesUnchanged: true, remoteCalls };
  });
  // Fresh read-back after commit verifies the same service used by the saved-quote endpoint.
  if (apply) await withTransaction(async () => {
    await query('SET TRANSACTION READ ONLY');
    for (const target of targets) {
      checkCase(await readRow(target), target, true);
      assert.deepEqual(await snapshot(target), before.get(target.id));
      const document = await createSpecialQuoteService().savedQuote(target.id);
      assert.equal(pdfText(document.buffer).split('PALLET').length, 2);
      const audit = (await query(`SELECT details FROM sales_special_stock_events
        WHERE request_id=$1 AND event_type='special_quote_pallet_updated'
        AND details->>'source'='user_requested_pallet_addition'`, [target.id])).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].details.quantity, target.quantity);
    }
    result.committedReadBackVerified = true;
  });
  console.log(JSON.stringify(result, null, 2));
} finally { await closeDb(); }
