// @ts-check
/** @param {any} value @param {string} label @param {number} [limit] */
function text(value,label,limit=500) {
  const result=String(value || '').trim();
  if (!result || result.length>limit || /[\u0000-\u001f\u007f]/u.test(result)) {throw new Error(`Enter a valid ${label} (up to ${limit} characters).`);}
  return result;
}
/** @param {any} value */
function weight(value) {
  const result=Number(value);
  if (!Number.isFinite(result) || result<=0 || result>1_000_000) {throw new Error('Cargo weight must be greater than zero and at most 1,000,000 lb.');}
  return result;
}
/** @param {any} value @param {any} context @param {string} label */
function location(value,context,label) {
  if (label==='drop-off' && value?.kind==='destination') {return {...context.destination,sameAsDestination:true};}
  if (value?.kind==='yard') {
    const yard=context.yards.find((/** @type {any} */ y)=>y.id===value.id);
    if (!yard) {throw new Error(`Choose an active ${label} yard.`);}
    return {...yard};
  }
  if (value?.kind==='address') {
    const address=text(value.address,`${label} address`);
    return {kind:'address',id:address,name:address,address};
  }
  throw new Error(`Choose a ${label} location.`);
}
/** @param {any} input @param {any} context */
export function normalizeBinCargo(input,context) {
  const ordered=context.orderedMaterials || [],materials=input?.materials || [];
  assertCargoComposition(input,ordered,materials);
  if (input.mode==='none') {return {mode:'none',materials:[],totalWeightLbs:0};}
  if (input.mode==='custom') {return customCargo(input.custom,context);}
  return materialCargo(materials,ordered,context);
}
/** @param {any} input @param {any[]} ordered @param {any[]} materials */
function assertCargoComposition(input,ordered,materials) {
  if (input?.customOrders || Array.isArray(input?.custom)) {throw new Error('A bin accepts only one custom order.');}
  if (!['none','materials','custom'].includes(input?.mode)) {throw new Error('Choose materials or one custom order.');}
  if ((input.mode!=='materials' && (materials.length || ordered.length)) || (input.mode!=='custom' && input.custom)) {
    throw new Error('Purchased materials must remain on this order. A bin accepts materials or one custom order, never both.');
  }
}
/** @param {any[]} materials @param {any[]} ordered @param {any} context */
function materialCargo(materials,ordered,context) {
  if (!Array.isArray(materials) || !materials.length || materials.length>20) {throw new Error('Choose between 1 and 20 materials.');}
  const seen=new Set();
  const rows=materials.map((/** @type {any} */ item)=>{
    const purchased=ordered.find((/** @type {any} */ m)=>m.itemCode===item.itemCode);
    if (item.itemCode && (!purchased || seen.has(item.itemCode))) {throw new Error('The purchased material identity changed or was duplicated.');}
    if (purchased) {seen.add(item.itemCode);}
    return {itemCode:purchased?.itemCode || null,ordered:Boolean(purchased),
      description:purchased ? purchased.displayName : text(item.description,'material description'),
      quantityMilliYards:purchased?.quantityMilliYards || null,
      weightLbs:weight(purchased ? purchased.derivedWeightLbs : item.weightLbs),
      pickup:location(item.pickup,context,'pickup'),dropoff:location(item.dropoff,context,'drop-off')};
  });
  if (seen.size!==ordered.length) {throw new Error('All purchased materials require pickup and drop-off locations.');}
  return {mode:'materials',materials:rows,totalWeightLbs:rows.reduce((/** @type {number} */ n,/** @type {any} */ m)=>n+m.weightLbs,0)};
}
/** @param {any} item @param {any} context */
function customCargo(item,context) {
  const existing=existingCustom(item,context);
  const custom={source:item.source,...customIdentity(item,existing),
    pickup:location(item.pickup,context,'pickup'),dropoff:location(item.dropoff,context,'drop-off')};
  return {mode:'custom',custom,materials:[],totalWeightLbs:custom.weightLbs};
}
/** @param {any} item @param {any} context */
function existingCustom(item,context) {
  if (!item || !['one_off','existing'].includes(item.source)) {throw new Error('Choose one custom order or a one-off movement.');}
  const existing=item.source==='existing' ? context.customOrder : null;
  if (item.source==='existing' && (!existing || String(existing.id)!==String(item.orderId))) {throw new Error('Choose an available custom order.');}
  return existing;
}
/** @param {any} item @param {any} existing */
function customIdentity(item,existing) {
  return {orderId:existing ? String(existing.id) : null,
    reference:existing?.refNumber || null,expectedUpdatedAt:existing?.updatedAt || null,
    description:existing ? `${existing.refNumber} · ${existing.orderDetails}` : text(item.description,'cargo description'),
    weightLbs:weight(existing ? existing.weightLbs : item.weightLbs)};
}
/** @param {any} cargo */
export function binCargoItems(cargo) {return cargo?.mode==='custom' ? [cargo.custom] : cargo?.materials || [];}

/** Rebuild only cargo actions, retaining the physical-bin route and reference.
 * @param {any[]} steps @param {any} cargo */
export function binCargoSteps(steps,cargo) {
  const base=steps.filter(s=>!s.actionCode.startsWith('cargo_')).map(s=>{
    const {cargoDropoffs:_drops,cargoWeightLbs:_weight,...rest}=s;return rest;
  });
  const items=binCargoItems(cargo);
  if (!items.length) {return base;}
  const final=base.at(-1);
  if (!['deliver_bin','return_bin'].includes(final?.actionCode)) {throw new Error('Add cargo to the receiving delivery when this collection has no return stop.');}
  let aboard=0;
  const pickups=items.map((/** @type {any} */ item,/** @type {number} */ i)=>{
    aboard+=item.weightLbs;
    return {actionCode:`cargo_pickup_${i+1}`,reference:final.reference,displayName:`Pick up ${item.description}`,
      stopKind:'pickup',location:item.pickup,cargo:item,cargoWeightLbs:aboard};
  });
  const drops=items.flatMap((/** @type {any} */ item,/** @type {number} */ i)=>{
    if (item.dropoff.sameAsDestination) {return [];}
    aboard-=item.weightLbs;
    return [{actionCode:`cargo_dropoff_${i+1}`,reference:final.reference,displayName:`Drop off ${item.description}`,
      stopKind:'drop',location:item.dropoff,cargo:item,cargoWeightLbs:aboard}];
  });
  return [...base.slice(0,-1),...pickups,...drops,{...final,
    cargoDropoffs:items.filter((/** @type {any} */ item)=>item.dropoff.sameAsDestination),cargoWeightLbs:0}];
}
