import express from 'express';
import {query} from './db.js';
import {INVENTORY_YARDS,inventoryDate,inventoryYards,assertInventoryYard,inventoryError} from './inventory-workflow-domain.js';
import {createCountSheet,listCountSheets,getCountSheet,changeCountSheet} from './count-sheet-repository.js';
import {CONFIRMED_RETURN_REASONS} from './return-netsuite.js';
import {getDamageItem} from './inventory-damage-netsuite.js';
import {submitDamageReport,getDamageReport,processDamageReport,reviewDamageMonth,retryDamageReport} from './inventory-damage-service.js';
const handler=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
function router() {
  const result=express.Router();result.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});return result;
}
export async function catalog(actor,input,{management=false,damage=false}={}) {
  const yard=assertInventoryYard(actor,input.locationId,management);
  const search=String(input.search || '').trim().slice(0,160);
  const offset=Math.max(0,Math.min(100000,Number(input.offset) || 0));
  return (await query(`SELECT i.item_id,i.item_name,i.item_description,i.stock_unit,i.to_plt,i.to_lyr,i.to_sec,i.to_pcs,
    i.raw->>'sales_unit' AS sales_unit,i.raw->>'sales_unit_id' AS sales_unit_id
    FROM inventory_items i JOIN inventory_balances b ON b.item_id=i.item_id
    WHERE b.location_id=$1 AND (NOT $3::boolean OR i.item_type='InvtPart')
    AND (i.item_name ILIKE $2 OR i.item_description ILIKE $2 OR i.display_name ILIKE $2)
    ORDER BY i.item_name,i.item_id LIMIT 50 OFFSET $4`,[yard,`%${search}%`,damage,offset])).rows;
}
export function createCountSheetRouter({management=false}={}) {
  const result=router();
  result.get('/config',handler(async(req,res)=>res.json({yards:INVENTORY_YARDS.filter(y=>inventoryYards(req.operator,management).includes(y.id))})));
  result.get('/',handler(async(req,res)=>res.json(await listCountSheets(req.operator,{management,locationId:req.query.locationId}))));
  if(management) {
    result.get('/catalog',handler(async(req,res)=>res.json(await catalog(req.operator,req.query,{management:true}))));
    result.post('/',handler(async(req,res)=>res.status(201).json(await createCountSheet(req.operator,req.body || {}))));
  }
  result.get('/:id',handler(async(req,res)=>res.json(await getCountSheet(req.operator,req.params.id,{management}))));
  result.post('/:id/:action',handler(async(req,res)=>{
    const actions=management?['edit','reset','cancel']:['take','line','submit'];
    if(!actions.includes(req.params.action)) {throw inventoryError('Invalid count-sheet action.');}
    res.json(await changeCountSheet(req.operator,req.params.id,req.params.action,req.body || {},{management}));
  }));
  return result;
}
export function createInventoryDamageRouter({getItem=getDamageItem,verifyPhotos,remote}={}) {
  const result=router();
  result.get('/config',handler(async(req,res)=>res.json({yards:INVENTORY_YARDS.filter(y=>inventoryYards(req.operator).includes(y.id)),
    reasons:CONFIRMED_RETURN_REASONS.filter(r=>r.kind==='quality'),month:inventoryDate().slice(0,7)})));
  result.get('/items',handler(async(req,res)=>res.json(await catalog(req.operator,req.query,{damage:true}))));
  result.get('/items/:id',handler(async(req,res)=>{
    const yard=assertInventoryYard(req.operator,req.query.locationId);res.json(await getItem(req.params.id,yard));
  }));
  result.get('/reports',handler(async(req,res)=>res.json(await reviewDamageMonth(req.operator,req.query.locationId,req.query.month || inventoryDate().slice(0,7),{remote}))));
  result.get('/reports/:id',handler(async(req,res)=>res.json(await getDamageReport(req.operator,req.params.id))));
  result.post('/reports',handler(async(req,res)=>{
    const report=await submitDamageReport(req.operator,req.body || {},{getItem,verifyPhotos});
    res.status(202).json(report);
    void processDamageReport(report.id,{remote}).catch(error=>console.error('Damage posting:',error.message));
  }));
  result.post('/reports/:id/retry',handler(async(req,res)=>res.json(await retryDamageReport(req.operator,req.params.id,{remote}))));
  return result;
}
