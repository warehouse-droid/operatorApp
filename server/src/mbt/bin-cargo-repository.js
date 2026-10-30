// @ts-check
import {query} from '../db.js';
import {MbtError} from './errors.js';
import {binCargoSteps} from './bin-cargo-domain.js';
/** @param {string} message @param {number} [status] */
export function cargoError(message,status=409) {return new MbtError({status,code:'MBT_BIN_CARGO_INVALID',message});}
/** @param {any} root @param {string} role */
export async function orderedBinCargo(root,role) {
  if (role!=='delivery') {return [];}
  let aggregate=root.service_snapshot?.attachedAggregate;
  if (!aggregate && root.order_kind==='delivery') {
    aggregate=(await query('SELECT pricing_snapshot FROM mbt_contract_service_lines WHERE service_line_id=$1',[root.service_line_id])).rows[0]?.pricing_snapshot?.attachedAggregate;
  }
  return aggregate?.materials || [];
}
export async function binCargoYards() {
  return (await query(`SELECT yard_id::text AS id,'yard' AS kind,display_name AS name,yard_code AS "yardCode",
    concat_ws(', ',NULLIF(address_line_1,''),NULLIF(address_line_2,''),NULLIF(city,''),NULLIF(region,''),NULLIF(postal_code,'')) AS address
    FROM mbt_yards WHERE active ORDER BY yard_code`)).rows;
}
/** @param {string} orderId @param {string} role */
export async function savedBinCargo(orderId,role) {
  return (await query('SELECT * FROM mbt_bin_cargo_plans WHERE order_id=$1 AND part_role=$2',[orderId,role])).rows[0];
}
/** Merge newly ordered materials into the editable route without inventing pickups.
 * @param {any} saved @param {any[]} ordered */
export function binCargoDraft(saved,ordered) {
  const cargo=saved || {mode:'none',materials:[],totalWeightLbs:0};
  const manual=(cargo.materials || []).filter((/** @type {any} */ item)=>!item.itemCode);
  const purchased=ordered.map(m=>{
    const previous=cargo.materials?.find((/** @type {any} */ item)=>item.itemCode===m.itemCode);
    return {itemCode:m.itemCode,ordered:true,description:m.displayName,quantityMilliYards:m.quantityMilliYards,
      weightLbs:m.derivedWeightLbs,pickup:previous?.pickup || null,dropoff:previous?.dropoff || {kind:'destination'}};
  });
  return cargoDraft(ordered.length || cargo.mode==='materials' ? {mode:'materials',materials:[...purchased,...manual]} : cargo);
}
/** @param {any} root @param {any} part */
export async function withBinCargo(root,part) {
  const saved=await savedBinCargo(root.service_visit_id,part.role);
  return {...part,cargoPlan:saved?.plan || null,steps:binCargoSteps(part.steps,saved?.plan)};
}
/** @param {any} visit */
export async function assertBinCargoReady(visit) {
  const wf=visit.service_snapshot?.binWorkflow;
  if (!wf) {return;}
  const root=(await query(`SELECT v.*,o.order_kind FROM mbt_service_visits v JOIN mbt_bin_orders o ON o.order_id=v.service_visit_id WHERE v.service_visit_id=$1`,[wf.orderId])).rows[0];
  const ordered=await orderedBinCargo(root,wf.role),plan=visit.service_snapshot.cargoPlan;
  const actual=(plan?.materials || []).filter((/** @type {any} */ item)=>item.ordered);
  if (actual.length!==ordered.length || ordered.some((/** @type {any} */ m)=>!plan?.materials?.some((/** @type {any} */ item)=>
    item.itemCode===m.itemCode && item.weightLbs===Number(m.derivedWeightLbs) && item.pickup?.address))) {
    throw cargoError("Choose each material's pickup in Plan Delivery and save the route before assigning this order.");
  }
  await assertBinCargoPayload(visit.bin_type_id,plan);
}
/** @param {string} binTypeId @param {any} cargo */
export async function assertBinCargoPayload(binTypeId,cargo) {
  if (!cargo?.totalWeightLbs) {return;}
  const type=(await query('SELECT maximum_payload_kg FROM mbt_bin_types WHERE bin_type_id=$1',[binTypeId])).rows[0];
  if (type?.maximum_payload_kg!==null && cargo.totalWeightLbs>Number(type?.maximum_payload_kg || 0)*2.2046226218) {throw cargoError('Cargo exceeds this bin type’s payload capacity.');}
}
/** The caller locks the canonical Custom Order row before checking this claim.
 * @param {string} customOrderId @param {string|null} [orderId] @param {string|null} [role] */
export async function assertCustomOrderNotInBin(customOrderId,orderId=null,role=null) {
  const claim=(await query(`SELECT o.display_reference FROM mbt_bin_cargo_plans c JOIN mbt_bin_orders o USING(order_id)
    WHERE c.custom_order_id=$1 AND c.completed_at IS NULL AND NOT (c.order_id IS NOT DISTINCT FROM $2::uuid AND c.part_role IS NOT DISTINCT FROM $3)`,
  [customOrderId,orderId,role])).rows[0];
  if (claim) {throw cargoError(`This Custom Order is carried by ${claim.display_reference}. Remove it in the BIN plan before changing or planning it elsewhere.`);}
}
/** Called in the driver completion transaction. @param {any} context */
export async function finishBinCargo(context) {
  const visit=context.rows.visit,wf=visit.service_snapshot?.binWorkflow;
  if (!wf) {return;}
  const stop=visit.service_snapshot.mandatoryStops.find((/** @type {any} */ s)=>s.actionCode===context.step.action_code);
  const items=stop?.actionCode.startsWith('cargo_dropoff_') ? [stop.cargo] : stop?.cargoDropoffs || [];
  for (const item of items.filter((/** @type {any} */ i)=>i?.source==='existing')) {
    const claim=(await query(`UPDATE mbt_bin_cargo_plans SET completed_at=$3,updated_at=now()
      WHERE order_id=$1 AND part_role=$2 AND completed_at IS NULL AND custom_order_id=$4 RETURNING custom_order_id`,
    [wf.orderId,wf.role,context.normalized.occurredAt,item.orderId])).rows[0];
    if (claim) {await query(`UPDATE dispatch_custom_orders SET status='completed',completed_at=COALESCE(completed_at,$2),updated_at=now(),updated_by=$3
      WHERE id=$1 AND status='open'`,[claim.custom_order_id,context.normalized.occurredAt,`driver:${context.normalized.driverLogin}`]);}
  }
}
/** @param {any} cargo */
export function cargoDraft(cargo) {
  const convert=(/** @type {any} */ item)=>({...item,dropoff:item.dropoff?.sameAsDestination ? {kind:'destination'} : item.dropoff});
  return {...cargo,materials:(cargo.materials || []).map(convert),...(cargo.custom ? {custom:convert(cargo.custom)} : {})};
}
