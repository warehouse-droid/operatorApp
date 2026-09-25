/**
 * Field Sales integration: local quotes convert to Sales Orders for existing customers.
 * Version 2.1 reads Customers and subsidiary memberships; only Sales Orders are written.
 * Enable custbody_fs_quote_revision, custbody_fs_quote_hash, custbody_fs_state_hash
 * and custbody_fs_company on the configured Sales Order forms.
 * Required transaction body fields: custbody_fs_quote_revision (integer),
 * custbody_fs_quote_hash (free-form text), custbody_fs_state_hash (free-form text),
 * custbody_fs_quote_closed (checkbox). Required script parameter:
 * custscript_fs_allow_writes (checkbox, default false).
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(['N/record','N/search','N/runtime','N/crypto','N/encode'],(record,search,runtime,crypto,encode)=>{
  const F={revision:'custbody_fs_quote_revision',hash:'custbody_fs_quote_hash',state:'custbody_fs_state_hash',closed:'custbody_fs_quote_closed'};
  function failure(message){throw Object.assign(new Error(message),{permanent:true});}
  function positive(v,label){if(!/^\d+$/.test(String(v||''))||Number(v)<1){failure(`Invalid ${label}.`);}return Number(v);}
  function find(externalId) {
    if(!/^field-sales-[0-9a-f-]{36}-(mbbs|mbt)$/.test(String(externalId))){failure('Invalid Field Sales external ID.');}
    const rows=search.create({type:search.Type.ESTIMATE,filters:[['externalidstring','is',externalId],'AND',['mainline','is','T']],columns:['internalid']}).run().getRange({start:0,end:2});
    if(rows.length>1){failure('Duplicate estimate external ID.');}
    return rows.length?record.load({type:record.Type.ESTIMATE,id:rows[0].getValue('internalid'),isDynamic:false}):null;
  }
  function businessState(rec) {
    const lines=[];
    for(let i=0;i<rec.getLineCount({sublistId:'item'});i++) {
      const get=fieldId=>rec.getSublistValue({sublistId:'item',fieldId,line:i});
      lines.push([String(get('item')),Number(get('quantity')),Number(get('rate')),String(get('description')||''),String(get('units')||''),String(get('taxcode')||''),Number(get('amount'))]);
    }
    return JSON.stringify([['entity','subsidiary','currency','entitystatus','customform','location','duedate','memo','shipaddress','subtotal','taxtotal','total'].map(f=>String(rec.getValue(f)||'')),lines]);
  }
  function stateHash(rec) {const h=crypto.createHash({algorithm:crypto.HashAlg.SHA256});h.update({input:businessState(rec),inputEncoding:encode.Encoding.UTF_8});return h.digest({outputEncoding:encode.Encoding.HEX});}
  function response(rec) {
    if(!rec){return {ok:true,found:false};}
    const remoteHash=stateHash(rec);
    const converted=search.create({type:search.Type.TRANSACTION,filters:[['createdfrom','anyof',rec.id],'AND',['mainline','is','T'],'AND',['type','anyof',['SalesOrd','CustInvc','CashSale']]],columns:['internalid']}).run().getRange({start:0,end:1}).length>0;
    return {ok:true,found:true,internalId:String(rec.id),reference:String(rec.getValue('tranid')),revision:Number(rec.getValue(F.revision)||0),payloadHash:String(rec.getValue(F.hash)||''),remoteHash,unmodified:String(rec.getValue(F.state)||'')===remoteHash,locked:converted,closed:Boolean(rec.getValue(F.closed)),totals:{subtotalMinor:Math.round(Number(rec.getValue('subtotal'))*100),taxMinor:Math.round(Number(rec.getValue('taxtotal')||0)*100),totalMinor:Math.round(Number(rec.getValue('total'))*100)}};
  }
  function preflight(p) {
    const cfg=p.config||{};positive(p.customerId,'customer');positive(cfg.subsidiaryId,'subsidiary');positive(cfg.formId,'estimate form');positive(cfg.closedStatusId,'closed status');positive(cfg.currencyId,'CAD currency');
    const currency=record.load({type:record.Type.CURRENCY,id:Number(cfg.currencyId),isDynamic:false});if(String(currency.getValue('symbol')).toUpperCase()!=='CAD'){failure('Field Sales estimates require CAD currency.');}
    const customer=record.load({type:record.Type.CUSTOMER,id:Number(p.customerId),isDynamic:false});
    if(customer.getValue('isinactive')){failure('Customer is inactive.');}
    const subs=[String(customer.getValue('subsidiary'))];
    const count=customer.getLineCount({sublistId:'submachine'})||0;
    for(let i=0;i<count;i++){subs.push(String(customer.getSublistValue({sublistId:'submachine',fieldId:'subsidiary',line:i})));}
    if(!subs.includes(String(cfg.subsidiaryId))){failure('Customer subsidiary membership does not match.');}
    if(!Array.isArray(p.lines)||p.lines.length>200){failure('Invalid quote lines.');}
    for(const line of p.lines) {
      positive(line.itemId,'item');
      if(!Number.isFinite(Number(line.quantity))||Number(line.quantity)<=0||!Number.isFinite(Number(line.unitRate))||Number(line.unitRate)<0){failure('Invalid quantity or price.');}
      const item=search.lookupFields({type:search.Type.ITEM,id:line.itemId,columns:['isinactive','subsidiary','saleunit']});
      if(item.isinactive){failure('An item is inactive.');}
      const memberships=(item.subsidiary||[]).map(s=>String(s.value));if(memberships.length&&!memberships.includes(String(cfg.subsidiaryId))){failure('An item belongs to another subsidiary.');}
      const salesUnit=(Array.isArray(item.saleunit)?item.saleunit[0]:item.saleunit)||{};
      if(salesUnit.value&&(line.unitId?String(line.unitId)!==String(salesUnit.value):String(line.unit||'').trim().toLowerCase()!==String(salesUnit.text||'').trim().toLowerCase())){failure('Refresh the suggested price and sales unit, review the quantity, and save a new revision before publishing.');}
    }
    const existing=find(p.externalId),observed=response(existing);
    if(observed.found&&(observed.locked||!observed.unmodified&&p.expectedRemoteHash!==observed.remoteHash||observed.revision>p.revision)){failure('The linked estimate was changed externally or converted.');}
    if(observed.found&&p.expectedRemoteHash&&observed.remoteHash!==p.expectedRemoteHash){failure('The linked estimate changed since the last publication.');}
  }
  function seal(rec,p) {
    if(String(rec.getValue(F.state))!==`pending:${p.payloadHash}`||String(rec.getValue(F.hash))!==p.payloadHash||Number(rec.getValue(F.revision))!==p.revision){failure('Estimate publication changed before acknowledgement.');}
    if(runtime.getCurrentScript().getParameter({name:'custscript_fs_allow_writes'})!==true){failure('Estimate writes are disabled.');}
    if(p.close) {if(!rec.getValue(F.closed)||String(rec.getValue('entitystatus'))!==String(p.config.closedStatusId)){failure('Estimate closure differs from requested revision.');}}
    else {
      for(const [field,value] of [['entity',p.customerId],['subsidiary',p.config.subsidiaryId],['currency',p.config.currencyId],['memo',`${p.number} revision ${p.revision}\n${String(p.note||'')}`],['shipaddress',p.jobsite.address]]){if(String(rec.getValue(field)||'').trim()!==String(value||'').trim()){failure(`Estimate ${field} differs from requested revision.`);}}
      if(rec.getLineCount({sublistId:'item'})!==p.lines.length){failure('Estimate lines differ from requested revision.');}
      p.lines.forEach((line,i)=>{const get=f=>rec.getSublistValue({sublistId:'item',fieldId:f,line:i});if(String(get('item'))!==String(line.itemId)||Number(get('quantity'))!==Number(line.quantity)||Number(get('rate'))!==Number(line.unitRate)||String(get('description')||'')!==String(line.description)||line.unitId&&String(get('units'))!==String(line.unitId)){failure('Estimate item values differ from requested revision.');}});
    }
    // The pending marker makes a timeout between the business save and this
    // metadata save recoverable. Recovery checks the complete requested intent.
    rec.setValue({fieldId:F.state,value:stateHash(rec)});const id=rec.save({enableSourcing:false,ignoreMandatoryFields:false});
    return response(record.load({type:record.Type.ESTIMATE,id,isDynamic:false}));
  }
  function write(p) {
    if(runtime.getCurrentScript().getParameter({name:'custscript_fs_allow_writes'})!==true){failure('Field Sales estimate writes are disabled on this deployment.');}
    let rec=find(p.externalId);const before=response(rec);
    if(before.found&&before.payloadHash===p.payloadHash&&before.revision===p.revision) {if(String(rec.getValue(F.state))===`pending:${p.payloadHash}`){return seal(rec,p);}if(!before.unmodified){failure('Estimate was changed externally.');}return before;}
    preflight(p);
    if(before.found&&!p.expectedRemoteHash){failure('Unexpected existing estimate.');}
    const cfg=p.config;
    rec ||= record.create({type:record.Type.ESTIMATE,isDynamic:false,defaultValues:{customform:positive(cfg.formId,'form')}});
    const set=(fieldId,value)=>rec.setValue({fieldId,value});
    if(p.close) {if(!before.found){failure('Cannot close a missing estimate.');}set('entitystatus',Number(cfg.closedStatusId));set(F.closed,true);}
    else {
      set('customform',Number(cfg.formId));set('entity',Number(p.customerId));set('subsidiary',Number(cfg.subsidiaryId));
      if(cfg.currencyId){set('currency',Number(cfg.currencyId));}if(cfg.locationId){set('location',Number(cfg.locationId));}
      if(cfg.openStatusId){set('entitystatus',Number(cfg.openStatusId));}else if(before.closed){failure('Configure an open estimate status before restoring a withdrawn company.');}
      set('externalid',p.externalId);set('memo',`${p.number} revision ${p.revision}\n${String(p.note||'')}`);
      set('shipaddresslist',null);set('shipaddress',String(p.jobsite.address||''));
      if(p.validUntil){set('duedate',new Date(`${p.validUntil}T12:00:00`));}
      for(let i=rec.getLineCount({sublistId:'item'})-1;i>=0;i--){rec.removeLine({sublistId:'item',line:i});}
      p.lines.forEach((line,i)=>{
        const setLine=(fieldId,value)=>rec.setSublistValue({sublistId:'item',line:i,fieldId,value});
        setLine('item',Number(line.itemId));if(line.unitId){setLine('units',Number(line.unitId));}setLine('quantity',Number(line.quantity));setLine('price',-1);setLine('rate',Number(line.unitRate));setLine('description',String(line.description));
        if(!runtime.isFeatureInEffect({feature:'SUITETAX'})){setLine('taxcode',Number(cfg.taxCodeId));}
      });
      set(F.closed,false);set('tobeemailed',false);set('tobefaxed',false);
    }
    set(F.revision,p.revision);set(F.hash,p.payloadHash);set(F.state,`pending:${p.payloadHash}`);
    const id=rec.save({enableSourcing:true,ignoreMandatoryFields:false});
    return seal(record.load({type:record.Type.ESTIMATE,id,isDynamic:false}),p);
  }
  function price(p) {
    positive(p.itemId,'item');positive(p.currencyId,'CAD currency');
    const level=p.company==='MBBS'?'TRADE-A':['MBR','MBT'].includes(p.company)?'TRADE':null;
    if(!level){failure('Select a valid company for Trade pricing.');}
    const quantity=String(p.quantity??'1');if(!/^\d{1,12}(\.\d{1,6})?$/.test(quantity)||Number(quantity)<=0){failure('Invalid quantity.');}
    const currency=record.load({type:record.Type.CURRENCY,id:Number(p.currencyId),isDynamic:false});if(String(currency.getValue('symbol')).toUpperCase()!=='CAD'){failure('Select the CAD currency for price suggestions.');}
    const found=search.create({type:search.Type.ITEM,filters:[['internalid','anyof',p.itemId],'AND',['isinactive','is','F']],columns:['internalid']}).run().getRange({start:0,end:1});
    if(!found.length){failure('Active item not found.');}
    const item=record.load({type:found[0].recordType,id:Number(p.itemId),isDynamic:false});
    const sublistId=runtime.isFeatureInEffect({feature:'MULTICURRENCY'})?`price${p.currencyId}`:'price';
    let unitRate=null,minimum=-1;
    for(let i=0;i<item.getLineCount({sublistId});i++){
      if(String(item.getSublistText({sublistId,fieldId:'pricelevel',line:i}))!==level){continue;}
      const count=runtime.isFeatureInEffect({feature:'QUANTITYPRICING'})?item.getMatrixHeaderCount({sublistId,fieldId:'price'}):1;
      for(let column=0;column<count;column++){
        const threshold=count===1?0:Number(item.getMatrixHeaderValue({sublistId,fieldId:'price',column}));
        const value=item.getMatrixSublistValue({sublistId,fieldId:'price',line:i,column});
        if(Number.isFinite(threshold)&&threshold>=0&&threshold<=Number(quantity)&&threshold>minimum){
          minimum=threshold;unitRate=value!==''&&value!=null&&/^\d{1,12}(\.\d{1,6})?$/.test(String(value))?String(value):null;
        }
      }
    }
    return {ok:true,unitRate,unitId:item.getValue('saleunit')||null,unit:item.getText('saleunit')||''};
  }
  // Local quotations -> Sales Orders for existing customers. Existing estimate
  // records remain readable, but the app never queues estimate writes.
  const SO={revision:F.revision,hash:F.hash,state:F.state,company:'custbody_fs_company'};
  const suiteTax=()=>runtime.isFeatureInEffect({feature:'TAX_OVERHAULING'});
  const multiCustomer=()=>runtime.isFeatureInEffect({feature:'MULTISUBSIDIARYCUSTOMER'});
  function allowOrderWrites(){if(runtime.getCurrentScript().getParameter({name:'custscript_fs_allow_writes'})!==true){failure('Field Sales Sales Order writes are disabled.');}}
  function externalRecord(type,externalId){
    const filters=[['externalidstring','is',externalId]];if(type===record.Type.SALES_ORDER){filters.push('AND',['mainline','is','T']);}
    const rows=search.create({type,filters,columns:['internalid']}).run().getRange({start:0,end:2});
    if(rows.length>1){failure('Duplicate Field Sales external ID.');}
    return rows.length?record.load({type,id:rows[0].getValue('internalid'),isDynamic:false}):null;
  }
  function customerRecord(p){
    if(!/^[1-9]\d*$/.test(String(p.linkedCustomerId||''))){failure('Link an existing NetSuite customer first. Customers must be created in NetSuite.');}
    return record.load({type:record.Type.CUSTOMER,id:positive(p.linkedCustomerId,'linked customer'),isDynamic:false});
  }
  function customerResult(rec){
    if(!rec){return {ok:true,found:false};}
    const subsidiaries=[String(rec.getValue('subsidiary'))];
    if(multiCustomer()){
      const rows=search.create({type:'customersubsidiaryrelationship',filters:[['entity','anyof',rec.id]],columns:['subsidiary']}).run().getRange({start:0,end:1000});
      for(const row of rows){subsidiaries.push(String(row.getValue('subsidiary')));}
    }
    return {ok:true,found:true,internalId:String(rec.id),reference:String(rec.getValue('entityid')||rec.getValue('companyname')||''),externalId:String(rec.getValue('externalid')||''),active:!rec.getValue('isinactive'),currencyId:String(rec.getValue('currency')),subsidiaries:[...new Set(subsidiaries)]};
  }
  function orderPreflight(p){
    if(!['MBBS','MBT','MBR'].includes(p.company)||!/^field-sales-order-[0-9a-f-]{36}$/.test(String(p.externalId))){failure('Invalid company Sales Order identity.');}
    const c=p.config||{};for(const k of ['subsidiaryId','salesOrderFormId','currencyId','locationId']){positive(c[k],k);}
    if(!Array.isArray(c.customerSubsidiaries)||!c.customerSubsidiaries.length||c.customerSubsidiaries.length>2){failure('Configure customer subsidiaries.');}
    c.customerSubsidiaries.forEach(id=>positive(id,'customer subsidiary'));
    if(c.customerSubsidiaries.length>1&&!multiCustomer()){failure('Enable Multi-Subsidiary Customer for the shared MBT/MBR customer.');}
    if(!suiteTax()){positive(c.taxCodeId,'legacy tax code');}
    if(p.customerNetsuiteId&&String(p.customerNetsuiteId)!==String(p.linkedCustomerId)){failure('The Sales Order customer differs from the linked customer.');}
    const customer=customerResult(customerRecord(p));
    if(!customer.active||customer.currencyId!==String(c.currencyId)||c.customerSubsidiaries.some(id=>!customer.subsidiaries.includes(String(id)))){failure('Review the linked customer currency, active status and subsidiary memberships in NetSuite.');}
    const currency=record.load({type:record.Type.CURRENCY,id:Number(c.currencyId),isDynamic:false});if(String(currency.getValue('symbol')).toUpperCase()!=='CAD'){failure('Field Sales requires CAD currency.');}
    if(!p.customer?.name||!Array.isArray(p.lines)||!p.lines.length||p.lines.length>200){failure('A customer and 1–200 quote items are required.');}
    for(const l of p.lines){
      if(l.company!==p.company||!Number.isFinite(Number(l.quantity))||Number(l.quantity)<=0||!Number.isFinite(Number(l.unitRate))||Number(l.unitRate)<0){failure('Invalid company, quantity or price on the quote.');}
      positive(l.itemId,'item');const item=search.lookupFields({type:search.Type.ITEM,id:l.itemId,columns:['isinactive','subsidiary','saleunit']});
      if(item.isinactive){failure('A quote item is inactive.');}
      const subs=(item.subsidiary||[]).map(s=>String(s.value));if(subs.length&&!subs.includes(String(c.subsidiaryId))){failure('A quote item belongs to another subsidiary.');}
      const unit=(Array.isArray(item.saleunit)?item.saleunit[0]:item.saleunit)||{};
      if(unit.value&&(l.unitId?String(l.unitId)!==String(unit.value):String(l.unit||'').trim().toLowerCase()!==String(unit.text||'').trim().toLowerCase())){failure('The sales unit changed. Review the accepted quote before creating an order.');}
    }
    const form=record.create({type:record.Type.SALES_ORDER,isDynamic:false,defaultValues:{customform:Number(c.salesOrderFormId)}});
    const fields=form.getFields();for(const id of Object.values(SO)){if(!fields.includes(id)){failure(`Enable ${id} on the Sales Order form before posting.`);}}
    if(p.shippingMethod==='Delivery'){positive(c.deliveryMethodId,'delivery method');}else if(p.shippingMethod==='Pick-Up'){positive(c.pickupMethodId,'pick-up method');}
    return {ok:true};
  }
  function salesOrderState(rec){
    const lines=[];for(let i=0;i<rec.getLineCount({sublistId:'item'});i++){lines.push(['item','units','quantity','rate','amount','description'].map(fieldId=>String(rec.getSublistValue({sublistId:'item',fieldId,line:i})??'')));}
    return JSON.stringify([['entity','subsidiary','currency','customform','location','memo','billaddress','shipaddress','subtotal','taxtotal','total',SO.company].map(f=>String(rec.getValue(f)||'')),lines]);
  }
  function orderHash(rec){const h=crypto.createHash({algorithm:crypto.HashAlg.SHA256});h.update({input:salesOrderState(rec),inputEncoding:encode.Encoding.UTF_8});return h.digest({outputEncoding:encode.Encoding.HEX});}
  function orderResult(rec){
    if(!rec){return {ok:true,found:false};}const hash=orderHash(rec);
    return {ok:true,found:true,internalId:String(rec.id),reference:String(rec.getValue('tranid')),externalId:String(rec.getValue('externalid')),payloadHash:String(rec.getValue(SO.hash)),revision:Number(rec.getValue(SO.revision)),company:String(rec.getValue(SO.company)),customerId:String(rec.getValue('entity')),unmodified:String(rec.getValue(SO.state))===hash,
      totals:{subtotalMinor:Math.round(Number(rec.getValue('subtotal'))*100),taxMinor:Math.round(Number(rec.getValue('taxtotal')||0)*100),totalMinor:Math.round(Number(rec.getValue('total'))*100)}};
  }
  function orderMemo(p){return `${p.number} revision ${p.revision}\nJobsite: ${p.jobsite.address}\nSales rep: ${p.salesRep||''}\nCustomer: ${p.customer.name}\nContact: ${p.representative?.name||''} ${p.representative?.phone||''} ${p.representative?.email||''}\nConfirmed by ${p.confirmation.confirmedBy} at ${p.confirmation.confirmedAt}\n${p.note||''}`;}
  function sealOrder(rec,p){
    if(String(rec.getValue(SO.state))!==`pending:${p.payloadHash}`||String(rec.getValue(SO.hash))!==p.payloadHash||Number(rec.getValue(SO.revision))!==p.revision){return orderResult(rec);}
    const expected=[['entity',p.customerNetsuiteId],['subsidiary',p.config.subsidiaryId],['currency',p.config.currencyId],['customform',p.config.salesOrderFormId],['location',p.config.locationId],['memo',orderMemo(p)],['shipaddress',p.shipToAddress],...(!p.useCustomerBilling?[['billaddress',p.billToAddress]]:[]),[SO.company,p.company]];
    if(expected.some(([key,value])=>String(rec.getValue(key)||'').trim()!==String(value||'').trim())||rec.getLineCount({sublistId:'item'})!==p.lines.length){return orderResult(rec);}
    for(let i=0;i<p.lines.length;i++){const l=p.lines[i],get=fieldId=>rec.getSublistValue({sublistId:'item',fieldId,line:i});if(String(get('item'))!==String(l.itemId)||Number(get('quantity'))!==Number(l.quantity)||Number(get('rate'))!==Number(l.unitRate)||String(get('description')||'')!==String(l.description)||l.unitId&&String(get('units'))!==String(l.unitId)){return orderResult(rec);}}
    allowOrderWrites();rec.setValue({fieldId:SO.state,value:orderHash(rec)});const id=rec.save({enableSourcing:false,ignoreMandatoryFields:false});return orderResult(record.load({type:record.Type.SALES_ORDER,id,isDynamic:false}));
  }
  function lookupOrder(p){
    if(!/^field-sales-order-[0-9a-f-]{36}$/.test(String(p.externalId))){failure('Invalid Sales Order external ID.');}
    const rec=externalRecord(record.Type.SALES_ORDER,p.externalId);return rec&&p.customerNetsuiteId?sealOrder(rec,p):orderResult(rec);
  }
  function createOrder(p){
    allowOrderWrites();orderPreflight(p);positive(p.customerNetsuiteId,'order customer');
    const prior=externalRecord(record.Type.SALES_ORDER,p.externalId);if(prior){return sealOrder(prior,p);}
    const customer=customerResult(record.load({type:record.Type.CUSTOMER,id:Number(p.customerNetsuiteId),isDynamic:false}));
    if(!customer.active||customer.currencyId!==String(p.config.currencyId)||!customer.subsidiaries.includes(String(p.config.subsidiaryId))){failure('The customer cannot transact for this subsidiary and currency.');}
    const rec=record.create({type:record.Type.SALES_ORDER,isDynamic:false,defaultValues:{customform:Number(p.config.salesOrderFormId)}}),set=(fieldId,value)=>rec.setValue({fieldId,value});
    set('customform',Number(p.config.salesOrderFormId));set('subsidiary',Number(p.config.subsidiaryId));set('entity',Number(p.customerNetsuiteId));set('currency',Number(p.config.currencyId));set('location',Number(p.config.locationId));
    set('externalid',p.externalId);set('memo',orderMemo(p));set('tobeemailed',false);set('tobefaxed',false);
    for(const [field,body] of [...(!p.useCustomerBilling?[['billingaddress',p.billToAddress]]:[]),['shippingaddress',p.shipToAddress]]){const address=rec.getSubrecord({fieldId:field});address.setValue({fieldId:'override',value:true});address.setValue({fieldId:'addrtext',value:String(body||'')});}
    if(p.shippingMethod==='Delivery'){set('custbody3',Number(p.config.deliveryMethodId));}else if(p.shippingMethod==='Pick-Up'){set('custbody3',Number(p.config.pickupMethodId));}
    if(p.config.termsId){set('terms',Number(p.config.termsId));}
    p.lines.forEach((l,i)=>{const line=(fieldId,value)=>rec.setSublistValue({sublistId:'item',fieldId,line:i,value});line('item',Number(l.itemId));if(l.unitId){line('units',Number(l.unitId));}line('quantity',Number(l.quantity));line('price',-1);line('rate',Number(l.unitRate));line('description',String(l.description));if(!suiteTax()){line('taxcode',Number(p.config.taxCodeId));}});
    set(SO.revision,p.revision);set(SO.hash,p.payloadHash);set(SO.company,p.company);set(SO.state,`pending:${p.payloadHash}`);
    let id;try{id=rec.save({enableSourcing:true,ignoreMandatoryFields:false});}catch(error){const found=externalRecord(record.Type.SALES_ORDER,p.externalId);if(found){return sealOrder(found,p);}throw error;}
    return sealOrder(record.load({type:record.Type.SALES_ORDER,id,isDynamic:false}),p);
  }

  function post(request) {
    try {
      if(request.requireSandbox!==false&&runtime.envType!==runtime.EnvType.SANDBOX){failure('This request requires a NetSuite sandbox.');}
      if(request.action==='order.health'){return {ok:true,version:'2.1.0',customerMode:'existing-only',environment:runtime.envType,writesEnabled:runtime.getCurrentScript().getParameter({name:'custscript_fs_allow_writes'})===true,multiSubsidiaryCustomers:multiCustomer(),suiteTax:suiteTax()};}
      if(request.action==='customer.lookup'){return customerResult(customerRecord(request));}
      if(request.action==='customer.ensure'){failure('Customer creation is disabled. Customers and subsidiary memberships must be created in NetSuite.');}
      if(request.action==='order.preflight'){return orderPreflight(request);}
      if(request.action==='order.lookup'){return lookupOrder(request);}
      if(request.action==='order.create'){return createOrder(request);}
      if(request.action==='health'){return {ok:true,version:'1.0.0',environment:runtime.envType,writesEnabled:runtime.getCurrentScript().getParameter({name:'custscript_fs_allow_writes'})===true};}
      if(request.action==='price'){return price(request);}
      if(request.action==='units'){
        positive(request.itemId,'item');const item=search.lookupFields({type:search.Type.ITEM,id:request.itemId,columns:['isinactive','saleunit']});
        if(item.isinactive){failure('An item is inactive.');}const unit=(Array.isArray(item.saleunit)?item.saleunit[0]:item.saleunit)||{};
        return {ok:true,unitId:unit.value?String(unit.value):null,unit:unit.text||''};
      }
      if(request.action==='lookup'){const rec=find(request.externalId);if(rec&&request.recover&&String(rec.getValue(F.state))===`pending:${request.recover.payloadHash}`){return seal(rec,request.recover);}return response(rec);}
      if(request.action==='preflight'){if(!Array.isArray(request.estimates)||request.estimates.length>3||!request.estimates.length||new Set(request.estimates.map(e=>e.company)).size!==request.estimates.length||request.estimates.some(e=>!['MBBS','MBR','MBT'].includes(e.company))){failure('Invalid estimate preflight.');}request.estimates.forEach(preflight);return {ok:true};}
      if(request.action==='write'){return write(request);}
      failure('Unsupported Field Sales action.');
    }catch(error){return {ok:false,message:String(error.message||error),permanent:error.permanent===true};}
  }
  return {post};
});
