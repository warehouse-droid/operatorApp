import {createHash} from 'node:crypto';
import {inventoryError,inventoryId} from './inventory-workflow-domain.js';

function canonical(value) {
  if(Array.isArray(value)) {return value.map(canonical);}
  if(value && typeof value==='object') {return Object.fromEntries(Object.keys(value).filter(key=>key!=='links').sort().map(key=>[key,canonical(value[key])]));}
  return value;
}
function lines(record) {
  const inventory=record?.inventory;
  if(!Array.isArray(inventory?.items) || inventory.hasMore || Number(inventory.totalResults ?? inventory.items.length)!==inventory.items.length) {
    throw inventoryError('Read the complete Inventory Transfer before editing.',409);
  }
  const keys=inventory.items.map(line=>inventoryId(line.line,'transfer line'));
  if(new Set(keys).size!==keys.length) {throw inventoryError('The transfer has duplicate line keys.',409);}
  return inventory.items;
}
function header(record) {
  return {id:String(record.id),locationId:String(record.location?.id),destinationId:String(record.transferLocation?.id),memo:String(record.memo || '')};
}
export function damageTransferRevision(record) {
  return createHash('sha256').update(JSON.stringify(canonical({...header(record),modified:record.lastModifiedDate,lines:lines(record)}))).digest('hex');
}
function quantity(value) {
  if(!['string','number'].includes(typeof value) || !String(value).trim() || !Number.isFinite(Number(value)) || Number(value)<=0 || Number(value)>1e12) {
    throw inventoryError('Enter a positive quantity.');
  }
  const result=Number(Number(value).toFixed(6));
  if(result<=0) {throw inventoryError('Enter a positive quantity.');}
  return result;
}
function values(change) {
  const reason=Number(change.reasonId);
  if(!Number.isInteger(reason) || reason<5 || reason>9) {throw inventoryError('Choose an R1–R5 damage reason.');}
  return {item:{id:String(inventoryId(change.itemId,'SKU'))},adjustQtyBy:quantity(change.quantity),
    units:String(inventoryId(change.unitId,'unit')),custcol_atlas_rc_so:{id:String(reason)}};
}
export function planDamageAdjustment(record,input) {
  const before=lines(record),revision=damageTransferRevision(record);
  if(input.revision!==revision) {throw inventoryError('This Inventory Transfer changed. Refresh it before saving.',409,'DAMAGE_STALE');}
  const requestId=String(input.requestId || '').toLowerCase();
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId)) {throw inventoryError('A valid adjustment ID is required.');}
  const note=String(input.note || '').trim();
  if(!note || note.length>500) {throw inventoryError('Enter an adjustment note (maximum 500 characters).');}
  if(!Array.isArray(input.changes) || !input.changes.length || input.changes.length>100) {throw inventoryError('Save between 1 and 100 line changes.');}
  const removed=[],updated=[],added=[],seen=new Set();
  for(const [index,change] of input.changes.entries()) {
    if(!change || !['add','update','remove'].includes(change.action)) {throw inventoryError('Invalid line adjustment.');}
    if(change.action==='add') {
      if(change.line!==undefined && change.line!==null) {throw inventoryError('New lines cannot use an existing line key.');}
      added.push({...values(change),description:`C:${requestId.replaceAll('-','')}:${index}`});
      continue;
    }
    const key=inventoryId(change.line,'transfer line'),existing=before.find(row=>Number(row.line)===key);
    if(!existing || seen.has(key)) {throw inventoryError('Choose each existing transfer line at most once.');}
    seen.add(key);
    if(change.action==='remove') {removed.push(key);}
    else {updated.push({line:key,...values(change),description:String(existing.description || '').slice(0,40)});}
  }
  if(before.length-removed.length+added.length<1) {throw inventoryError('Keep at least one line on the Inventory Transfer.');}
  if(before.length-removed.length+added.length>1000) {throw inventoryError('An Inventory Transfer can contain at most 1,000 lines.');}
  const replace=removed.length>0;
  const items=replace?before.filter(row=>!removed.includes(Number(row.line))).map(row=>updated.find(value=>value.line===Number(row.line)) || {line:Number(row.line)}):updated;
  return {requestId,note,revision,header:header(record),replace,removed,updated,added,
    before:structuredClone(before),payload:{inventory:{items:[...items,...added]}}};
}
function comparable(line) {
  const ignored=new Set(['links','quantityAvailable','quantityOnHand','quantityOnHandToLocation','quantityAvailableToLocation']);
  return canonical(Object.fromEntries(Object.entries(line).filter(([key])=>!ignored.has(key)).map(([key,value])=>[
    key,value && typeof value==='object' && !Array.isArray(value) && value.id!==undefined?{id:String(value.id)}:value
  ])));
}
function same(actual,expected) {return JSON.stringify(comparable(actual))===JSON.stringify(comparable(expected));}
function matchesAddition(line,expected) {
  return Number(line.item?.id)===Number(expected.item.id) && Math.abs(Number(line.adjustQtyBy)-expected.adjustQtyBy)<1e-6
    && String(line.units)===expected.units && String(line.custcol_atlas_rc_so?.id)===expected.custcol_atlas_rc_so.id && line.description===expected.description;
}
export function damageAdjustmentApplied(record,plan) {
  if(JSON.stringify(canonical(header(record)))!==JSON.stringify(canonical(plan.header))) {return false;}
  const current=lines(record);
  if(plan.removed.some(key=>current.some(line=>Number(line.line)===key))) {return false;}
  for(const prior of plan.before.filter(line=>!plan.removed.includes(Number(line.line)))) {
    const actual=current.find(line=>Number(line.line)===Number(prior.line));
    const expected={...prior,...plan.updated.find(line=>line.line===Number(prior.line))};
    if(!actual || !same(actual,expected)) {return false;}
  }
  return plan.added.every(expected=>{
    const found=current.filter(line=>line.description===expected.description);
    return found.length===1 && matchesAddition(found[0],expected);
  });
}
