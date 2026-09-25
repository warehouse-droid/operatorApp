import {Router} from 'express';
import {isSorFeatureEnabled} from './sor-feature-gate.js';
import {query} from './db.js';
import {listSorItems,sorItemImpact,updateSorItemPolicy,getSorSignatureSettings,updateSorSignatureSettings} from './sor-rental-repository.js';

export function sorAdminRouter({tick=async()=>({})}={}) {
  const router=Router();
  const route=fn=>async(req,res,next)=>{try{res.set('Cache-Control','private, no-store');res.json(await fn(req));}catch(error){next(error);}};
  router.get('/settings',route(async()=>({featureEnabled:await isSorFeatureEnabled(),signature:await getSorSignatureSettings(),
    pending:(await query('SELECT source_ref,attempts,last_error FROM sor_return_reconcile_queue ORDER BY requested_at LIMIT 100')).rows,
    review:(await query("SELECT ref_number,parent_order_ref,CASE WHEN pickup_location='' THEN 'Customer pickup address is missing. Update the source delivery address.' ELSE sor_review_reason END AS sor_review_reason FROM dispatch_custom_orders WHERE order_kind='sor_rental_return' AND (sor_review_reason<>'' OR pickup_location='') AND status='open'")).rows})));
  router.put('/settings',route(req=>updateSorSignatureSettings({...req.body,actor:String(req.operator.id)})));
  router.get('/items',route(req=>listSorItems(req.query)));
  router.get('/items/:id/impact',route(req=>sorItemImpact(req.params.id)));
  router.put('/items/:id',route(async req=>{
    const item=await updateSorItemPolicy(req.params.id,{...req.body,actor:String(req.operator.id)});
    const reconciliation=await tick();return {item,reconciliation,impact:await sorItemImpact(req.params.id)};
  }));
  return router;
}
