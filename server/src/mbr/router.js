import express from 'express';
import {MbrError,requireMbrAuthority} from '../../public/mbr/domain.js';
import {hashLinkToken} from './credentials.js';
import {createMbrEquipmentRepository} from './equipment-repository.js';
import {createMbrRatesRepository} from './rates-repository.js';

export function createPublicRateLimiter({limit=120,periodMs=60000,maximumKeys=4096,now=Date.now,key=req=>req.ip}={}) {
  const buckets=new Map();
  return (req,res,next)=>{
    const stamp=now(),identity=key(req);
    let bucket=buckets.get(identity);
    if(!bucket || bucket.until<=stamp) {
      if(buckets.size>=maximumKeys) {
        for(const [id,value] of buckets) {if(value.until<=stamp) {buckets.delete(id);}}
        if(buckets.size>=maximumKeys) {return res.status(429).set('Retry-After','60').json({error:'Too many requests. Please try again shortly.',code:'MBR_RATE_LIMITED'});}
      }
      bucket={count:0,until:stamp+periodMs};buckets.set(identity,bucket);
    }
    bucket.count+=1;
    if(bucket.count>limit) {return res.status(429).set('Retry-After',String(Math.max(1,Math.ceil((bucket.until-stamp)/1000))))
      .json({error:'Too many requests. Please try again shortly.',code:'MBR_RATE_LIMITED'});}
    next();
  };
}
function sameOrigin(req,res,next) {
  const origin=req.get('origin');
  if(!origin) {return next();}
  const protocol=req.get('x-forwarded-proto')?.split(',')[0].trim() || req.protocol;
  if(origin!==`${protocol}://${req.get('host')}`) {
    return res.status(403).json({error:'Open the signing link directly to sign your agreement.',code:'MBR_ORIGIN_INVALID'});
  }
  next();
}
function pdfResponse(res,pdf) {
  return res.type('application/pdf').set('Content-Disposition',`attachment; filename="${pdf.filename}"`).send(pdf.bytes);
}
export function createMbrRouter({repo,authenticate,enabled=()=>true,logger=console,equipment=createMbrEquipmentRepository(),rates=createMbrRatesRepository()}) {
  const router=express.Router();
  const wrap=handler=>(req,res,next)=>Promise.resolve().then(()=>handler(req,res)).catch(next);
  router.use((_req,res,next)=>{
    res.set({'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'});
    if(!enabled()) {return res.status(503).json({error:'MBR Contracts is not enabled.',code:'MBR_DISABLED'});}
    next();
  });
  const publicRouter=express.Router();
  publicRouter.use(createPublicRateLimiter());
  publicRouter.use((req,_res,next)=>{try {req.mbrToken=req.get('x-mbr-contract-token');hashLinkToken(req.mbrToken);next();}catch(error){next(error);}});
  const signLimit=createPublicRateLimiter({limit:8,key:req=>`${req.ip}:${hashLinkToken(req.mbrToken)}`});
  publicRouter.get('/contract',wrap(async(req,res)=>res.json(await repo.review(req.mbrToken))));
  publicRouter.post('/sign',sameOrigin,signLimit,express.json({limit:'1mb'}),wrap(async(req,res)=>res.json(
    await repo.sign(req.mbrToken,req.body,{ip:req.ip,userAgent:req.get('user-agent')}))));
  publicRouter.get('/pdf',wrap(async(req,res)=>pdfResponse(res,await repo.pdf({token:req.mbrToken}))));
  router.use('/public',publicRouter);
  router.use(authenticate,(req,_res,next)=>{try {requireMbrAuthority(req.operator);next();}catch(error){next(error);}});
  router.use(express.json({limit:'32kb'}));
  router.get('/status',wrap(async(req,res)=>res.json({enabled:true,operator:req.operator,defaultExpiryDays:3,protectionPlanPercent:15})));
  router.get('/setup/rates',wrap(async(_req,res)=>res.json(await rates.list())));
  router.patch('/setup/rates',wrap(async(req,res)=>res.json(await rates.edit(req.operator,req.body))));
  router.get('/setup/equipment',wrap(async(_req,res)=>res.json(await equipment.list())));
  router.post('/setup/equipment',wrap(async(req,res)=>res.status(201).json(await equipment.add(req.operator,req.body))));
  router.patch('/setup/equipment/:id',wrap(async(req,res)=>res.json(await equipment.edit(req.operator,req.params.id,req.body))));
  router.get('/contracts',wrap(async(req,res)=>res.json(await repo.list({search:req.query.search || '',status:req.query.status || '',
    offset:req.query.offset===undefined?0:Number(req.query.offset)}))));
  router.post('/contracts',wrap(async(req,res)=>res.status(201).json(await repo.create(req.operator,req.body))));
  router.get('/contracts/:id',wrap(async(req,res)=>res.json(await repo.get(req.params.id))));
  router.patch('/contracts/:id',wrap(async(req,res)=>res.json(await repo.edit(req.operator,req.params.id,req.body))));
  router.post('/contracts/:id/link',wrap(async(req,res)=>res.json(await repo.link(req.operator,req.params.id,req.body?.revision))));
  router.post('/contracts/:id/renew',wrap(async(req,res)=>res.json(await repo.renew(req.operator,req.params.id,req.body))));
  router.get('/contracts/:id/pdf',wrap(async(req,res)=>pdfResponse(res,await repo.pdf({id:req.params.id}))));
  router.use((error,_req,res,next)=>{
    if(res.headersSent) {return next(error);}
    const status=error instanceof MbrError ? error.status : Number(error.status) || 500;
    if(status>=500) {logger.error('[MBR Contracts] Request failed.',{code:'MBR_INTERNAL_ERROR'});}
    res.status(status).json({error:status>=500?'Could not complete this request. Please try again.':error.message,
      code:error.code || (status===413?'MBR_PAYLOAD_TOO_LARGE':'MBR_ERROR')});
  });
  return router;
}
