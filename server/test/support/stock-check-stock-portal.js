import http from 'node:http';
import {selectedProductHtml} from './stock-check-fixture.js';
export async function stockPortal({baseline=0,shortage=false,bug=false,initialLocation='07',cleanupBug=false,checkoutBug=false,cartSelects=true,blankDate=false,boundCalendar=false,onCloseSubmit=false,summaryDateOnly=false,ajaxAdd=false,selectedPickup='Pickering',availability='Available',productAvailability='Available',pageError='',lowerAvailability=false,freshSession=false,ajaxShipping=false,dateAjaxBeforeNav=false,transientGetFailures=0,forbiddenGet=false}={}) {
  let quantity=baseline,location=freshSession?'':initialLocation,date=blankDate||freshSession?'':'10/16/2026',shipment=freshSession?'':'PICKUP|PickUp';const actions=[];
  function form(body) {return `<html><body><form method="post"><input name="__EVENTTARGET" id="__EVENTTARGET"><input name="__EVENTARGUMENT">
    <script>window.stockShippingPending=false;window.Sys={WebForms:{PageRequestManager:{getInstance:()=>({get_isInAsyncPostBack:()=>window.stockShippingPending})}}};
    async function __doPostBack(e){document.getElementById('__EVENTTARGET').value=e;
      if(${dateAjaxBeforeNav} && e==='date'){
        await fetch('/date-side-effect',{method:'POST',body:new URLSearchParams(new FormData(document.forms[0]))});
        setTimeout(()=>document.forms[0].submit(),100);return;
      }
      if(${ajaxShipping} && ['shipment','location'].includes(e)){
        window.stockShippingPending=true;
        try {
          const response=await fetch(location.pathname,{method:'POST',body:new URLSearchParams(new FormData(document.forms[0]))});
          const next=new DOMParser().parseFromString(await response.text(),'text/html');
          for(const suffix of ['dpshipment','dplocations']) {
            const selector='[id$="_'+suffix+'"]',current=document.querySelector(selector),replacement=next.querySelector(selector);
            if(current){if(replacement)current.replaceWith(replacement);else current.remove();}
            else if(replacement)document.querySelector('[id$="_dpshipment"]').after(replacement);
          }
          document.getElementById('SelectedShipping').textContent=next.getElementById('SelectedShipping').textContent;
        } finally {window.stockShippingPending=false;}
        return;
      }
      document.forms[0].submit();}
    function WebForm_PostBackOptions(e){this.event=e} function WebForm_DoPostBackWithOptions(o){__doPostBack(o.event)}</script>${body}</form></body></html>`;}
  const shipping=()=>`<a id="SelectedShipping">Pickup ${location==='07'?'Ayr':'Pickering'} ${summaryDateOnly?'':date}</a><a href="logout.aspx">Logout</a>
    <select id="ctl00_cpholder_dpshipment" name="shipment" onchange="__doPostBack('shipment')"><option value="" ${shipment===''?'selected':''}>Select Shipment Method</option><option value="PICKUP|PickUp" ${shipment?'selected':''}>Pickup</option></select>
    ${shipment?'<select id="ctl00_cpholder_dplocations" name="location" onchange="__doPostBack(\'location\')"><option value="">Select Location</option><option value="07" '+(location==='07'?'selected':'')+'>Ayr</option><option value="03" '+(location==='03'?'selected':'')+'>Pickering</option></select>':''}
    <input id="ctl00_cpholder_datepicker" name="date" value="${summaryDateOnly?'':date}">
    <script>const input=document.querySelector('[id$=_datepicker]'); window.jQuery=(el)=>({datepicker:(method,a)=>{
      if(method==='option' && a==='minDate')return new Date(2026,9,15);
      if(method==='option' && a==='beforeShowDay')return function(d){if(${boundCalendar} && !this.id?.endsWith('_datepicker'))throw new Error('Date callback requires its input');return [d>=new Date(2026,9,15)]};
      if(method==='option' && a==='dateFormat')return 'mm/dd/yy';
      if(method==='option' && a==='onSelect')return function(value){input.value=value;if(!${onCloseSubmit})__doPostBack('date')};
      if(method==='option' && a==='onClose')return function(){if(${onCloseSubmit})__doPostBack('date')};
      if(method==='setDate')input.value=(a.getMonth()+1).toString().padStart(2,'0')+'/'+a.getDate().toString().padStart(2,'0')+'/'+a.getFullYear();
    }});window.jQuery.datepicker={formatDate:(f,d)=>(d.getMonth()+1).toString().padStart(2,'0')+'/'+d.getDate().toString().padStart(2,'0')+'/'+d.getFullYear(),_getInst:()=>({})};
    input.addEventListener('click',()=>document.getElementById('ui-datepicker-div').hidden=false);
    document.addEventListener('click',e=>{if(e.target.matches('[data-stock-calendar-day]')){e.preventDefault();const value='10/'+e.target.textContent+'/2026',picker=window.jQuery(input);picker.datepicker('option','onSelect').call(input,value,{});picker.datepicker('option','onClose').call(input,value,{});}});
    </script><div id="ui-datepicker-div" hidden><table class="ui-datepicker-calendar"><tr><td data-year="2026" data-month="9"><a href="#" data-stock-calendar-day>15</a></td><td data-year="2026" data-month="9"><a href="#" data-stock-calendar-day>16</a></td></tr></table></div>`;
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req) {body+=chunk;}
    const fields=new URLSearchParams(body),event=fields.get('__EVENTTARGET');actions.push({path:req.url,event,quantity:fields.get('quantity'),method:req.method});
    if(req.method==='GET' && req.url.startsWith('/products/') && (transientGetFailures>0 || forbiddenGet)) {
      transientGetFailures--;res.writeHead(forbiddenGet?403:503,{'content-type':'text/html'});res.end('<h1>Temporarily unavailable</h1>');return;
    }
    if(req.method==='POST') {
      if(event==='login') {res.writeHead(302,{location:'/loggedinwelcome.aspx'});res.end();return;}
      if(event==='date') {date=fields.get('date');}
      if(event==='shipment') {shipment=fields.get('shipment');if(!shipment) {location='';date='';}}
      if(event==='location') {location=fields.get('location');}
      if(event==='add' && !shortage && !bug) {quantity+=Number(fields.get('quantity'));}
      if(event==='remove' && !cleanupBug) {quantity=0;}
      if(event==='update') {quantity=Number(fields.get('cartqty'));}
      if(req.url==='/async-add') {res.setHeader('content-type','application/json');res.end(JSON.stringify({accepted:true}));return;}
    }
    let html;
    if(req.url.startsWith('/login.aspx')) {html=form('<input id="txtUserName" name="username"><input id="ctl00_cpholder_txtPassword" name="password" type="password"><a id="ctl00_cpholder_bLogin" href="javascript:__doPostBack(\'login\')">Login</a>');}
    else if(req.url.startsWith('/shoppingCart.aspx')) {
      const shippingHtml=cartSelects?shipping():shipping().replace(/<select[^>]*id="ctl00_cpholder_(dplocations|dpshipment)"[\s\S]*?<\/select>/gu,'');
      html=form(shippingHtml+(summaryDateOnly?'<section><h2>Order Summary</h2>Requested By: '+date+'</section>':'')+(quantity?`<div><a id="x_HyperLink1">177ECS0163703-0</a><input id="x_QuantityTextBox" name="cartqty" value="${quantity}"><select id="x_iuom"><option value="BNDL">Bundle</option></select><span id="x_availability">${availability}</span><a id="x_removefromcart" href="javascript:__doPostBack('remove')">Remove</a></div>`:'')+'<a id="ctl00_cpholder_CartInfoCtl_butUpdatCart" href="javascript:__doPostBack(\'update\')">Update Cart</a>');
    } else if(req.url.startsWith('/products/')) {
      const raw=selectedProductHtml({pickup:selectedPickup}).split('<form')[1].replace(/^[^>]*>/u,'').split('</form>')[0].replace(/<input[^>]*type="password"[^>]*>/gu,'');
      html=form(shipping()+raw+(lowerAvailability?'<div style="height:1600px"></div>':'')+'<select id="ctl00_cpholder_uomctl_iuom" '+(lowerAvailability?'style="background:rgb(1,197,163);width:600px;height:50px"':'')+'><option value="BNDL">BNDL | 52.31 sqft | '+productAvailability+'</option></select><input id="ctl00_cpholder_TxtQty" name="quantity"><a id="ctl00_cpholder_ibAddToCart" href="javascript:__doPostBack(\''+(checkoutBug?'checkout':'add')+'\')">Add to Cart</a>'+(pageError?'<div id="x_lblError">'+pageError+'</div>':'')+
        (event==='add' && shortage?'<div id="x_lblError">Insufficient stock for requested quantity</div>':'')+(event==='add' && bug?'<div id="x_lblError">System error. Please contact customer service.</div>':''));
      if(ajaxAdd) {html=html.replace('</body>','<div id="stock-add-confirmation" hidden>Your item has been added</div><script>document.getElementById("ctl00_cpholder_ibAddToCart").onclick=async function(e){e.preventDefault();await fetch("/async-add",{method:"POST",body:new URLSearchParams({__EVENTTARGET:"add",quantity:document.querySelector("[id$=_TxtQty]").value})});document.getElementById("stock-add-confirmation").hidden=false;return false;}</script></body>');}
    } else {html=form(shipping());}
    res.setHeader('content-type','text/html; charset=utf-8');res.end(html);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {baseUrl:'http://127.0.0.1:'+server.address().port,actions,get quantity(){return quantity;},get date(){return date;},get location(){return location;},get shipment(){return shipment;},close:()=>new Promise(resolve=>server.close(resolve))};
}
