// @ts-check
import { withOperatorNetSuitePriority, withBackgroundNetSuitePriority } from './operator-netsuite-request-pool.js';

const bulkSyncPaths = new Set(['/api/delivery/sync', '/api/receiving/sync', '/api/inventory/sync']);
/** @type {import('express').RequestHandler} */
export function operatorNetSuitePriority(req, _res, next) {
  const path = (req.originalUrl.split('?')[0] || '').toLowerCase().replace(/\/+$/u, '');
  const withPriority = bulkSyncPaths.has(path) ? withBackgroundNetSuitePriority : withOperatorNetSuitePriority;
  withPriority(next);
}
