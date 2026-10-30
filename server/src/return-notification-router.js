import { returnNotifications } from './return-notification-service.js';
import { returnNotificationSettings } from './return-notification-settings.js';
import { returnNotificationTransport } from './return-notification-transport.js';

export function mountReturnNotificationRoutes(app, { requireOperator, requireOperatorAccess, requireAdmin }) {
  app.post('/api/returns/operator/history/:id/notify', requireOperator, requireOperatorAccess, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(await returnNotifications.send({ recordId: req.params.id, operator: req.operator, recipient: req.body?.recipient }));
    } catch (error) { next(error); }
  });
  app.get('/api/admin/return-notifications', requireOperator, requireAdmin, async (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json({ ...await returnNotificationSettings.public(), emailConfigured: returnNotificationTransport.emailConfigured() }); }
    catch (error) { next(error); }
  });
  app.put('/api/admin/return-notifications', requireOperator, requireAdmin, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const settings = await returnNotificationSettings.save(req.body || {});
      res.json({ ...settings, emailConfigured: returnNotificationTransport.emailConfigured() });
    } catch (error) { next(error); }
  });
}
