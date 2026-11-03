// @ts-check
import express from 'express';
import { netSuiteFailureAudit } from './netsuite-failure-runtime.js';
import { assertOperatorYard } from './operator-yard-access.js';

/** @param {unknown} raw */
export function validateOperatorNetSuiteFailure(raw) {
  const value = /** @type {any} */ (raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(value.failureId || '')
    || !Number.isFinite(Date.parse(value.occurredAt))
    || !['receiving', 'customer_pickup', 'delivery_prep', 'returns', 'inventory', 'operator'].includes(value.functionKey)
    || typeof value.errorMessage !== 'string' || !value.errorMessage.trim() || value.errorMessage.length > 4000
    || typeof value.stage !== 'string' || !/^[a-z_]{1,60}$/u.test(value.stage)) {
    throw Object.assign(new Error('Invalid NetSuite failure report.'), { status: 400 });
  }
  for (const field of ['requestId', 'orderId', 'orderRef', 'orderType', 'clientVersion', 'errorCode', 'errorName']) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || value[field].length > 180)) {
      throw Object.assign(new Error(`Invalid failure report ${field}.`), { status: 400 });
    }
  }
  if (value.stack !== undefined && (typeof value.stack !== 'string' || value.stack.length > 4000)) {
    throw Object.assign(new Error('Invalid failure report stack.'), { status: 400 });
  }
  return value;
}

/** @param {{audit?: typeof netSuiteFailureAudit}} [options] */
export function createOperatorNetSuiteFailureRouter({ audit = netSuiteFailureAudit } = {}) {
  const router = express.Router();
  router.post('/', async (req, res, next) => {
    try {
      const value = validateOperatorNetSuiteFailure(req.body);
      const actor = (/** @type {any} */ (req)).operator;
      const locationId = assertOperatorYard(actor, value.locationId);
      const result = await audit.record({ message: value.errorMessage, code: value.errorCode, name: value.errorName, stack: value.stack }, {
        ...value, actorOperatorId: actor.id, locationId, clientReported: true, operation: 'operator.client_failure'
      });
      res.setHeader('cache-control', 'no-store');
      res.status(result.persisted ? 200 : 503).json({ ok: result.persisted, failureId: result.failureId });
    } catch (error) { next(error); }
  });
  return router;
}
