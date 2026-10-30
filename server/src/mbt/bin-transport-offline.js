// @ts-check
/** Preserve the bounded transport portion of a server-issued Driver manifest.
 * Rental snapshots retain their existing fingerprints.
 * @param {any} value */
export function transportOfflineSnapshot(value) {
  if (!value.transportTripId) {return {};}
  const text=(/** @type {any} */ input,maximum=200)=>String(input ?? '').slice(0,maximum);
  const lines=(/** @type {any[]} */ input)=>(input || []).slice(0,500).map(row=>({lineKey:text(row.lineKey),
    itemId:text(row.itemId),description:text(row.description,1000),unit:text(row.unit,80),quantity:text(row.quantity,40)}));
  const cargo=(/** @type {any} */ item)=>item?{description:text(item.description,4000),quantity:item.quantity,
    weightLbs:Number(item.weightLbs),lines:lines(item.lines)}:null;
  return {transportTripId:text(value.transportTripId,64),sourceRef:text(value.sourceRef),sourceKind:text(value.sourceKind,80),
    planningGeneration:Number(value.planningGeneration),actionName:text(value.actionName),allocations:lines(value.allocations),
    cargo:cargo(value.cargo),cargoDropoffs:(value.cargoDropoffs || []).slice(0,1).map(cargo)};
}
