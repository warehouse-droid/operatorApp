import express from 'express';

export function createDeliveryRequestRouter({ service, audience }) {
  const router = express.Router();
  router.use((_req,res,next) => { res.setHeader('Cache-Control','private, no-store'); next(); });
  const endpoint = run => async (req,res,next) => {
    try { await run(req,res); }
    catch (error) {
      if (error.status) {res.status(error.status).json({ error:error.message,code:error.code });}
      else {next(error);}
    }
  };
  router.get('/meta',endpoint(async (req,res) => res.json(await service.options(req.operator,audience))));
  router.get('/alerts',endpoint(async (req,res) => res.json(await service.alerts(req.operator,audience))));
  if (audience === 'sales') {
    router.get('/estimates/:reference/preview',endpoint(async(req,res)=>res.json(await service.previewEstimate(req.params.reference,req.query.yard,req.operator,audience))));
    router.post('/quotes',endpoint(async (req,res) => res.status(201).json(await service.quote(req.body,req.operator))));
    router.post('/',endpoint(async (req,res) => res.status(201).json(await service.create(req.body,req.operator))));
  } else {
    router.put('/settings',endpoint(async (req,res) => res.json(await service.setSettings(req.body,req.operator))));
  }
  router.get('/',endpoint(async (req,res) => res.json(await service.list(req.operator,audience,req.query))));
  router.get('/:id/estimate/preview',endpoint(async(req,res)=>res.json(await service.previewAttachedEstimate(req.params.id,req.operator,audience))));
  router.get('/:id/transfer-orders/:reference/preview',endpoint(async(req,res)=>res.json(await service.previewTransferOrder(req.params.id,req.params.reference,req.operator,audience))));
  router.get('/:id/sales-orders/:reference/preview',endpoint(async(req,res)=>{
    const document=await service.previewSalesOrder(req.params.id,req.params.reference,req.operator,audience);
    const filename=String(document.filename || 'sales-order.pdf').replace(/[^a-zA-Z0-9_.-]+/g,'-');
    res.type('application/pdf').set('Content-Disposition',`inline; filename="${filename}"`).set('X-Content-Type-Options','nosniff').send(document.buffer);
  }));
  router.get('/:id',endpoint(async (req,res) => res.json(await service.get(req.params.id,req.operator,audience))));
  router.post('/:id/read',endpoint(async (req,res) => res.json(await service.markRead(req.params.id,req.body.revision,req.operator,audience))));
  router.post('/:id/actions/:action',endpoint(async (req,res) => res.json(await service.act(req.params.id,req.params.action,req.body,req.operator,audience))));
  return router;
}
