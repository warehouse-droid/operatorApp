import {Router} from 'express';
import {searchSpecialCustomerDirectory} from './special-stock-customer-directory.js';
import {searchWaitlistPurchaseOrders} from './regular-waitlist-supply.js';
import {createWaitlistPool,getWaitlistPool,listWaitlistPools,listWaitlistRequests,allocateWaitlistPool,releaseWaitlistAllocation,
  closeWaitlistRequest,rejectWaitlistRequest,claimWaitlistConversion,getWaitlistRequest,getWaitlistConversion,acknowledgeWaitlistPool} from './regular-waitlist-repository.js';
import {waitlistError} from './regular-waitlist-domain.js';

const route=handler=>async(req,res,next)=>{try{res.setHeader('Cache-Control','private, no-store');await handler(req,res);}catch(error){next(error);}};
export function mountWaitlistRoutes(app,{salesGuards,scmRead,scmWrite,salesContext,emit,runtime}){
  app.get('/api/sales/stock-requests/waitlist/customers',...salesGuards,route(async(req,res)=>res.json({customers:await searchSpecialCustomerDirectory(req.query.search)})));
  const sales=Router({mergeParams:true});sales.use(...salesGuards);
  sales.post('/close',route(async(req,res)=>{
    const request=await closeWaitlistRequest(req.params.id,req.body||{},salesContext(req));emit('waitlist-close',{requestId:request.id});res.json(request);
  }));
  sales.post('/conversions',route(async(req,res)=>{
    const operation=await claimWaitlistConversion(req.params.id,req.body||{},salesContext(req));
    emit('waitlist-conversion',{requestId:operation.requestId});res.status(202).json({operation,request:await getWaitlistRequest(operation.requestId,salesContext(req))});
    void runtime.tick();
  }));
  sales.get('/conversions/:conversionId',route(async(req,res)=>{
    await getWaitlistRequest(req.params.id,salesContext(req));const operation=await getWaitlistConversion(req.params.conversionId);
    if(operation.requestId!==Number(req.params.id))throw waitlistError('SO conversion was not found.','WAITLIST_NOT_FOUND',404);res.json(operation);
  }));
  app.use('/api/sales/stock-requests/:id/waitlist',sales);
  const scm=Router();scm.use(scmRead);
  const context=req=>({operatorId:req.operator.id});
  scm.get('/purchase-orders',route(async(req,res)=>res.json({purchaseOrders:await searchWaitlistPurchaseOrders(req.query.search)})));
  scm.get('/requests',route(async(req,res)=>res.json({requests:await listWaitlistRequests({search:req.query.search,includeClosed:req.query.includeClosed==='true'})})));
  scm.get('/requests/:id',route(async(req,res)=>res.json(await getWaitlistRequest(req.params.id))));
  scm.post('/requests/:id/reject',scmWrite,route(async(req,res)=>{
    const request=await rejectWaitlistRequest(req.params.id,req.body||{},context(req));emit('waitlist-rejected',{requestId:request.id});res.json(request);
  }));
  scm.get('/pools',route(async(req,res)=>res.json({pools:await listWaitlistPools(context(req))})));
  scm.get('/pools/:id',route(async(req,res)=>res.json(await getWaitlistPool(req.params.id,context(req)))));
  scm.post('/pools',scmWrite,route(async(req,res)=>{
    const pool=await createWaitlistPool(req.body||{},context(req));emit('waitlist-pool',{poolId:pool.id});res.status(201).json(pool);
  }));
  scm.post('/pools/:id/allocations',scmWrite,route(async(req,res)=>{
    const pool=await allocateWaitlistPool(req.params.id,req.body||{},context(req));emit('waitlist-allocation',{poolId:pool.id});res.json(pool);
  }));
  scm.post('/allocations/:id/release',scmWrite,route(async(req,res)=>{
    const pool=await releaseWaitlistAllocation(req.params.id,req.body||{},context(req));emit('waitlist-returned',{poolId:pool.id});res.json(pool);
  }));
  scm.post('/pools/:id/read',route(async(req,res)=>res.json(await acknowledgeWaitlistPool(req.params.id,req.body||{},context(req)))));
  app.use('/api/scm/waitlist',scm);
}
