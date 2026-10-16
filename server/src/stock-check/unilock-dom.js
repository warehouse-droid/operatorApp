import {normalizeProduct,StockCheckError} from './domain.js';

/** Read only structured controls/labels; raw HTML and passwords are not persisted. */
export async function readPortalDocument(page,html=null) {
  return page.evaluate(markup=>{
    const root=markup===null?document:new DOMParser().parseFromString(markup,'text/html');
    const text=node=>String(node?.textContent??'').replace(/\s+/gu,' ').trim();
    const suffix=(scope,id)=>scope.querySelector('[id$="_'+id+'"]');
    function eventFor(node) {
      const href=node?.getAttribute('href')??'';
      return /(?:new WebForm_PostBackOptions\(|__doPostBack\()\s*["']([^"']+)/u.exec(href)?.[1]??'';
    }
    function fieldsFor(form) {
      const fields={};
      for(const control of form?.querySelectorAll('input,select,textarea')??[]) {
        const name=control.getAttribute('name'),type=String(control.getAttribute('type')??'').toLowerCase();
        if(!name || control.disabled || /password/iu.test(name) || ['password','submit','button','image','file','reset'].includes(type)) {continue;}
        if(['checkbox','radio'].includes(type) && !control.checked) {continue;}
        fields[name]=control.value??'';
      }
      return fields;
    }
    function childRow(link) {
      return {sku:link.getAttribute('title')??'',event:eventFor(link),id:link.id,
        name:text(suffix(link,'Label2')),dimensions:text(suffix(link,'Label4')),imperial:text(suffix(link,'Label5')),
        imageUrl:link.querySelector('img.childItemImg')?.getAttribute('src')??'',
        tilePlant:text(suffix(link,'PlantDescription'))};
    }
    function cartRow(input) {
      let ancestor=input.parentElement;
      while(ancestor) {
        const skuLink=suffix(ancestor,'HyperLink1'),remove=suffix(ancestor,'removefromcart');
        if(skuLink && remove && ancestor.querySelectorAll('input[id$="_QuantityTextBox"]').length===1) {
          const uom=suffix(ancestor,'iuom');
          const availabilityNodes=[...ancestor.querySelectorAll('[id$="_availability"]')].filter(visible),
            availabilityTexts=[...new Set(availabilityNodes.map(text).filter(Boolean))];
          return {sku:text(skuLink),quantity:Number(input.value),uom:uom?.value??'',
            quantityField:input.name,quantityId:input.id,removeEvent:eventFor(remove),removeId:remove.id,
            availabilityText:availabilityTexts.join(' | '),availabilityAmbiguous:availabilityTexts.length>1,availabilityId:availabilityNodes[0]?.id??''};
        }
        ancestor=ancestor.parentElement;
      }
      return null;
    }
    function visible(node) {
      for(let ancestor=node;ancestor;ancestor=ancestor.parentElement) {
        if(ancestor.hidden || /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(ancestor.getAttribute('style')??'')) {return false;}
      }
      if(root===document && window.getComputedStyle(node).display==='none') {return false;}
      return true;
    }
    function visibleText(node) {
      if(!node || !visible(node)) {return '';}
      return text(node);
    }
    function bundleAvailability(selects,stockLabel) {
      const select=selects.find(row=>row.id.endsWith('_uomctl_iuom'));
      const options=select?.options.filter(item=>item.value==='BNDL'&&/^BNDL\b/iu.test(item.label))??[];
      const labels=[...new Set(options.map(option=>option.label.split('|').slice(2).join('|').trim()).filter(Boolean))];
      if(!labels.length) {return {productBundleAvailability:stockLabel,productAvailabilitySource:'product_label',productAvailabilityId:suffix(root,'stockAvail')?.id??''};}
      return {productBundleAvailability:labels.join(' | '),productAvailabilitySource:'product_bundle',productAvailabilityId:select.id};
    }
    const form=root.querySelector('form'),children=[...root.querySelectorAll('a[id*="_rptChildItem_"][id$="_Link"]')].map(childRow);
    const sku=text(suffix(root,'selectedItemNo')),chosen=children.find(row=>row.sku===sku);
    const name=text(suffix(root,'selectedItemName')),finish=text(suffix(root,'selectedFinish')),
      colour=text(suffix(root,'selectedColour')),shape=text(suffix(root,'selectedShape')),
      pickupLocation=text(suffix(root,'selectedItemLocation'));
    const quantities=[...root.querySelectorAll('input[id$="_QuantityTextBox"]')],cartRows=quantities.map(cartRow).filter(Boolean);
    const shipping=text(root.querySelector('#SelectedShipping,[id$="_SelectedShipping"]'));
    const selects=[...root.querySelectorAll('select')].map(select=>({id:select.id,name:select.name,value:select.value,
      options:[...select.options].map(option=>({value:option.value,label:text(option),selected:option.selected}))}));
    const stockLabel=visibleText(suffix(root,'stockAvail')),availability=bundleAvailability(selects,stockLabel);
    const errors=[...root.querySelectorAll('[id*="_Error"],[id*="_error"],[id$="_lblError"],[id$="_itemMsg"],.alert-danger,.validation-summary-errors')]
      .filter(visible).map(text).filter(Boolean);
    const products=[...root.querySelectorAll('a[href*="/products/products/"]')]
      .map(link=>({url:link.getAttribute('href'),name:text(link)})).filter(row=>row.name && !row.url.startsWith('javascript:'));
    const pagination=[...root.querySelectorAll('a')].filter(link=>/pager|pages|pageNumber/iu.test(link.id) && /next|^\d+$/iu.test(text(link)))
      .map(link=>({event:eventFor(link),label:text(link),url:link.getAttribute('href')}));
    const body=root.body?.cloneNode(true);
    for(const node of body?.querySelectorAll('script,style,input,textarea')??[]) {node.remove();}
    return {title:text(root.querySelector('title')),fields:fieldsFor(form),formAction:form?.getAttribute('action')??'',
      selected:sku?{sku,name,finish,colour,shape,pickupLocation,dimensions:chosen?.dimensions??'',
        size:[chosen?.dimensions,chosen?.imperial].filter(Boolean).join(' / '),imageUrl:chosen?.imageUrl??'',
        sourceLabel:[name,[finish,colour].filter(Boolean).join(' '),shape,pickupLocation,sku].join('\n')}:null,
      colours:[...root.querySelectorAll('a[id$="_colorFinishId"]')].map(link=>({id:link.id,event:eventFor(link),label:text(link),title:link.title})),
      children,cartRows,cartParseFailures:quantities.length-cartRows.length,shipping,selects,errors,products,pagination,
      stockLabel,...availability,bodyText:text(body).slice(0,12000)};
  },html);
}

/** @param {any} doc @param {{productUrl:string,expectedSku?:string,baseUrl?:string,allowTestOrigin?:boolean,allowUnmappedPickup?:boolean}} options */
export function selectedProductFromDocument(doc,{productUrl,expectedSku,baseUrl,allowTestOrigin=false,allowUnmappedPickup=false}) {
  if(!doc.selected?.sku || !doc.selected.name) {
    throw new StockCheckError('The selected colour/size product label was not returned by the portal.',422,'STOCK_CHECK_PRODUCT_SELECTION_MISSING');
  }
  if(expectedSku && doc.selected.sku!==expectedSku) {
    throw new StockCheckError('The selected product SKU does not match the requested variant.',422,'STOCK_CHECK_PRODUCT_MISMATCH');
  }
  return normalizeProduct({...doc.selected,series:doc.title.split(' - ')[2]??'',url:productUrl},{baseUrl,allowTestOrigin,allowUnmappedPickup});
}
