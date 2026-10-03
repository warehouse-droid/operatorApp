/**
 * MBBS NetSuite RESTlet
 *
 * GET/POST action=health
 *   Read-only connectivity and environment probe. Pass requireSandbox=true to
 *   reject an accidental production deployment.
 *
 * GET/POST action=pickingTicket
 *   Renders a transaction picking ticket. For backward compatibility, omitting
 *   action while supplying entityId also renders a picking ticket.
 *
 * POST action=salesOrderPdf or purchaseOrderPdf renders the native order PDF.
 * POST action=updatePurchaseOrder applies narrowly scoped, version-checked PO edits.
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(["N/error", "N/log", "N/record", "N/render", "N/runtime"], (error, log, record, render, runtime) => {
  const VERSION = "3.2.0";
  const MAX_BASE64_CHARS = 9 * 1024 * 1024;

  function booleanValue(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
  }

  function positiveInteger(value, fieldName, { optional = false } = {}) {
    if (optional && (value === undefined || value === null || String(value).trim() === "")) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw error.create({
        name: "MBBS_INVALID_ARGUMENT",
        message: `${fieldName} must be a positive integer.`,
        notifyOff: true
      });
    }
    return parsed;
  }

  function safeFilename(value, fallback) {
    const filename = String(value || fallback || "picking-ticket.pdf")
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return filename || "picking-ticket.pdf";
  }

  function requestId() {
    return `mbbs-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  }

  function runtimeDetails() {
    const script = runtime.getCurrentScript();
    const user = runtime.getCurrentUser();
    return {
      accountId: String(runtime.accountId || ""),
      environment: String(runtime.envType || "UNKNOWN"),
      sandbox: runtime.envType === runtime.EnvType.SANDBOX,
      executionContext: String(runtime.executionContext || ""),
      scriptId: String(script.id || ""),
      deploymentId: String(script.deploymentId || ""),
      roleId: Number.isSafeInteger(Number(user.role)) ? Number(user.role) : null,
      userId: Number.isSafeInteger(Number(user.id)) ? Number(user.id) : null,
      remainingUsage: Number(script.getRemainingUsage())
    };
  }

  function assertRequestedEnvironment(request, details) {
    if (booleanValue(request.requireSandbox, false) && !details.sandbox) {
      throw error.create({
        name: "MBBS_NOT_SANDBOX",
        message: "This request requires a NetSuite sandbox, but the RESTlet is running outside a sandbox.",
        notifyOff: true
      });
    }
  }

  function health(request, id) {
    const details = runtimeDetails();
    assertRequestedEnvironment(request, details);
    return {
      ok: true,
      action: "health",
      version: VERSION,
      requestId: id,
      checkedAt: new Date().toISOString(),
      ...details,
      capabilities: {
        health: true,
        pickingTicket: true,
        purchaseOrderPdf: true,
        salesOrderPdf: true,
        updatePurchaseOrder: true,
        createSpecialSalesOrder: true,
        specialOrderAdjustment: true,
        locationFilter: true,
        metadataOnly: true,
        methods: ["GET", "POST"]
      }
    };
  }

  function pickingTicket(request, id) {
    const details = runtimeDetails();
    assertRequestedEnvironment(request, details);

    const entityId = positiveInteger(request.entityId, "entityId");
    const locationId = positiveInteger(request.location ?? request.locationId, "location", { optional: true });
    const formId = positiveInteger(request.formId, "formId", { optional: true });
    const shipgroup = positiveInteger(request.shipgroup, "shipgroup", { optional: true });
    const includeContent = booleanValue(request.includeContent, true);
    const options = {
      entityId,
      printMode: render.PrintMode.PDF
    };
    if (locationId) options.location = locationId;
    if (formId) options.formId = formId;
    if (shipgroup) options.shipgroup = shipgroup;
    if (request.inCustLocale !== undefined && request.inCustLocale !== null && request.inCustLocale !== "") {
      options.inCustLocale = booleanValue(request.inCustLocale, false);
    }

    const usageBefore = details.remainingUsage;
    const pdf = render.pickingTicket(options);
    const contentBase64 = includeContent ? String(pdf.getContents() || "") : "";
    if (includeContent && !contentBase64) {
      throw error.create({
        name: "MBBS_EMPTY_PDF",
        message: `NetSuite rendered no picking-ticket content for transaction ${entityId}.`,
        notifyOff: true
      });
    }
    if (contentBase64.length > MAX_BASE64_CHARS) {
      throw error.create({
        name: "MBBS_PDF_TOO_LARGE",
        message: `The picking ticket for transaction ${entityId} exceeds the safe RESTlet response limit.`,
        notifyOff: true
      });
    }

    const filename = safeFilename(pdf.name, `transaction-${entityId}-picking-ticket.pdf`);
    const remainingUsage = Number(runtime.getCurrentScript().getRemainingUsage());
    return {
      ok: true,
      action: "pickingTicket",
      version: VERSION,
      requestId: id,
      generatedAt: new Date().toISOString(),
      accountId: details.accountId,
      environment: details.environment,
      sandbox: details.sandbox,
      entityId,
      locationApplied: Boolean(locationId),
      locationId,
      formId,
      shipgroup,
      filename,
      contentType: "application/pdf",
      contentEncoding: "base64",
      contentIncluded: includeContent,
      contentLength: contentBase64.length,
      fileSize: Number.isFinite(Number(pdf.size)) ? Number(pdf.size) : null,
      usageUnitsConsumed: Number.isFinite(usageBefore) && Number.isFinite(remainingUsage)
        ? Math.max(0, usageBefore - remainingUsage)
        : null,
      remainingUsage,
      contentBase64
    };
  }

  function orderPdf(request, id, salesOrder) {
    const details = runtimeDetails();
    assertRequestedEnvironment(request, details);
    const entityId = positiveInteger(request.entityId, "entityId");
    const includeContent = booleanValue(request.includeContent, true);
    const prefix = salesOrder ? 'SO' : 'PO';
    // Verify the requested record type before printing its configured form.
    record.load({ type: salesOrder ? record.Type.SALES_ORDER : record.Type.PURCHASE_ORDER, id: entityId, isDynamic: false });
    const pdf = render.transaction({ entityId, printMode: render.PrintMode.PDF });
    const contentBase64 = includeContent ? String(pdf.getContents() || "") : "";
    if (includeContent && !contentBase64) {
      throw error.create({ name: "MBBS_EMPTY_PDF", message: `NetSuite rendered no ${prefix} PDF for transaction ${entityId}.`, notifyOff: true });
    }
    if (contentBase64.length > MAX_BASE64_CHARS) {
      throw error.create({ name: "MBBS_PDF_TOO_LARGE", message: `The ${prefix} PDF for transaction ${entityId} exceeds the safe response limit.`, notifyOff: true });
    }
    return {
      ok: true,
      action: salesOrder ? "salesOrderPdf" : "purchaseOrderPdf",
      version: VERSION,
      requestId: id,
      generatedAt: new Date().toISOString(),
      accountId: details.accountId,
      environment: details.environment,
      sandbox: details.sandbox,
      entityId,
      filename: safeFilename(pdf.name, `${prefix}-${entityId}.pdf`),
      contentType: "application/pdf",
      contentEncoding: "base64",
      contentIncluded: includeContent,
      contentLength: contentBase64.length,
      fileSize: Number.isFinite(Number(pdf.size)) ? Number(pdf.size) : null,
      contentBase64
    };
  }

  function comparableInstant(value) {
    if (!value) return "";
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? String(Math.floor(date.getTime() / 1000)) : String(value).trim();
  }

  function dateValue(value, fieldName) {
    if (value === null || value === undefined || value === "") return null;
    const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw error.create({ name: "MBBS_INVALID_ARGUMENT", message: `${fieldName} must use YYYY-MM-DD.`, notifyOff: true });
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0);
  }

  function numericValue(value, fieldName, { positive = false } = {}) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (positive ? parsed <= 0 : parsed < 0)) {
      throw error.create({ name: "MBBS_INVALID_ARGUMENT", message: `${fieldName} is invalid.`, notifyOff: true });
    }
    return parsed;
  }

  function adjustmentError(message) {
    throw error.create({name:'MBBS_SPECIAL_ADJUSTMENT_CONFLICT',message,notifyOff:true});
  }

  function adjustmentRate(value) {
    const text=String(value ?? '').trim();
    if (/^-?\d+(?:\.\d+)?%$/.test(text)) return `${Number(text.slice(0,-1))}%`;
    if (!text || !Number.isFinite(Number(text))) adjustmentError('A complete numeric or percentage rate is required.');
    return String(Number(text));
  }

  function adjustmentSnapshot(order,sales) {
    const header={};
    for(const field of ['entity','location','subsidiary','currency','exchangerate','shipaddress','discountitem','discountrate','memo']) {
      header[field]=String(order.getValue({fieldId:field}) ?? '');
    }
    const status=String(order.getText({fieldId:'orderstatus'}) || '').replace(/^(?:Sales Order|Purchase Order)\s*:\s*/i,'');
    if(!/^(Pending Approval|Pending Submission|Pending Fulfillment|Pending Receipt)$/.test(status)) adjustmentError('Only pending, unexecuted orders can be adjusted.');
    const lines=[];
    for(let index=0;index<order.getLineCount({sublistId:'item'});index++){
      const value=fieldId=>order.getSublistValue({sublistId:'item',fieldId,line:index});
      if([sales?'quantityfulfilled':'quantityreceived','quantitybilled'].some(field=>Number(value(field)||0)!==0)
        || booleanValue(value('isclosed'))) adjustmentError('Fulfilled, received, billed or closed lines cannot be adjusted.');
      const itemId=positiveInteger(value('item'),'item'),discount=itemId===10716;
      lines.push({remoteLineId:positiveInteger(value('lineuniquekey'),'lineuniquekey'),itemId,
        quantity:discount?null:Number(value('quantity')),unitId:value('units')?Number(value('units')):null,
        rate:adjustmentRate(discount?order.getSublistText({sublistId:'item',fieldId:'rate',line:index}):value('rate')),
        description:String(value('description')||''),locationId:value('location')?Number(value('location')):null,
        taxCode:String(value('taxcode')||''),createdPoId:value('createdpo')?Number(value('createdpo')):null,createPo:String(value('createpo')||'')});
    }
    if(!lines.length || lines.length>200 || new Set(lines.map(line=>line.remoteLineId)).size!==lines.length) adjustmentError('A complete, distinct order line snapshot is required.');
    return {header,lines};
  }

  function adjustmentMatches(expected,current) {
    const keys=['itemId','quantity','unitId','rate','description','locationId','taxCode','createdPoId','createPo'];
    return Boolean(expected?.lines && adjustmentHeadersMatch(expected.header,current.header)
      && expected.lines.length===current.lines.length && expected.lines.every((line,index)=>{
        const actual=current.lines[index];
        return (!line.remoteLineId || Number(line.remoteLineId)===actual.remoteLineId) && keys.every(key=>line[key]===actual[key]);
      }));
  }

  function adjustmentHeadersMatch(left,right) {
    return Boolean(left && right && Object.keys(left).length===Object.keys(right).length && Object.keys(left).every(key=>left[key]===right[key]));
  }

  function validateAdjustmentTarget(baseline,target,sales) {
    if(!target?.lines?.length || target.lines.length>200 || !adjustmentHeadersMatch(baseline.header,target.header)) adjustmentError('The adjustment cannot change order headers.');
    const identities=target.lines.filter(line=>line.remoteLineId).map(line=>line.remoteLineId);
    if(new Set(identities).size!==identities.length)adjustmentError('Duplicate target line identities.');
    for(const before of baseline.lines){
      const after=target.lines.find(line=>line.remoteLineId===before.remoteLineId);
      if(!after){if(!sales || ![10716,1784].includes(before.itemId))adjustmentError('Only discount and PALLET lines can be removed.');continue;}
      const mutable=before.itemId===2055 ? ['quantity',...(sales?['rate']:[])] : sales && before.itemId===1784 ? ['quantity'] : sales && before.itemId===10716 ? ['rate'] : [];
      for(const field of Object.keys(before))if(!mutable.includes(field) && before[field]!==after[field])adjustmentError('Unreviewed item, price, UOM, description, tax or native-link change.');
    }
    for(const [index,line]of target.lines.entries()){
      if(line.remoteLineId && !baseline.lines.some(before=>before.remoteLineId===line.remoteLineId))adjustmentError('Unknown target line identity.');
      if(!line.remoteLineId && (!sales || ![10716,1784].includes(line.itemId)))adjustmentError('Only discount and PALLET lines can be added.');
      if(line.itemId===10716){
        if(!sales || target.lines[index-1]?.itemId!==2055 || !/^-(?:\d+(?:\.\d{1,4})?)%$/.test(line.rate)
          || Number(line.rate.slice(0,-1)) < -100 || Number(line.rate.slice(0,-1))>=0
          || line.taxCode!==target.lines[index-1].taxCode)adjustmentError('A negative percentage discount must follow its material and share its tax code.');
      }else if(!Number.isFinite(line.quantity) || line.quantity<=0 || line.quantity>1e9 || !Number.isFinite(Number(line.rate)) || Number(line.rate)<0)adjustmentError('Invalid quantity or rate.');
      if(line.itemId===1784 && !Number.isSafeInteger(line.quantity))adjustmentError('PALLET quantity must be a whole number.');
    }
    if(target.lines.filter(line=>line.itemId===1784).length>1)adjustmentError('PALLET must have a single line.');
  }

  function writeAdjustmentLine(order,index,line,{insert=false,sales=true}={}) {
    const set=(fieldId,value)=>order.setSublistValue({sublistId:'item',fieldId,line:index,value});
    if(insert){
      order.insertLine({sublistId:'item',line:index});set('item',line.itemId);
      if(line.locationId)set('location',line.locationId);
      if(line.unitId)set('units',line.unitId);
      if(line.taxCode)set('taxcode',line.taxCode);
      set('description',line.description);
    }
    if(line.itemId===10716)order.setSublistText({sublistId:'item',fieldId:'rate',line:index,text:line.rate});
    else {
      set('quantity',line.quantity);
      if(sales){set('price',-1);set('rate',Number(line.rate));}
    }
  }

  function specialOrderAdjustment(request,id) {
    assertRequestedEnvironment(request,runtimeDetails());
    const sales=request.kind==='sales_order';
    if(!sales && request.kind!=='purchase_order')adjustmentError('Unsupported order kind.');
    const entityId=positiveInteger(request.entityId,'entityId'),type=sales?record.Type.SALES_ORDER:record.Type.PURCHASE_ORDER;
    const order=record.load({type,id:entityId,isDynamic:false}),current=adjustmentSnapshot(order,sales);
    if(request.mode==='snapshot')return {ok:true,action:'specialOrderAdjustment',version:VERSION,entityId,snapshot:current};
    if(request.mode!=='apply' || !request.baseline)adjustmentError('A saved adjustment baseline is required.');
    validateAdjustmentTarget(request.baseline,request.target,sales);
    if(adjustmentMatches(request.target,current))return {ok:true,action:'specialOrderAdjustment',entityId,snapshot:current,alreadyApplied:true};
    if(!adjustmentMatches(request.baseline,current))adjustmentError('The order changed after SCM confirmation.');
    const retained=new Set(request.target.lines.filter(line=>line.remoteLineId).map(line=>line.remoteLineId));
    for(let index=current.lines.length-1;index>=0;index--)if(!retained.has(current.lines[index].remoteLineId))order.removeLine({sublistId:'item',line:index});
    for(const [index,line]of request.target.lines.entries()){
      const existing=line.remoteLineId ? request.baseline.lines.find(before=>before.remoteLineId===line.remoteLineId) : null;
      if(existing && Number(order.getSublistValue({sublistId:'item',fieldId:'lineuniquekey',line:index}))!==line.remoteLineId)adjustmentError('Existing material line order cannot change.');
      if(!existing || existing.quantity!==line.quantity || existing.rate!==line.rate)writeAdjustmentLine(order,index,line,{insert:!existing,sales});
    }
    order.save({enableSourcing:true,ignoreMandatoryFields:false});
    const after=adjustmentSnapshot(record.load({type,id:entityId,isDynamic:false}),sales);
    if(!adjustmentMatches(request.target,after))adjustmentError('The saved order needs reconciliation; retry SCM confirmation.');
    return {ok:true,action:'specialOrderAdjustment',version:VERSION,requestId:id,entityId,snapshot:after};
  }

  function createSpecialSalesOrder(request,id) {
    assertRequestedEnvironment(request,runtimeDetails());
    const payload=request.payload || {},marker=String(payload.memo||'').match(/\bMBBS-SPECIAL-SO:\d+\b/)?.[0];
    if(!marker || !Array.isArray(payload.item?.items) || !payload.item.items.length || payload.item.items.length>200)adjustmentError('A marked, reviewed Special Item SO is required.');
    const order=request.estimateId ? record.transform({fromType:record.Type.ESTIMATE,fromId:positiveInteger(request.estimateId,'estimateId'),toType:record.Type.SALES_ORDER,isDynamic:true}) : record.create({type:record.Type.SALES_ORDER,isDynamic:true});
    for(const field of ['subsidiary','entity','location','custbody3'])if(payload[field])order.setValue({fieldId:field,value:positiveInteger(payload[field].id,field)});
    order.setValue({fieldId:'externalid',value:marker});order.setValue({fieldId:'memo',value:payload.memo});
    order.setValue({fieldId:'discountitem',value:''});
    if(payload.custbody4)order.setValue({fieldId:'custbody4',value:dateValue(payload.custbody4,'deliveryDate')});
    if(payload.custbody7)order.setValue({fieldId:'custbody7',value:payload.custbody7});
    if(payload.shippingAddress){
      order.setValue({fieldId:'shipaddresslist',value:null});
      const address=order.getSubrecord({fieldId:'shippingaddress'});
      address.setValue({fieldId:'override',value:true});address.setValue({fieldId:'addrtext',value:String(payload.shippingAddress.addrText||'')});
    }
    for(let index=order.getLineCount({sublistId:'item'})-1;index>=0;index--)order.removeLine({sublistId:'item',line:index});
    for(const [index,line]of payload.item.items.entries()){
      const itemId=positiveInteger(line.item?.id,'item');
      order.selectNewLine({sublistId:'item'});
      const set=(fieldId,value)=>order.setCurrentSublistValue({sublistId:'item',fieldId,value});
      set('item',itemId);
      if(itemId===10716){
        if(Number(payload.item.items[index-1]?.item?.id)!==2055 || !/^-\d+(?:\.\d{1,4})?%$/.test(String(line.rate))
          || Number(line.rate.slice(0,-1)) < -100 || Number(line.rate.slice(0,-1))>=0)adjustmentError('Discount must be a negative percentage immediately after MBBS-Special Order.');
        const tax=order.getSublistValue({sublistId:'item',fieldId:'taxcode',line:index-1});if(tax)set('taxcode',tax);
        if(payload.item.items[index-1].location)set('location',Number(payload.item.items[index-1].location.id));
        order.setCurrentSublistText({sublistId:'item',fieldId:'rate',text:line.rate});
      }else{
        set('quantity',numericValue(line.quantity,'quantity',{positive:true}));
        if(line.units)set('units',positiveInteger(line.units,'units'));
        if(line.location)set('location',positiveInteger(line.location.id,'location'));
        set('description',String(line.description||''));set('price',-1);set('rate',numericValue(line.rate,'rate'));
      }
      order.commitLine({sublistId:'item'});
    }
    const entityId=Number(order.save({enableSourcing:true,ignoreMandatoryFields:false}));
    const saved=record.load({type:record.Type.SALES_ORDER,id:entityId,isDynamic:false});
    if(saved.getLineCount({sublistId:'item'})!==payload.item.items.length)adjustmentError('Saved SO line count differs from the reviewed order.');
    for(const [index,line]of payload.item.items.entries()){
      const get=fieldId=>saved.getSublistValue({sublistId:'item',fieldId,line:index}),itemId=Number(line.item.id);
      const rate=itemId===10716?saved.getSublistText({sublistId:'item',fieldId:'rate',line:index}):get('rate');
      if(Number(get('item'))!==itemId || adjustmentRate(rate)!==adjustmentRate(line.rate)
        || (itemId!==10716 && (Number(get('quantity'))!==Number(line.quantity) || Number(get('units'))!==Number(line.units))))adjustmentError('Saved SO pricing or quantities need reconciliation. Recover the existing order using its marker.');
    }
    return {ok:true,action:'createSpecialSalesOrder',version:VERSION,requestId:id,entityId};
  }

  function updatePurchaseOrder(request, id) {
    const details = runtimeDetails();
    assertRequestedEnvironment(request, details);
    const entityId = positiveInteger(request.entityId, "entityId");
    const po = record.load({ type: record.Type.PURCHASE_ORDER, id: entityId, isDynamic: false });
    const expected = String(request.expectedLastModifiedAt || "").trim();
    const actual = po.getValue({ fieldId: "lastmodifieddate" });
    if (!expected || comparableInstant(expected) !== comparableInstant(actual)) {
      throw error.create({ name: "MBBS_PO_VERSION_CONFLICT", message: `Purchase order ${entityId} changed in NetSuite. Refresh before saving.`, notifyOff: true });
    }

    let statusText = "";
    try {
      statusText = String(po.getText({ fieldId: "orderstatus" }) || "");
    } catch (lookupError) {
      // Line-level receipt/closed checks below remain authoritative when a
      // custom form does not expose orderstatus text.
    }
    const lineCount = po.getLineCount({ sublistId: "item" }) || 0;
    let hasLockedLine = false;
    for (let current = 0; current < lineCount; current += 1) {
      const received = Number(po.getSublistValue({ sublistId: "item", fieldId: "quantityreceived", line: current })
        || po.getSublistValue({ sublistId: "item", fieldId: "quantityshiprecv", line: current }) || 0);
      const closedValue = po.getSublistValue({ sublistId: "item", fieldId: "isclosed", line: current });
      if (received > 0 || /^(t|true|yes|1)$/i.test(String(closedValue || ""))) {
        hasLockedLine = true;
        break;
      }
    }
    if (hasLockedLine || /closed|cancelled|canceled|fully received/i.test(statusText)) {
      throw error.create({ name: "MBBS_PO_READ_ONLY", message: `Purchase order ${entityId} is received, closed, cancelled, or read-only.`, notifyOff: true });
    }

    const header = request.header && typeof request.header === "object" ? request.header : {};
    if (Object.prototype.hasOwnProperty.call(header, "transactionDate")) {
      po.setValue({ fieldId: "trandate", value: dateValue(header.transactionDate, "transactionDate") });
    }
    if (Object.prototype.hasOwnProperty.call(header, "expectedDeliveryDate")) {
      po.setValue({ fieldId: "custbody4", value: dateValue(header.expectedDeliveryDate, "expectedDeliveryDate") || "" });
    }
    if (Object.prototype.hasOwnProperty.call(header, "memo")) {
      po.setValue({ fieldId: "memo", value: String(header.memo || "").slice(0, 4000) });
    }
    if (Object.prototype.hasOwnProperty.call(header, "vendorReference")) {
      po.setValue({ fieldId: "otherrefnum", value: String(header.vendorReference || "").slice(0, 300) });
    }

    const requestedLines = Array.isArray(request.lines) ? request.lines : [];
    const requestedLineIds = new Set();
    requestedLines.forEach((requested, index) => {
      const lineId = positiveInteger(requested.lineId, `lines[${index}].lineId`);
      if (requestedLineIds.has(lineId)) {
        throw error.create({ name: "MBBS_DUPLICATE_PO_LINE", message: `Purchase-order line ${lineId} appears more than once in this update.`, notifyOff: true });
      }
      requestedLineIds.add(lineId);
      let line = -1;
      for (let current = 0; current < lineCount; current += 1) {
        if (Number(po.getSublistValue({ sublistId: "item", fieldId: "lineuniquekey", line: current })) === lineId) {
          line = current;
          break;
        }
      }
      if (line < 0) throw error.create({ name: "MBBS_PO_LINE_MISSING", message: `Purchase-order line ${lineId} no longer exists.`, notifyOff: true });
      const currentItemId = Number(po.getSublistValue({ sublistId: "item", fieldId: "item", line }));
      if (requested.itemId && Number(requested.itemId) !== currentItemId) {
        throw error.create({ name: "MBBS_PO_ITEM_LOCKED", message: `Item identity on line ${lineId} cannot be changed.`, notifyOff: true });
      }
      const received = Number(po.getSublistValue({ sublistId: "item", fieldId: "quantityreceived", line })
        || po.getSublistValue({ sublistId: "item", fieldId: "quantityshiprecv", line }) || 0);
      const closed = /^(t|true|yes|1)$/i.test(String(po.getSublistValue({ sublistId: "item", fieldId: "isclosed", line }) || ""));
      if (received > 0 || closed) {
        throw error.create({ name: "MBBS_PO_LINE_LOCKED", message: `Received or closed line ${lineId} cannot be edited.`, notifyOff: true });
      }
      if (Object.prototype.hasOwnProperty.call(requested, "quantity")) {
        po.setSublistValue({ sublistId: "item", fieldId: "quantity", line, value: numericValue(requested.quantity, `lines[${index}].quantity`, { positive: true }) });
      }
      if (Object.prototype.hasOwnProperty.call(requested, "rate")) {
        po.setSublistValue({ sublistId: "item", fieldId: "rate", line, value: numericValue(requested.rate, `lines[${index}].rate`) });
      }
      if (Object.prototype.hasOwnProperty.call(requested, "locationId")) {
        po.setSublistValue({ sublistId: "item", fieldId: "location", line, value: positiveInteger(requested.locationId, `lines[${index}].locationId`) });
      }
    });
    const savedId = po.save({ enableSourcing: true, ignoreMandatoryFields: false });
    return {
      ok: true,
      action: "updatePurchaseOrder",
      version: VERSION,
      requestId: id,
      entityId: Number(savedId),
      previousLastModifiedAt: actual instanceof Date ? actual.toISOString() : String(actual || ""),
      updatedAt: new Date().toISOString()
    };
  }

  function normalizedAction(request) {
    const explicit = String(request.action || "").trim().toLowerCase().replace(/[^a-z]/g, "");
    if (!explicit) return request.entityId ? "pickingticket" : "health";
    if (explicit === "ticket" || explicit === "render" || explicit === "renderpickingticket") return "pickingticket";
    return explicit;
  }

  function dispatch(rawRequest = {}) {
    const request = rawRequest && typeof rawRequest === "object" ? rawRequest : {};
    const id = requestId();
    const action = normalizedAction(request);
    try {
      log.audit({
        title: `MBBS RESTlet ${action}`,
        details: {
          requestId: id,
          action,
          entityId: request.entityId || null,
          locationId: request.location ?? request.locationId ?? null,
          environment: String(runtime.envType || "UNKNOWN")
        }
      });
      if (action === "health") return health(request, id);
      if (action === "pickingticket") return pickingTicket(request, id);
      if (action === "purchaseorderpdf") return orderPdf(request, id, false);
      if (action === "salesorderpdf") return orderPdf(request, id, true);
      if (action === "updatepurchaseorder") return updatePurchaseOrder(request, id);
      if (action === 'specialorderadjustment') return specialOrderAdjustment(request,id);
      if (action === 'createspecialsalesorder') return createSpecialSalesOrder(request,id);
      throw error.create({
        name: "MBBS_UNSUPPORTED_ACTION",
        message: `Unsupported action "${String(request.action || "")}". Use health, pickingTicket, salesOrderPdf, purchaseOrderPdf, or updatePurchaseOrder.`,
        notifyOff: true
      });
    } catch (caught) {
      log.error({
        title: `MBBS RESTlet failed (${id})`,
        details: {
          requestId: id,
          action,
          code: String(caught?.name || "UNEXPECTED_ERROR"),
          message: String(caught?.message || caught)
        }
      });
      if (/^MBBS_/.test(String(caught?.name || ""))) throw caught;
      throw error.create({
        name: "MBBS_RESTLET_FAILED",
        message: `The RESTlet request failed. Review NetSuite script logs with reference ${id}.`,
        notifyOff: true
      });
    }
  }

  return {
    get: dispatch,
    post: dispatch
  };
});
