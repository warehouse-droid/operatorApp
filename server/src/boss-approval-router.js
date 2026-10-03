import {Router} from 'express';

export function createBossApprovalRouter({repo,service}) {
  const router=Router();
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  const route=fn=>async(req,res,next)=>{try{await fn(req,res);}catch(error){next(error);}};
  router.get('/requests',route(async(req,res)=>res.json(await repo.list(req.operator,req.query))));
  router.get('/requests/:id',route(async(req,res)=>res.json(await repo.detail(req.operator,req.params.id))));
  router.post('/requests/:id/decision',route(async(req,res)=>{
    const result=await service.decide(req.operator,{...req.body,requestId:req.params.id});
    res.status(result.status==='succeeded'?200:202).json({commandId:result.id,status:result.status,lastError:result.last_error||''});
  }));
  router.get('/notifications',route(async(req,res)=>res.json(await repo.notifications(req.operator))));
  router.post('/notifications/:id/read',route(async(req,res)=>res.json(await repo.markRead(req.operator,req.params.id))));
  return router;
}
export function createBossApprovalAdminRouter({repo,mailer,writeAudit}) {
  const router=Router();
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  router.get('/',async(_req,res,next)=>{
    try{res.json({settings:await repo.settings(),principals:await repo.roster(),mail:mailer.readiness(),health:await repo.health()});}catch(error){next(error);}
  });
  router.put('/',async(req,res,next)=>{
    try{
      const result=await repo.configure(req.body,req.operator.id);
      await writeAudit({actorOperatorId:req.operator.id,source:'boss-approvals',action:'boss.settings.updated',details:{enabled:result.settings.enabled,principals:result.principals.map(p=>({key:p.key,operatorId:p.operatorId,ownerId:p.ownerId}))}});
      res.json(result);
    }catch(error){next(error);}
  });
  return router;
}
