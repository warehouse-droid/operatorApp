import assert from 'node:assert/strict';
import { closeDb } from '../src/db.js';
import { getSpecialStockCase } from '../src/special-stock-request-repository.js';
import { specialItemDescription } from '../public/special-stock-line-details.js';

try {
  const detail = await getSpecialStockCase(80, { audience: 'scm' });
  assert.equal(detail.requestRef, 'SPREQ-000016');
  const line = detail.lines.find(line => line.id === 25);
  assert.equal(line.brand, 'BWS');
  assert.equal(line.productName, 'Fire Pit 32" Square Insert');
  assert.equal(detail.stage, 'await_customer_confirmation');
  assert.match(specialItemDescription(line), /^BWS · Fire Pit 32" Square Insert/);
  assert.ok(detail.events.some(event => event.eventType === 'special_item_name_corrected'
    && event.details.source === 'user_requested_typo_correction'));
  console.log(JSON.stringify({ requestRef: detail.requestRef, revision: detail.revision,
    stage: detail.stage, brand: line.brand, productName: line.productName, audited: true }));
} finally { await closeDb(); }
