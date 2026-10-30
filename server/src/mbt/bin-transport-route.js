// @ts-check
import {query} from '../db.js';
import {binWorkflowLocation} from './bin-order-workflow-repository.js';
import {transportError} from './bin-transport-domain.js';

/** @param {any} input */
export async function transportLocation(input) {
  if (input?.kind==='yard') {return binWorkflowLocation('yard',String(input.id));}
  if (input?.kind==='address' && typeof input.address==='string' && input.address.trim().length>=5 && input.address.length<=1000) {
    return {kind:'address',id:input.address.trim().toLowerCase(),name:input.address.trim(),address:input.address.trim()};
  }
  throw transportError('Choose an active yard or enter the full pickup address.');
}

/** @param {string} address @param {string} [name] */
async function sourceLocation(address,name) {
  const yard=(await query("SELECT yard_id FROM mbt_yards WHERE active AND (yard_code=$1 OR $1 ILIKE '%'||address_line_1||'%') ORDER BY yard_code LIMIT 1",[address])).rows[0];
  if (yard) {return binWorkflowLocation('yard',yard.yard_id);}
  const location=await transportLocation({kind:'address',address});
  return {...location,name:name || location.name};
}
/** @param {any} snapshot @param {any} input */
async function cargoPickup(snapshot,input) {
  if (['aggregate','frontdesk_aggregate'].includes(snapshot.kind)) {return transportLocation(input.pickup);}
  if (snapshot.kind==='sor_delivery') {return sourceLocation('3445');}
  return sourceLocation(String(snapshot.sourceAddress || snapshot.pickupLocations[0] || ''));
}

/** SOR destinations and windows come from the original order.
 * @param {any} source @param {any} input @param {any} emptySource @param {number} weight */
export async function buildTransportRoute(source,input,emptySource,weight) {
  const snapshot=source.snapshot;
  const pickup=await cargoPickup(snapshot,input);
  const destination=await sourceLocation(snapshot.address,snapshot.customer);
  const returnDestination=input.returnDestination || {kind:'yard',id:emptySource.kind==='yard'?emptySource.id:null};
  if (!['yard','delivery'].includes(returnDestination.kind)) {throw transportError('Choose an active return yard or an existing BIN delivery.');}
  const returning=returnDestination.kind==='yard'?await transportLocation(returnDestination):null;
  const action=(/** @type {string} */ code,/** @type {string} */ name,/** @type {any} */ location,/** @type {number} */ cargoWeightLbs)=>({
    actionCode:code,displayName:name,location,planningAddress:location.address,yardId:location.kind==='yard'?location.id:null,
    yardCode:location.yardCode || null,type:code==='collect_empty_bin' || code.startsWith('cargo_pickup')?'pickup':'dropoff',cargoWeightLbs,
    evidenceRequirements:[{code:'bin_scan',type:'bin_scan',assetRole:'expected'},{code:'bin_photo',type:'photo',minimumCount:1}]});
  const stops=[...(emptySource.kind==='truck'?[]:[action('collect_empty_bin','Pick up empty bin',emptySource,0)]),
    action('cargo_pickup_1',snapshot.kind==='sor_return'?'Collect machine':'Pick up cargo',pickup,weight),
    action('cargo_dropoff_1','Unload cargo',destination,0),...(returning?[action('return_bin','Return empty bin',returning,0)]:[])]
    .map((stop,index)=>({...stop,sequence:index+1}));
  return {source:emptySource,pickup,destination,returnDestination:returning?{kind:'yard',location:returning}
    :{kind:'delivery',visitId:String(returnDestination.visitId)},stops,
    windowStart:snapshot.windowStart,windowEnd:snapshot.windowEnd};
}
