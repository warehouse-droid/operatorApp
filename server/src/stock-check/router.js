import express from 'express';
import path from 'node:path';
import {canUseStockCheck,StockCheckError,PICKUP_LOCATIONS} from './domain.js';
export function createStockCheckRouter({repo,authenticate,evidenceDir,requestChecks}) {
  const router=express.Router(),wrap=handler=>(req,res,next)=>Promise.resolve().then(()=>handler(req,res)).catch(next);
  const actor=req=>String(req.operator.id);
  const id=value=>{const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<1) {throw new StockCheckError('Invalid record ID.');}return parsed;};
  router.use((_req,res,next)=>{res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});next();});
  router.use(authenticate,(req,res,next)=>{
    if(!canUseStockCheck(req.operator)) {return res.status(403).json({error:'SCM access is required.',code:'STOCK_CHECK_FORBIDDEN'});}next();
  });
  router.use(express.json({limit:'16kb'}));
  router.get('/setup',wrap(async(_req,res)=>res.json({pickupLocations:PICKUP_LOCATIONS,methods:[
    {key:'unilock-ontario-v1',name:'Unilock Ontario'},{key:'pending',name:'Method pending'}]})));
  router.get('/vendors',wrap(async(_req,res)=>res.json(await repo.listVendors())));
  router.post('/vendors',wrap(async(req,res)=>res.status(201).json(await repo.saveVendor(req.body,actor(req)))));
  router.patch('/vendors/:id',wrap(async(req,res)=>res.json(await repo.saveVendor({...req.body,id:id(req.params.id)},actor(req)))));
  router.get('/vendors/:id/accounts',wrap(async(req,res)=>res.json(await repo.listAccounts(id(req.params.id)))));
  router.post('/vendors/:id/accounts',wrap(async(req,res)=>res.status(201).json(await repo.saveAccount(id(req.params.id),req.body,actor(req)))));
  router.patch('/vendors/:id/accounts/:accountId',wrap(async(req,res)=>res.json(await repo.saveAccount(id(req.params.id),{...req.body,id:id(req.params.accountId)},actor(req)))));
  router.get('/products',wrap(async(req,res)=>res.json(await repo.listProducts({vendorId:req.query.vendorId?id(req.query.vendorId):undefined,
    search:req.query.search??'',offset:req.query.offset,limit:req.query.limit,reviewOnly:req.query.reviewOnly==='true'}))));
  router.post('/vendors/:id/products',wrap(async(req,res)=>res.status(201).json(await repo.saveProduct(id(req.params.id),req.body,actor(req)))));
  router.patch('/vendors/:id/products/:productId',wrap(async(req,res)=>res.json(await repo.saveProduct(id(req.params.id),{...req.body,id:id(req.params.productId)},actor(req)))));
  router.get('/jobs',wrap(async(req,res)=>res.json(await repo.listJobs(req.query.vendorId?id(req.query.vendorId):undefined))));
  router.get('/requests/:id',wrap(async(req,res)=>res.json(await requestChecks.get(id(req.params.id)))));
  router.post('/requests/:id/match',wrap(async(req,res)=>res.json(await requestChecks.match(id(req.params.id)))));
  router.post('/requests/:id',wrap(async(req,res)=>res.status(202).json(await requestChecks.start(id(req.params.id),req.body,actor(req)))));
  router.post('/vendors/:id/jobs',wrap(async(req,res)=>res.status(202).json(await repo.createJob(id(req.params.id),req.body,actor(req)))));
  router.get('/jobs/:id',wrap(async(req,res)=>res.json(await repo.getJob(req.params.id))));
  router.post('/jobs/:id/cancel',wrap(async(req,res)=>res.json(await repo.cancelJob(req.params.id))));
  router.get('/jobs/:id/evidence/:filename',wrap(async(req,res)=>{
    const {id:jobId,filename}=req.params;
    if(!/^[0-9a-f-]{36}$/u.test(jobId) || !/^[a-z0-9_-]+\.jpg$/u.test(filename)) {throw new StockCheckError('Invalid evidence path.');}
    const job=await repo.getJob(jobId);
    if(!job.steps.some(step=>step.screenshot===filename)) {throw new StockCheckError('Screenshot not found.',404);}
    res.type('image/jpeg');res.sendFile(path.join(evidenceDir,jobId,filename),error=>{if(error && !res.headersSent) {res.status(404).json({error:'Screenshot not found.'});}});
  }));
  router.use((error,_req,res,next)=>{
    if(res.headersSent) {return next(error);}
    const status=error instanceof StockCheckError?error.status:error.type==='entity.too.large'?413:error.type==='entity.parse.failed'?400:error.code==='23505'?409:500;
    const message=error instanceof StockCheckError?error.message:status===413?'The input is too large.':status===400?'Enter valid JSON.':status===409?'This record already exists.':'The stock-check request could not be completed.';
    res.status(status).json({error:message,code:error instanceof StockCheckError?error.code:'STOCK_CHECK_REQUEST_FAILED'});
  });
  return router;
}
