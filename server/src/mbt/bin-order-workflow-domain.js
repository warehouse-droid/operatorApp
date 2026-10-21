// @ts-check

/** @param {unknown} value @param {string} label */
function positiveNumber(value, label) {
  const text = String(value ?? "");
  if (!/^[1-9]\d*$/u.test(text) || (typeof value === "number" && !Number.isSafeInteger(value))) {
    throw new Error(`A positive whole ${label} number is required.`);
  }
  return text;
}

/** @param {unknown} number @param {any} [options] */
export function binOrderReference(number, options = {}) {
  const base = `BIN${positiveNumber(number, "rental").padStart(5, "0")}`;
  if (options.kind === "delivery") {return `${base}D`;}
  if (options.kind === "collection") {
    if (options.action === "dump") {return `${base}C-DP`;}
    if (options.action === "return") {return `${base}-R`;}
    return `${base}C`;
  }
  if (options.kind !== "exchange") {throw new Error("A valid BIN order class is required.");}
  const suffixes=/** @type {Record<string,string>} */ ({delivery:"D",collection:"C",dump:"DP",return:"R"});
  const suffix = suffixes[options.action] || "";
  return `${base}X-${positiveNumber(options.exchangeNumber, "exchange")}${suffix}`;
}

/** @param {unknown} value */
export function binLocalDate(value) {
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) {throw new Error("A valid BIN schedule date is required.");}
  return new Intl.DateTimeFormat("en-CA", {timeZone:"America/Toronto",year:"numeric",month:"2-digit",day:"2-digit"}).format(date);
}

/** @param {any} window */
function validWindow(window) {
  if (!window?.startAt || !window?.endAt || !(Date.parse(window.endAt) > Date.parse(window.startAt))) {
    throw new Error("A BIN schedule requires a start time and a later finish time.");
  }
  return {startAt:new Date(window.startAt).toISOString(),endAt:new Date(window.endAt).toISOString()};
}

/** @param {any} location @param {string} label */
function validLocation(location, label) {
  if (!location?.id || !["yard","customer_site","dump_site","truck"].includes(location.kind)
      || !String(location.address || "").trim() || /^(undefined|null|unknown)$/iu.test(location.address)) {
    throw new Error(`A confirmed ${label} location is required.`);
  }
  return structuredClone(location);
}

/** @param {any} input @param {string} action */
const reference = (input, action) => binOrderReference(input.rentalNumber, {...input,action});

/** @param {any} input @param {string} actionCode @param {string} action @param {any} location */
function step(input, actionCode, action, location) {
  return {actionCode,reference:reference(input,action),location,
    stopKind:["pickup_bin","collect_empty_bin"].includes(actionCode) ? "pickup" : "drop",
    displayName:{pickup_bin:"Collect bin",collect_empty_bin:"Pick up empty bin",deliver_bin:"Deliver bin",dump_bin:"Dump bin",return_bin:"Return bin"}[actionCode]};
}

/** @param {any} input */
function deliveryPart(input) {
  if (!input.deliveryAssetId) {throw new Error("Choose a physical delivery bin.");}
  const sameBin = input.kind === "exchange" && input.sequence === "collection_first" && input.reuse === "same_bin";
  const source = sameBin ? {...input.dumpSite,planned:true} : validLocation(input.source, "pickup");
  const alreadyAboard = sameBin || source.kind === "truck" || input.sourceDeliveryVisitId;
  return {role:"delivery",assetId:input.deliveryAssetId,binTypeId:input.binTypeId,
    reference:reference(input,"delivery"),window:validWindow(input.deliveryWindow),source,
    steps:[...(!alreadyAboard ? [step(input,"collect_empty_bin","delivery",source)] : []),
      step(input,"deliver_bin","delivery",input.site)]};
}

