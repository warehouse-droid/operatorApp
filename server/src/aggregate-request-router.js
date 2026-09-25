import express from 'express';
import { aggregateCanManage, aggregateError } from './aggregate-request-domain.js';
import { createAggregateRequest, changeAggregateRequest, getAggregateRequest, listAggregateRequests, getAggregateRequesterWorkspace } from './aggregate-request-repository.js';

export function createAggregateRequestRouter({ scm = false, onChange = () => {} } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (scm && !aggregateCanManage(req.operator)) { return next(aggregateError('SCM edit access required.', 403, 'AGGREGATE_SCM_REQUIRED')); }
    next();
  });
  const handler = action => (req, res, next) => Promise.resolve().then(() => action(req, res)).catch(next);
  const changed = request => {
    // Quantities, identities and yard data are retrieved through authorized APIs.
    // A notification failure must not turn a committed write into an HTTP failure.
    try { onChange({ requestId: request.id, revision: request.revision }); } catch { /* committed */ }
    return request;
  };
  router.get('/', handler(async (req, res) => res.json(await listAggregateRequests(req.operator, req.query))));
  if (!scm) { router.get('/workspace', handler(async (req, res) => res.json(await getAggregateRequesterWorkspace(req.operator, req.query)))); }
  router.get('/:id', handler(async (req, res) => res.json(await getAggregateRequest(req.params.id, req.operator))));
  if (!scm) {
    router.post('/', handler(async (req, res) => res.status(201).json(changed(await createAggregateRequest(req.body || {}, req.operator)))));
  }
  for (const action of scm ? ['confirm', 'reject', 'report', 'correct', 'acknowledge', 'memo'] : ['edit', 'report']) {
    router.post(`/:id/${action}`, handler(async (req, res) => res.json(changed(await changeAggregateRequest(req.params.id, action, req.body || {}, req.operator)))));
  }
  router.use((error, _req, res, next) => {
    if (!String(error.code || '').startsWith('AGGREGATE_')) { return next(error); }
    res.status(error.status || 400).json({ error: error.message, code: error.code,
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.blockingRequestIds ? { blockingRequestIds: error.blockingRequestIds } : {})
    });
  });
  return router;
}
