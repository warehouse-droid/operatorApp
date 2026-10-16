// @ts-check
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { isNetSuiteMirrorConsumer } from './netsuite-mirror-repository.js';
import { acceptCustomerWebhook } from './netsuite-customer-webhook.js';

export function createCustomerWebhookRouter({ settings = () => config.netsuite,
  isMirrorConsumer = isNetSuiteMirrorConsumer, accept = acceptCustomerWebhook } = {}) {
  const router = express.Router();
  router.post('/', (req, res, next) => {
    if (isMirrorConsumer()) { return res.status(403).json({ error: 'NetSuite webhooks are disabled on the mirror consumer.' }); }
    const { webhookSecret, accountId } = settings();
    if (!webhookSecret || !accountId) { return res.status(503).json({ error: 'NETSUITE_WEBHOOK_SECRET and NETSUITE_ACCOUNT_ID must be configured.' }); }
    const expected = Buffer.from(webhookSecret);
    const provided = Buffer.from(req.get('x-mbbs-webhook-secret') || '');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: 'Invalid webhook secret.' });
    }
    res.locals.customerWebhookAccountId = accountId;
    return next();
  }, express.json({ limit: '256kb' }), async (req, res, next) => {
    try {
      const result = await accept(req.body, { accountId: res.locals.customerWebhookAccountId });
      return res.status(result.action === 'conflicted' ? 409 : 200).json(result);
    } catch (error) { return next(error); }
  });
  /** @type {import('express').ErrorRequestHandler} */
  const handleError = (error, _req, res, _next) => {
    const status = [400, 403, 413, 415].includes(error.status) ? error.status : 503;
    if (status === 503) { console.error('NetSuite customer webhook save failed:', error.code || 'SAVE_FAILED'); }
    /** @type {Record<number, string>} */
    const messages = { 400: 'Invalid customer webhook payload.', 403: 'NetSuite account does not match this application.',
      413: 'Customer webhook exceeds 256 KB.', 415: 'Unsupported webhook encoding.', 503: 'Customer webhook could not be saved. Retry this event.' };
    return res.status(status).json({ error: messages[status] });
  };
  router.use(handleError);
  return router;
}
