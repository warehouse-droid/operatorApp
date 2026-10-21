/**
 * Native quotation, Sales Order and Purchase Order PDFs for signed-in users.
 * Deploy with Current Role and Available Without Login disabled.
 * GET action=estimatePdf&entityId=<internal ID>; includeContent=false gives metadata.
 * Use the RESTlet for the application's OAuth connection.
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define(['N/error','N/log','N/render','N/runtime','N/search'], (error,log,render,runtime,search) => {
  const VERSION='1.0.0',MAX_PDF_BYTES=10*1024*1024;
  const documents={
    estimatepdf:{type:search.Type.ESTIMATE,action:'estimatePdf',prefix:'EST'},
    salesorderpdf:{type:search.Type.SALES_ORDER,action:'salesOrderPdf',prefix:'SO'},
    purchaseorderpdf:{type:search.Type.PURCHASE_ORDER,action:'purchaseOrderPdf',prefix:'PO'}
  };
  const failure=(name,message)=>error.create({name,message,notifyOff:true});
  const enabled=value=>/^(true|1|yes|on)$/i.test(String(value));
  function writeJson(response,value) {
    response.setHeader({name:'Content-Type',value:'application/json; charset=utf-8'});
    response.write({output:JSON.stringify(value)});
  }
  function checkAccess(request) {
    const userId=Number(runtime.getCurrentUser().id);
    if(!Number.isSafeInteger(userId) || userId<=0) {
      throw failure('MBBS_LOGIN_REQUIRED','Sign in to NetSuite to preview this document.');
    }
    if(request.method!=='GET') {throw failure('MBBS_METHOD_NOT_ALLOWED','Use GET for PDF previews.');}
    if(enabled(request.parameters.requireSandbox) && runtime.envType!==runtime.EnvType.SANDBOX) {
      throw failure('MBBS_NOT_SANDBOX','This request requires a NetSuite sandbox.');
    }
  }
  function visibleDocument(parameters,definition) {
    const entityId=Number(parameters.entityId);
    if(!Number.isSafeInteger(entityId) || entityId<=0) {
      throw failure('MBBS_INVALID_ARGUMENT','entityId must be a positive integer.');
    }
    const visible=search.create({type:definition.type,
      filters:[['internalid','anyof',entityId],'and',['mainline','is','T']],columns:['internalid']
    }).run().getRange({start:0,end:1});
    if(visible.length!==1 || Number(visible[0].id)!==entityId) {
      throw failure('MBBS_ORDER_NOT_ACCESSIBLE','This document is unavailable to your role.');
    }
    return entityId;
  }
  function writePdf(response,parameters,definition) {
    const entityId=visibleDocument(parameters,definition);
    const pdf=render.transaction({entityId,printMode:render.PrintMode.PDF});
    const size=Number(pdf.size);
    if(!Number.isFinite(size) || size<=0 || size>MAX_PDF_BYTES) {
      throw failure('MBBS_PDF_TOO_LARGE','NetSuite returned an empty or oversized PDF.');
    }
    pdf.name=String(pdf.name || `${definition.prefix}-${entityId}.pdf`).replace(/[^a-zA-Z0-9_.-]+/g,'-');
    if(parameters.includeContent!==undefined && !enabled(parameters.includeContent)) {
      writeJson(response,{ok:true,action:definition.action,version:VERSION,entityId,
        filename:pdf.name,contentType:'application/pdf',fileSize:size,contentIncluded:false});
      return;
    }
    response.setHeader({name:'Content-Type',value:'application/pdf'});
    response.writeFile({file:pdf,isInline:true});
  }
  function onRequest({request,response}) {
    const reference=`mbbs-pdf-${Date.now()}-${Math.floor(Math.random()*1000000)}`;
    response.setHeader({name:'Cache-Control',value:'private, no-store'});
    response.setHeader({name:'X-Content-Type-Options',value:'nosniff'});
    try {
      checkAccess(request);
      const parameters=request.parameters,action=String(parameters.action || 'health').toLowerCase();
      if(action==='health') {
        writeJson(response,{ok:true,action:'health',version:VERSION,environment:String(runtime.envType),
          capabilities:{estimatePdf:true,salesOrderPdf:true,purchaseOrderPdf:true,metadataOnly:true,methods:['GET']}});
        return;
      }
      if(!Object.prototype.hasOwnProperty.call(documents,action)) {
        throw failure('MBBS_UNSUPPORTED_ACTION','Use health, estimatePdf, salesOrderPdf or purchaseOrderPdf.');
      }
      writePdf(response,parameters,documents[action]);
    } catch(caught) {
      const known=/^MBBS_/.test(String(caught.name));
      log.error({title:`MBBS PDF Suitelet failed (${reference})`,details:{code:String(caught.name),message:String(caught.message)}});
      writeJson(response,{ok:false,code:known?caught.name:'MBBS_PDF_FAILED',
        message:known?caught.message:`NetSuite could not render this document. Reference ${reference}.`});
    }
  }
  return {onRequest};
});
