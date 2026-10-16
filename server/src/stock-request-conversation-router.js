import {listStockRequestConversation, sendStockRequestConversation, readStockRequestConversation, listStockRequestConversationAlerts} from './stock-request-conversation.js';

export function mountStockRequestConversationRoutes(app, {salesGuards, scmRead, scmWrite, salesContext, emit}) {
  const handler = (audience, action, changed = false) => async (req, res, next) => {
    try {
      const context = {audience, ...(audience === 'sales' ? salesContext(req) : {operatorId: req.operator.id})};
      const result = await action(req, context);
      res.setHeader('Cache-Control', 'private, no-store');
      if (changed) emit('stock-conversation', {requestId: Number(req.params.id), conversationEventId: result.latestEventId});
      res.json(result);
    } catch (error) {next(error);}
  };
  for (const audience of ['sales', 'scm']) {
    const read = audience === 'sales' ? salesGuards : [scmRead], write = audience === 'sales' ? salesGuards : [scmWrite];
    const base = `/api/${audience}/stock-requests/:id/conversation`;
    app.get(`/api/${audience}/stock-request-conversation-alerts`, ...read, handler(audience, (_req, context) => listStockRequestConversationAlerts(context)));
    app.get(base, ...read, handler(audience, (req, context) => listStockRequestConversation(req.params.id, context)));
    app.post(base, ...write, handler(audience, (req, context) => sendStockRequestConversation(req.params.id, req.body, context), true));
    app.post(`${base}/read`, ...read, handler(audience, (req, context) => readStockRequestConversation(req.params.id, req.body, context)));
  }
}