/** @param {any} input */
function collectionDestination(input) {
  if (input.kind === "exchange" && input.sequence === "collection_first" && input.reuse === "same_bin") {
    return {kind:"delivery",part:"delivery",reference:reference(input,"delivery"),binTypeId:input.binTypeId};
  }
  const destination = input.destination;
  if (destination?.kind === "yard") {
    return {kind:"yard",location:validLocation(destination.location,"return yard")};
  }
  if (destination?.kind !== "delivery" || !destination.visitId || !destination.reference) {
    throw new Error("Choose a return yard or a linked delivery destination.");
  }
  if (destination.binTypeId !== (input.collectionBinTypeId || input.binTypeId)) {
    throw new Error("The linked delivery must require the same bin type.");
  }
  return structuredClone(destination);
}

/** @param {any} input */
function collectionPart(input) {
  if (!input.collectionAssetId) {throw new Error("Choose the physical collection bin.");}
  const dump = validLocation(input.dumpSite,"dump");
  if (!input.materialId) {throw new Error("Choose the collected material for dumping.");}
  const destination = collectionDestination(input);
  return {role:"collection",assetId:input.collectionAssetId,binTypeId:input.collectionBinTypeId || input.binTypeId,
    reference:reference(input,"collection"),window:validWindow(input.collectionWindow),destination,
    steps:[step(input,"pickup_bin","collection",input.site),step(input,"dump_bin","dump",dump),
      ...(destination.kind === "yard" ? [step(input,"return_bin","return",destination.location)] : [])]};
}

/** @param {any} input */
function exchangeDependencies(input) {
  if (!["collection_first","delivery_first"].includes(input.sequence)) {throw new Error("Choose the exchange sequence.");}
  if (!["same_bin","different_bin"].includes(input.reuse)) {throw new Error("Choose same or different replacement bin.");}
  if (input.sequence === "delivery_first" && input.deliveryAssetId === input.collectionAssetId) {
    throw new Error("Delivery first requires a different empty replacement bin.");
  }
  const same = input.deliveryAssetId === input.collectionAssetId;
  if (same !== (input.reuse === "same_bin")) {throw new Error("The replacement bin must match the selected same/different bin option.");}
  return input.sequence === "delivery_first"
    ? [{part:"collection",actionCode:"pickup_bin",requiresPart:"delivery",requiresActionCode:"deliver_bin"}]
    : [{part:"delivery",actionCode:"deliver_bin",requiresPart:"collection",requiresActionCode:same ? "dump_bin" : "pickup_bin"}];
}

/** @param {any} input */
export function buildBinOrderWorkflow(input) {
  const normalized = {...input,site:validLocation(input.site,"customer site")};
  const result = {reference:binOrderReference(input.rentalNumber,input),kind:input.kind,
    sameDay:input.kind === "exchange" && input.sequence === "collection_first",
    parts:/** @type {any[]} */ ([]),dependencies:/** @type {any[]} */ ([])};
  if (input.kind === "exchange") {result.dependencies = exchangeDependencies(normalized);}
  if (["delivery","exchange"].includes(input.kind)) {result.parts.push(deliveryPart(normalized));}
  if (["collection","exchange"].includes(input.kind)) {result.parts.push(collectionPart(normalized));}
  if (result.sameDay && binLocalDate(input.collectionWindow.startAt) !== binLocalDate(input.deliveryWindow.endAt)) {
    throw new Error("Collection-first delivery must finish on the same local day as pickup.");
  }
  return result;
}

/** @param {any} input */
export function assertBinWorkflowDependency(input) {
  const completed = Date.parse(input.completedAt);
  const occurred = Date.parse(input.occurredAt);
  if (!Number.isFinite(completed)) {throw new Error("The required prerequisite is not yet completed.");}
  if (!Number.isFinite(occurred) || occurred < completed) {throw new Error("This action cannot happen before its prerequisite.");}
  return {late:input.sameDay === true && binLocalDate(input.completedAt) !== binLocalDate(input.occurredAt)};
}
