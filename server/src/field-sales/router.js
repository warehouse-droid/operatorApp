import express from 'express';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { requireFieldSales,isAdmin,fail,uuid,text,normalizeAddress,proposeOrder,OUTCOMES,STAGES,calculateQuote,torontoDate } from '../../public/field-sales/domain.js';
import { saveQuoteEvidence } from './evidence.js';
import {quoteDates} from '../../public/field-sales/quote-drafts.js';
import { quoteProfile } from './company-quotes.js';
import { quotePdf } from './pdf.js';
import { estimateSalesRoute } from './routes.js';

export function createFieldSalesRouter({repo,catalog,importer,maps,browserMap,postingEnabled=false,integrationHealth}) {
  const router=express.Router();
  const wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
  const admin=req=>{if(!isAdmin(req.operator)){throw fail('Admin access is required.',403);}};
  router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');try{requireFieldSales(req.operator);next();}catch(e){next(e);}});
  router.get('/status',wrap(async(req,res)=>res.json({operator:req.operator,settings:await repo.settings(),postingAvailable:postingEnabled,outcomes:OUTCOMES,stages:STAGES})));
  router.get('/integration-status',wrap(async(req,res)=>{
    admin(req);const s=(await repo.settings()).data,missing=[];
    for(const c of ['MBBS','MBT','MBR']){for(const k of ['subsidiaryId','salesOrderFormId','currencyId','locationId']){if(!/^[1-9]\d*$/.test(String(s.companies[c]?.[k]||''))){missing.push(`${c} ${k}`);}}}
    let remote=null;try{remote=integrationHealth?await integrationHealth():null;}catch{/* Readiness stays available when NetSuite is not configured or reachable. */}
    const compatible=remote?.version==='2.1.0'&&remote.customerMode==='existing-only';
    res.json({serverEnabled:postingEnabled,settingEnabled:s.salesOrderPostingEnabled===true,compatible,missing,
      remote:compatible?{environment:remote.environment,writesEnabled:remote.writesEnabled,multiSubsidiaryCustomers:remote.multiSubsidiaryCustomers,suiteTax:remote.suiteTax}:null,
      message:compatible?'Validate Sales Order forms and existing customer links in the NetSuite sandbox before enabling submission.':'Configure the dedicated Field Sales RESTlet URL and deploy version 2.1 for Sales Orders using existing NetSuite customers.'});
  }));
  router.put('/settings',wrap(async(req,res)=>res.json(await repo.saveSettings(req.operator,req.body))));
  router.use((req,res,next)=>repo.settings().then(s=>s.data.enabled?next():next(fail('Field Sales is disabled. An admin can enable it in Settings.',409,'FIELD_SALES_DISABLED'))).catch(next));
  router.post('/commands',wrap(async(req,res)=>res.json(await repo.command(req.operator,req.body))));
  router.get('/jobsites',wrap(async(req,res)=>res.json(await repo.listJobsites(req.query))));
  router.get('/facets',wrap(async(req,res)=>res.json(await repo.facets())));
  router.get('/map',wrap(async(req,res)=>res.json({items:await repo.mapJobsites(req.query)})));
  router.get('/jobsites/:id',wrap(async(req,res)=>res.json(await repo.getJobsite(req.params.id))));
  router.get('/routes',wrap(async(req,res)=>res.json({items:await repo.listRoutes(req.operator,req.query.date)})));
  router.get('/routes/:id',wrap(async(req,res)=>res.json(await repo.getRoute(req.params.id))));
  router.get('/reps',wrap(async(req,res)=>res.json({items:await repo.listReps()})));
  router.get('/followups',wrap(async(req,res)=>res.json({items:await repo.listFollowups(req.operator)})));
  router.get('/quotes',wrap(async(req,res)=>res.json({items:await repo.listQuotes()})));
  router.get('/quotes/:id',wrap(async(req,res)=>res.json(await repo.getQuote(req.params.id,req.query.revision))));
  router.post('/quotes/:id/evidence',wrap(async(req,res)=>res.json(await saveQuoteEvidence(repo.db,req.operator,req.params.id,req.body))));
  router.get('/quote-evidence/:id',wrap(async(req,res)=>{
    const e=(await repo.db.query('SELECT * FROM field_sales_quote_evidence WHERE id=$1',[uuid(req.params.id)])).rows[0];
    if(!e){throw fail('Confirmation evidence not found.',404);}res.type(e.content_type).set('X-Content-Type-Options','nosniff').set('Content-Disposition',`attachment; filename="evidence-${e.id}.${e.content_type==='application/pdf'?'pdf':'jpg'}"`).send(e.content);
  }));
  router.post('/template-preview',wrap(async(req,res)=>{
    admin(req);const company=req.body.company,s=(await repo.settings()).data;
    if(!['MBBS','MBT','MBR'].includes(company)){throw fail('Choose a company.');}
    const profile=quoteProfile({...s.companies[company],...req.body.profile});
    const snapshot={...calculateQuote({lines:[{company,itemId:'sample',sku:'SAMPLE-ITEM',description:'Sample quote item 建筑材料',quantity:'2',unitRate:'25',unit:'EA'}]},{[company]:profile}),schemaVersion:2,simpleDetails:true,...quoteDates(torontoDate(),profile),company,companyProfiles:{[company]:profile},jobsite:{address:'90 Belfield Road'},customerName:'Sample customer',billToAddress:'Toronto, Ontario',shipToAddress:'90 Belfield Road',quoteDate:torontoDate(),salesRep:req.operator.display_name,shippingMethod:'Delivery',note:'Sample memo / 报价备注'};
    res.type('pdf').set('Content-Disposition','attachment; filename="quote-template-preview.pdf"').send(await quotePdf({number:`FS-${company}-SAMPLE`,selected_revision:1,snapshot}));
  }));
  router.get('/quotes/:id/reconciliation',wrap(async(req,res)=>{admin(req);res.json({states:await repo.publicationState(req.params.id)});}));
  router.get('/quotes/:id/pdf',wrap(async(req,res)=>{
    const quote=await repo.getQuote(req.params.id,req.query.revision);
    const pdf=await quotePdf(quote,req.query.company);
    res.type('pdf').set('Content-Disposition',`attachment; filename="${quote.number}-r${quote.selected_revision}-${req.query.company||quote.company||'combined'}.pdf"`).send(pdf);
  }));
  router.get('/catalog',wrap(async(req,res)=>res.json({items:await catalog.search(req.query)})));
  router.post('/catalog/price',wrap(async(req,res)=>res.json(await catalog.price(req.body.company,req.body.itemId,req.body))));
  router.post('/catalog/refresh',wrap(async(req,res)=>{admin(req);res.json(await catalog.refresh());}));
  router.get('/customer-records',wrap(async(req,res)=>res.json(await repo.listCustomers(req.query))));
  router.get('/customer-records/:id',wrap(async(req,res)=>res.json(await repo.getCustomer(req.params.id))));
  router.get('/customer-types',wrap(async(req,res)=>res.json({items:await repo.listCustomerTypes()})));
  router.get('/customer-types/:id',wrap(async(req,res)=>{const item=(await repo.listCustomerTypes()).find(t=>t.id===uuid(req.params.id));if(!item){throw fail('Customer type not found.',404);}res.json(item);}));
  router.get('/customers',wrap(async(req,res)=>res.json({items:await catalog.customers(req.query.search)})));
  router.post('/map-session',wrap(async(req,res)=>res.json(await browserMap({actorId:req.operator.id,sessionId:text(req.body.sessionId,120),automatic:false}))));
  router.post('/route-estimate',wrap(async(req,res)=>res.json(await estimateSalesRoute(req.body,maps,req.operator))));
  router.post('/route-order',wrap(async(req,res)=>{
    if(!Array.isArray(req.body.stops)||req.body.stops.length>250){throw fail('A route supports up to 250 stops.');}
    res.json({stops:proposeOrder(req.body.stops,req.body.origin),method:'Geographic suggestion; review road estimate before applying.'});
  }));
  router.post('/locate',wrap(async(req,res)=>{
    const address=text(req.body.address,500);if(!address){throw fail('Address is required.');}
    const local=(await repo.db.query('SELECT * FROM field_sales_addresses WHERE address_key=$1 AND NOT ambiguous',[normalizeAddress(address)])).rows[0];
    const point=local||await maps.geocode({address,subsystem:'driver_geocode',reason:'manual_refresh',automatic:false,actorId:req.operator.id});
    if(!point){throw fail('Coordinates are unavailable. You can still save this address.',409);}res.json(point);
  }));
  router.get('/imports',wrap(async(req,res)=>res.json({items:await importer.history()})));
  router.post('/imports/:source',wrap(async(req,res)=>{
    admin(req);if(!['planning','permits','addresses','postal'].includes(req.params.source)){throw fail('Unknown City source.');}
    importer.run(req.params.source).catch(error=>console.error('[field-sales import]',error.message));
    res.status(202).json({accepted:true,source:req.params.source});
  }));
  router.post('/photos',wrap(async(req,res)=>{
    const id=uuid(req.body.id),visitId=uuid(req.body.visitId),encoded=String(req.body.base64||'');
    if(encoded.length>11200000||!encoded||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)){throw fail('Photo must be a valid image smaller than 8 MB.');}
    const original=Buffer.from(encoded,'base64');if(original.length>8388608){throw fail('Photo is too large.');}
    const hash=createHash('sha256').update(original).digest('hex');
    const prior=(await repo.db.query('SELECT visit_id,sha256,actor_id FROM field_sales_photos WHERE id=$1',[id])).rows[0];
    if(prior){if(prior.visit_id!==visitId||prior.sha256!==hash||prior.actor_id!==String(req.operator.id)){throw fail('This photo ID already contains different work.',409);}return res.json({id});}
    const visit=(await repo.db.query('SELECT actor_id FROM field_sales_visits WHERE id=$1',[visitId])).rows[0];
    if(!visit){throw fail('Save the visit before uploading photos.',409);}
    if(visit.actor_id!==String(req.operator.id)&&!isAdmin(req.operator)){throw fail('Only the visiting rep or an admin can add photos.',403);}
    let content;try{content=await sharp(original,{limitInputPixels:50000000}).rotate().resize(2400,2400,{fit:'inside',withoutEnlargement:true}).jpeg({quality:82}).toBuffer();}catch{throw fail('This photo could not be read. Use JPEG, PNG, or WebP.');}
    await repo.db.transaction(async()=>{
      await repo.db.query('SELECT id FROM field_sales_visits WHERE id=$1 FOR UPDATE',[visitId]);
      const concurrent=(await repo.db.query('SELECT visit_id,sha256,actor_id FROM field_sales_photos WHERE id=$1',[id])).rows[0];
      if(concurrent){if(concurrent.visit_id!==visitId||concurrent.sha256!==hash||concurrent.actor_id!==String(req.operator.id)){throw fail('Photo conflict.',409);}return;}
      const count=Number((await repo.db.query('SELECT count(*) FROM field_sales_photos WHERE visit_id=$1',[visitId])).rows[0].count);
      if(count>=30){throw fail('A visit supports up to 30 photos.');}
      const result=await repo.db.query('INSERT INTO field_sales_photos(id,visit_id,actor_id,content,sha256) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',[id,visitId,req.operator.id,content,hash]);
      if(!result.rowCount){const existing=(await repo.db.query('SELECT * FROM field_sales_photos WHERE id=$1',[id])).rows[0];if(existing.sha256!==hash||existing.visit_id!==visitId||existing.actor_id!==String(req.operator.id)){throw fail('Photo conflict.',409);}}
    });
    res.json({id});
  }));
  router.get('/photos/:id',wrap(async(req,res)=>{
    const p=(await repo.db.query('SELECT content,content_type FROM field_sales_photos WHERE id=$1',[uuid(req.params.id)])).rows[0];
    if(!p){throw fail('Photo not found.',404);}res.type(p.content_type).set('X-Content-Type-Options','nosniff').send(p.content);
  }));
  router.use((error,req,res,next)=>{
    if(res.headersSent){return next(error);}
    const status=Number(error.status)||500;
    if(status>=500){console.error('[field-sales]',error.message);}
    res.status(status).json({error:status>=500?'Field Sales could not complete this request. Your unsynced work is retained.':error.message,code:error.code||'FIELD_SALES_ERROR'});
  });
  return router;
}
