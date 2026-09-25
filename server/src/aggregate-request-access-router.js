import express from 'express';
import { listAggregateRequestAccess, updateAggregateRequestAccess } from './aggregate-request-access-repository.js';

export function createAggregateRequestAccessRouter({ onChange = () => {} } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/', async (req, res, next) => {
    try { res.json(await listAggregateRequestAccess(req.operator)); } catch (error) { next(error); }
  });
  router.put('/:operatorId', async (req, res, next) => {
    try {
      const result = await updateAggregateRequestAccess(req.params.operatorId, req.body, req.operator);
      try { onChange(); } catch { /* Permission checks always read current assignments. */ }
      res.json(result);
    } catch (error) { next(error); }
  });
  router.use((error, _req, res, next) => {
    if (!String(error.code || '').startsWith('AGGREGATE_')) { return next(error); }
    res.status(error.status || 400).json({ error: error.message, code: error.code });
  });
  return router;
}
