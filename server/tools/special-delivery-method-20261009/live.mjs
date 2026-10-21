import assert from 'node:assert/strict';
import { getSpecialStockCase } from './src/special-stock-request-repository.js';
import { canEditSpecialFulfillment } from './public/special-stock-fulfillment.js';
import { closeDb } from './src/db.js';
try {
  const detail = await getSpecialStockCase(125, { audience: 'sales', authorizedStoreLocationIds: [1] });
  assert.equal(detail.requestRef, 'SPREQ-000041');
  assert.equal(detail.salesOrderRef, 'SOB122143');
  assert.equal(detail.purchaseOrderRef, 'POB03999');
  assert.equal(detail.purchaseOrderReference, 'SN1402193');
  assert.equal(detail.storeName, '3445');
  const editable = canEditSpecialFulfillment(detail);
  const planned = Boolean(detail.dispatchPlanning?.anyPlanned || detail.dispatchPlanned
    || ['planned', 'in_progress', 'completed'].includes(detail.handoff?.status));
  // The request can advance while a release awaits authorization. Preserve the
  // normal planning/completion lock; an already planned request is not editable.
  const finished = detail.closeStatus !== 'active' || detail.operationallyComplete
    || ['closed', 'completed'].includes(detail.stage);
  assert.equal(editable, !planned && !finished);
  const health = await (await fetch('http://127.0.0.1:3000/health')).json();
  const statuses = [];
  for (const audience of ['scm', 'dispatch']) {
    const response = await fetch(`http://127.0.0.1:3000/api/${audience}/special-stock-requests/delivery-method-alerts`);
    statuses.push(response.status);
  }
  console.log(JSON.stringify({ healthy: health.ok === true, editable, planned, workflowGuardsVerified: true,
    routesProtected: statuses.every(status => status === 401),
    requestRef: detail.requestRef, revision: detail.revision, fulfillmentMethod: detail.fulfillmentMethod, yard: detail.storeName,
    salesOrderRef: detail.salesOrderRef, purchaseOrderRef: detail.purchaseOrderRef, purchaseOrderReference: detail.purchaseOrderReference }));
} finally { await closeDb(); }
process.exit(0);
