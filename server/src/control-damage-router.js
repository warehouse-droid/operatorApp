import express from 'express';
import {INVENTORY_YARDS,inventoryDate,inventoryYards,assertInventoryYard,inventoryId,inventoryError} from './inventory-workflow-domain.js';
import {CONFIRMED_RETURN_REASONS} from './return-netsuite.js';
import {catalog} from './operator-inventory-router.js';
import {controlDamageNetSuite} from './control-damage-netsuite.js';
import {reviewControlDamageMonth} from './control-damage-review.js';
import {queueDamageAdjustment,processDamageAdjustment,getDamageAdjustment,retryDamageAdjustment} from './control-damage-service.js';
import {damageRow,damageEvent} from './inventory-damage-repository.js';
import {processDamageReport} from './inventory-damage-service.js';
const handler=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
export function createControlDamageRouter({remote=controlDamageNetSuite}={}) {
  const router=express.Router();
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  router.get('/config',handler(async(req,res)=>res.json({yards:INVENTORY_YARDS.filter(yard=>inventoryYards(req.operator,true).includes(yard.id)),
    reasons:CONFIRMED_RETURN_REASONS.filter(reason=>reason.kind==='quality'),month:inventoryDate().slice(0,7)})));
  router.get('/catalog',handler(async(req,res)=>res.json(await catalog(req.operator,req.query,{management:true,damage:true}))));
  router.get('/items/:id',handler(async(req,res)=>{
    const yard=assertInventoryYard(req.operator,req.query.locationId,true),id=inventoryId(req.params.id,'SKU');
    const item=await remote.item(id,yard);
    if(!item || item.item_type!=='InvtPart') {throw inventoryError('Choose an active inventory SKU at this yard.');}
    res.json({...item,units:await remote.itemUnits(id)});
  }));
  router.get('/review',handler(async(req,res)=>res.json(await reviewControlDamageMonth(req.operator,req.query.locationId,req.query.month || inventoryDate().slice(0,7),{remote}))));
  router.post('/adjustments',handler(async(req,res)=>{
    const adjustment=await queueDamageAdjustment(req.operator,req.body || {},{remote});
    res.status(adjustment.status==='posted'?200:202).json(adjustment);
    void processDamageAdjustment(adjustment.id,{remote}).catch(error=>console.error('Damage adjustment:',error.message));
  }));
  router.get('/adjustments/:id',handler(async(req,res)=>res.json(await getDamageAdjustment(req.operator,req.params.id))));
  router.post('/adjustments/:id/retry',handler(async(req,res)=>res.json(await retryDamageAdjustment(req.operator,req.params.id,{remote}))));
  router.post('/reports/:id/retry',handler(async(req,res)=>{
    const report=await damageRow(req.params.id);
    if(!report) {throw inventoryError('Damage report not found.',404);}
    assertInventoryYard(req.operator,report.location_id,true);
    await damageEvent(report.id,'control_recheck',{actorId:req.operator.id});
    await processDamageReport(report.id,{remote});res.json(await damageRow(report.id));
  }));
  return router;
}
