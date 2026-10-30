import {getBackorderRequest,runBackorderAction} from './backorder-request-service.js';
import {searchSpecialVendors,searchSpecialOrderLinks,listSpecialPurchaseOrderSplits} from './special-stock-request-repository.js';
import {withBackorderWorkflow} from './stock-case-workflow.js';
import {readSpecialPurchaseOrderNote,saveSpecialPurchaseOrderRouting} from './special-stock-purchase-order-routing.js';
import {createSpecialQuoteService,createSpecialOrderDocumentService} from './special-stock-documents.js';
import {previewStockingBackorderConversion,convertStockingToBackorder} from './stocking-backorder-conversion.js';

/** @param {import('express').Application} app
 * @param {{salesGuards:import('express').RequestHandler[],scmRead:import('express').RequestHandler,scmWrite:import('express').RequestHandler,salesContext:(req:any)=>{operatorId:string,authorizedDestinationLocationIds:number[]},emit:(source:string,payload:any)=>void}} options */
export function mountBackorderRoutes(app,{salesGuards,scmRead,scmWrite,salesContext,emit}) {
  const poPrefix='/api/scm/stock-requests/:id/backorder/purchase-order/';
  for (const [action,read] of Object.entries({splits:listSpecialPurchaseOrderSplits,note:readSpecialPurchaseOrderNote})) {
    app.get(poPrefix+action,scmRead,async(req,res,next)=>{
      try {
        res.setHeader('Cache-Control','private, no-store');
        res.json(await withBackorderWorkflow(()=>read(req.params.id)));
      } catch(error) {next(error);}
    });
  }
  app.put(poPrefix+'routing',scmWrite,async(req,res,next)=>{
    try {
      const result=await withBackorderWorkflow(()=>saveSpecialPurchaseOrderRouting(req.params.id,req.body || {},
        {operatorId:(/** @type {import('express').Request & {operator:{id:string}}} */ (req)).operator.id}));
      emit('backorder-po-routing',{requestId:Number(req.params.id)});
      res.json(result);
    } catch(error) {next(error);}
  });
  app.get('/api/scm/stock-requests/:id/backorder-conversion',scmWrite,async(req,res,next)=>{
    try{
      res.setHeader('Cache-Control','private, no-store');
      res.json(await previewStockingBackorderConversion(req.params.id,{operatorId:(/** @type {import('express').Request & {operator:{id:string}}} */ (req)).operator.id,audience:'scm'}));
    }catch(error){next(error);}
  });
  app.post('/api/scm/stock-requests/:id/backorder-conversion',scmWrite,async(req,res,next)=>{
    try{
      const request=await convertStockingToBackorder(req.params.id,req.body || {},{operatorId:(/** @type {import('express').Request & {operator:{id:string}}} */ (req)).operator.id,audience:'scm'});
      emit('stocking-backorder-converted',{requestId:request.id});res.json(request);
    }catch(error){next(error);}
  });
  const quote=createSpecialQuoteService({getCase:getBackorderRequest});
  const orders=createSpecialOrderDocumentService({getCase:getBackorderRequest});
  for (const audience of ['sales','scm']) {
    const prefix=`/api/${audience}/stock-requests`, read=audience==='sales'?salesGuards:[scmRead], write=audience==='sales'?salesGuards:[scmWrite];
    const context=(/** @type {any} */ req)=>({operatorId:req.operator.id,audience,
      ...(audience==='sales'?{authorizedStoreLocationIds:salesContext(req).authorizedDestinationLocationIds}:{})});
    app.get(prefix+'/backorder/vendors',...read,async(req,res,next)=>{
      try{res.setHeader('Cache-Control','private, no-store');res.json({vendors:await searchSpecialVendors(req.query)});}catch(e){next(e);}
    });
    app.get(prefix+'/backorder/order-links',...read,async(req,res,next)=>{
      try{res.setHeader('Cache-Control','private, no-store');res.json({orders:await searchSpecialOrderLinks(req.query)});}catch(e){next(e);}
    });
    for (const kind of ['sales_order','purchase_order']) app.get(prefix+'/:id/backorder/'+kind.replaceAll('_','-')+'/document.pdf',...read,async(req,res,next)=>{
      try{
        const document=await orders.preview(req.params.id,kind,context(req));
        res.setHeader('Cache-Control','private, no-store');res.type('application/pdf');res.setHeader('Content-Disposition',`inline; filename="${document.filename}"`);res.send(document.buffer);
      }catch(e){next(e);}
    });
    if (audience==='sales') app.get(prefix+'/:id/backorder/quote.pdf',...read,async(req,res,next)=>{
      try{
        const document=await quote.savedQuote(req.params.id,context(req));
        res.setHeader('Cache-Control','private, no-store');res.type('application/pdf');res.setHeader('Content-Disposition',`inline; filename="${document.filename}"`);res.send(document.buffer);
      }catch(e){next(e);}
    });
    app.post(prefix+'/:id/backorder/*',...write,async(req,res,next)=>{
      try{
        const action=String(req.params[0]);
        const request=await runBackorderAction(req.params.id,action,req.body || {},context(req));
        emit('backorder-'+action,{requestId:request.id});res.json(request);
      }catch(e){next(e);}
    });
  }
}
