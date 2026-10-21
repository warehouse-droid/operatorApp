(()=>{
  'use strict';
  const app=document.getElementById('stockCheckApp'),base='/api/scm/stock-check';
  const page=location.pathname.endsWith('/setup')?'setup':location.pathname.endsWith('/test')?'test':'catalog';
  const state={vendors:[],accounts:[],products:[],vendorId:null,offset:0,total:0,selected:null,job:null,timer:null,blobs:new Map()};
  const escape=value=>String(value??'').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const labels={stock_confirmed:'Stock confirmed',in_production:'Stock confirmed',availability_unverified:'Availability not verified · SCM review',insufficient_stock:'Insufficient stock',scrape_failure:'Scrape failure · SCM review',catalog_refreshed:'Catalog refreshed',partial:'Catalog saved · review needed',login_verified:'Login verified'};
  const stamp=value=>value?new Date(value).toLocaleString():'—';
  const byId=id=>document.getElementById(id);
  async function api(url,method='GET',body) {
    const response=await fetch(base+url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    const data=await response.json();if(!response.ok) {throw new Error(data.error||'The request failed.');}return data;
  }
  function message(text,success=false) {const node=byId('stockMessage');node.textContent=text;node.className='stock-message'+(success?' success':'');}
  const safe=action=>async event=>{try {await action(event);}catch(error) {message(error.message);}};
  function vendor() {return state.vendors.find(row=>row.id===state.vendorId);}
  function header(operator) {
    app.innerHTML=`<div class="stock-shell"><header class="dispatch-topbar"><div><p>SCM</p><h1>Stock Check</h1></div><div class="topbar-actions"><span>${escape(operator.display_name||operator.username)}</span><button id="stockScm">SCM Menu</button></div></header>
      <nav class="stock-nav" aria-label="Stock Check pages">${[['catalog','Product Pickup Points','/scm/stock-check'],['test','Test Stock Check','/scm/stock-check/test'],['setup','Vendor Setup','/scm/stock-check/setup']].map(([key,title,url])=>`<a href="${url}" ${page===key?'aria-current="page"':''}>${title}</a>`).join('')}</nav>
      <div id="stockMessage" class="stock-message" role="alert"></div><div class="stock-toolbar"><div><label for="stockVendor">Vendor</label><select id="stockVendor"></select></div><span id="stockVendorStatus" class="stock-muted"></span></div>
      <div id="stockContent"></div><section id="stockJob" class="stock-panel" hidden aria-label="Check result"></section><dialog id="stockDialog" class="stock-dialog"></dialog></div>`;
    byId('stockScm').onclick=()=>{location.href='/scm';};
    byId('stockVendor').onchange=safe(async()=>{state.vendorId=Number(byId('stockVendor').value);state.offset=0;state.selected=null;await content();});
  }
  async function vendors() {
    state.vendors=await api('/vendors');state.vendorId??=state.vendors.find(row=>row.active)?.id??state.vendors[0]?.id;
    byId('stockVendor').innerHTML=state.vendors.map(row=>`<option value="${row.id}">${escape(row.name)}${row.active?'':' (inactive)'}</option>`).join('');
    byId('stockVendor').value=String(state.vendorId);
  }
  async function content() {
    state.accounts=state.vendorId?await api('/vendors/'+state.vendorId+'/accounts'):[];
    const current=vendor(),selected=state.accounts.find(row=>row.id===current?.selectedAccountId);
    byId('stockVendorStatus').textContent=current?.methodKey==='unilock-ontario-v1'?`Unilock Ontario · ${selected?'Login: '+selected.label:'Set up a vendor login'}`:'Vendor method awaiting definition and testing';
    if(page==='setup') {setup();}else if(page==='test') {await tester();}else {await catalog();}
  }
  async function loadProducts(search='',review=false) {
    const result=await api('/products?'+new URLSearchParams({vendorId:state.vendorId,search,offset:state.offset,limit:100,reviewOnly:review}));
    state.products=result.items;state.total=result.total;return result;
  }
  function catalogRows() {
    byId('stockRows').innerHTML=state.products.map(row=>`<tr><td>${escape(row.sku)}</td><td><strong>${escape(row.name)}</strong><small>${escape(row.series)} · ${row.hasOverrides?'SCM correction':row.manualCreated?'Manual entry':'Vendor data'}<br>Scraped ${escape(stamp(row.lastScrapedAt))}</small></td>
      <td>${escape(row.colour)}<small>${escape(row.finish)}</small></td><td>${escape(row.size||row.shape)}<small>${escape(row.dimensions)}</small></td><td>${escape(row.pickupLocation||'No displayed plant')} ${row.pickupNeedsReview?'<span class="stock-badge review">Review</span>':''}</td><td><button data-edit="${row.id}">Edit</button></td></tr>`).join('')||'<tr><td colspan="6">No matching product variants. Add one manually or re-scrape this vendor.</td></tr>';
    byId('stockCount').textContent=`${state.total} variants · ${state.total?state.offset+1:0}–${Math.min(state.offset+100,state.total)}`;
    byId('stockPrevious').disabled=state.offset===0;byId('stockNext').disabled=state.offset+100>=state.total;
    byId('stockRows').querySelectorAll('[data-edit]').forEach(button=>{button.onclick=()=>editProduct(state.products.find(row=>row.id===Number(button.dataset.edit)));});
  }
  async function catalog() {
    byId('stockContent').innerHTML=`<section class="stock-panel"><h2>Product Pickup Points</h2><p class="stock-muted">Pickup points belong to each exact colour and size. SCM corrections are kept when vendor data is refreshed.</p>
      <div class="stock-toolbar"><label class="stock-search">Product name or vendor SKU<input id="stockSearch" type="search" placeholder="Beacon Hill Smooth Granite Fusion"></label><label><span>Review filter</span><select id="stockReview"><option value="">All products</option><option value="true">Pickup review needed</option></select></label><button id="stockFind">Search</button><button id="stockAddProduct">Add Product</button><button id="stockRefresh" class="primary">Re-scrape Vendor</button></div>
      <div class="stock-table-wrap"><table class="stock-table"><thead><tr><th>Vendor SKU</th><th>Product</th><th>Colour / Finish</th><th>Size</th><th>Major Pickup Point</th><th>Action</th></tr></thead><tbody id="stockRows"></tbody></table></div>
      <div class="stock-actions"><span id="stockCount"></span><button id="stockPrevious">Previous</button><button id="stockNext">Next</button></div></section>`;
    const search=async()=>{await loadProducts(byId('stockSearch').value,byId('stockReview').value==='true');catalogRows();};
    byId('stockFind').onclick=safe(async()=>{state.offset=0;await search();});byId('stockSearch').onkeydown=safe(async e=>{if(e.key==='Enter') {state.offset=0;await search();}});
    byId('stockReview').onchange=safe(async()=>{state.offset=0;await search();});
    byId('stockPrevious').onclick=safe(async()=>{state.offset-=100;await search();});byId('stockNext').onclick=safe(async()=>{state.offset+=100;await search();});
    byId('stockAddProduct').onclick=()=>editProduct(null);byId('stockRefresh').disabled=vendor()?.methodKey!=='unilock-ontario-v1';
    byId('stockRefresh').onclick=safe(()=>queue({kind:'catalog_refresh'}));await search();
  }
  function openDialog(html) {const dialog=byId('stockDialog');dialog.innerHTML=html;dialog.querySelectorAll('[data-close]').forEach(button=>{button.onclick=()=>dialog.close();});dialog.showModal();return dialog;}
  function editProduct(row) {
    const fields=[['name','Product Name'],['series','Series'],['colour','Colour'],['finish','Finish'],['shape','Shape'],['size','Size'],['dimensions','Dimensions'],['pickupLocation','Major Pickup Point'],['url','Vendor Product URL']];
    const dialog=openDialog(`<form id="stockProductForm"><h2>${row?'Edit Product':'Add Product'}</h2>${row?`<p>${escape(row.sku)}</p>`:'<label>Vendor SKU<input name="sku" required maxlength="120"></label>'}${fields.map(([key,label])=>`<label>${label}<input name="${key}" value="${escape(row?.[key]||'')}" ${key==='name'||key==='url'?'required':''} maxlength="${key==='url'?2000:240}"></label>`).join('')}<p class="stock-muted">Use the displayed plant label. Missing or unfamiliar pickup points remain marked for review.</p><div class="stock-actions"><button type="submit" class="primary">Save</button>${row?'<button type="button" id="stockResetProduct">Use Vendor Values</button>':''}<button type="button" data-close>Cancel</button></div></form>`);
    dialog.querySelector('form').onsubmit=safe(async event=>{
      event.preventDefault();const values=Object.fromEntries(new FormData(event.target)),overrides={...row?.overrides};
      if(row) {for(const [key] of fields) {if(values[key]!==String(row.source[key]??'')) {overrides[key]=values[key];}else {delete overrides[key];}}}
      await api('/vendors/'+state.vendorId+'/products'+(row?'/'+row.id:''),row?'PATCH':'POST',row?{revision:row.revision,overrides}:values);
      dialog.close();message('Product saved.',true);await catalog();
    });
    if(row) {byId('stockResetProduct').onclick=safe(async()=>{await api('/vendors/'+state.vendorId+'/products/'+row.id,'PATCH',{revision:row.revision,overrides:{}});dialog.close();await catalog();message('Vendor values restored.',true);});}
  }
  function setup() {
    const current=vendor();
    byId('stockContent').innerHTML=`<section class="stock-panel"><h2>Vendor Setup</h2><p class="stock-muted">Save one or more named logins for each vendor, then select the account used for stock checks. Saved passwords are never displayed.</p><div class="stock-actions"><button id="stockAddVendor">Add Vendor</button><button id="stockEditVendor">Edit Vendor</button><button id="stockAddAccount" class="primary">Add Login</button></div>
      <div class="stock-table-wrap"><table class="stock-table"><thead><tr><th>Account</th><th>Login ID</th><th>Password</th><th>Last Login Test</th><th>Actions</th></tr></thead><tbody>${state.accounts.map(row=>`<tr class="${row.selected?'stock-account-selected':''}"><td>${escape(row.label)} ${row.selected?'<span class="stock-badge">Selected</span>':''}${row.active?'':' (inactive)'}</td><td>${escape(row.username)}</td><td>${row.configured?'Saved securely':'Missing'}</td><td>${escape(stamp(row.lastVerifiedAt))}<small>${escape(row.lastError)}</small></td><td><button data-account="${row.id}">Edit</button> <button data-select="${row.id}" ${row.selected||!row.active?'disabled':''}>Use Account</button> <button data-verify="${row.id}" ${!row.active||current?.methodKey!=='unilock-ontario-v1'?'disabled':''}>Test Login</button></td></tr>`).join('')||'<tr><td colspan="5">No logins saved for this vendor.</td></tr>'}</tbody></table></div></section>`;
    byId('stockAddVendor').onclick=()=>editVendor(null);byId('stockEditVendor').onclick=()=>editVendor(current);byId('stockAddAccount').onclick=()=>editAccount(null);
    byId('stockContent').querySelectorAll('[data-account]').forEach(button=>{button.onclick=()=>editAccount(state.accounts.find(row=>row.id===Number(button.dataset.account)));});
    byId('stockContent').querySelectorAll('[data-select]').forEach(button=>{button.onclick=safe(async()=>{
      await api('/vendors/'+state.vendorId,'PATCH',{...vendor(),selectedAccountId:Number(button.dataset.select)});await vendors();await content();message('Vendor account selected.',true);
    });});
    byId('stockContent').querySelectorAll('[data-verify]').forEach(button=>{button.onclick=safe(()=>queue({kind:'login_test',accountId:Number(button.dataset.verify)}));});
  }
  function editVendor(row) {
    const dialog=openDialog(`<form><h2>${row?'Edit':'Add'} Vendor</h2><label>Vendor Name<input name="name" value="${escape(row?.name)}" required maxlength="120"></label><label>Stock Check Method<select name="methodKey"><option value="pending">Awaiting method definition and testing</option><option value="unilock-ontario-v1">Unilock Ontario</option></select></label><p class="stock-muted">Each vendor needs its own defined and tested portal method.</p><div class="stock-actions"><button class="primary">Save Vendor</button><button type="button" data-close>Cancel</button></div></form>`);
    dialog.querySelector('select').value=row?.methodKey||'pending';dialog.querySelector('form').onsubmit=safe(async event=>{
      event.preventDefault();const values=Object.fromEntries(new FormData(event.target));const saved=await api('/vendors'+(row?'/'+row.id:''),row?'PATCH':'POST',{...values,...(row?{revision:row.revision}:{})});
      state.vendorId=saved.id;dialog.close();await vendors();await content();message('Vendor saved.',true);
    });
  }
  function editAccount(row) {
    const dialog=openDialog(`<form><h2>${row?'Edit':'Add'} Vendor Login</h2><label>Account Label<input name="label" value="${escape(row?.label)}" required maxlength="100" placeholder="Main stock login"></label><label>Login ID<input name="username" value="${escape(row?.username)}" required maxlength="100" autocomplete="off"></label><label>Password<input name="password" type="password" maxlength="2000" autocomplete="new-password" ${row?'':'required'}></label>${row?'<p class="stock-muted">Leave Password blank to keep the saved password.</p>':''}<label>Account Status<select name="active"><option value="true">Active</option><option value="false">Inactive</option></select></label><div class="stock-actions"><button class="primary">Save Login</button><button type="button" data-close>Cancel</button></div></form>`);
    dialog.querySelector('select').value=String(row?.active!==false);dialog.querySelector('form').onsubmit=safe(async event=>{
      event.preventDefault();const values=Object.fromEntries(new FormData(event.target));values.active=values.active==='true';
      await api('/vendors/'+state.vendorId+'/accounts'+(row?'/'+row.id:''),row?'PATCH':'POST',{...values,...(row?{revision:row.revision}:{})});
      event.target.reset();dialog.close();dialog.innerHTML='';await vendors();await content();message('Vendor login saved securely.',true);
    });
  }
  async function tester() {
    byId('stockContent').innerHTML=`<section class="stock-panel"><h2>Test Stock Check</h2><p class="stock-muted">Choose an exact colour and size, then test the requested number of bundles. The check records every step and restores its cart changes afterward.</p>
      <div class="stock-toolbar"><label class="stock-search">Item Name or Vendor SKU<input id="stockSearch" type="search" placeholder="Beacon Hill Smooth XL 6 cm Granite Fusion"></label><button id="stockFind">Find Item</button><label>Bundles (Pallets)<input id="stockQuantity" type="number" min="1" max="99999" step="1" value="5"></label></div><div id="stockMatches" class="stock-results"></div><p id="stockSelection" class="stock-muted">Select a product variant to continue.</p><button id="stockRun" class="primary" disabled>Run Stock Check</button></section><section class="stock-panel"><h2>Recent Checks</h2><div id="stockHistory"></div></section>`;
    const search=async()=>{state.offset=0;state.selected=null;await loadProducts(byId('stockSearch').value);matches();};
    byId('stockFind').onclick=safe(search);byId('stockSearch').onkeydown=safe(async event=>{if(event.key==='Enter') {await search();}});
    byId('stockRun').onclick=safe(()=>queue({kind:'stock_test',productId:state.selected.id,quantity:Number(byId('stockQuantity').value)}));
    await history();
  }
  function matches() {
    byId('stockMatches').innerHTML=state.products.map(row=>`<button data-product="${row.id}" aria-pressed="${state.selected?.id===row.id}"><strong>${escape(row.name)}</strong><br>${escape(row.sku)} · ${escape(row.colour)} · ${escape(row.size||row.shape)} · Pickup: ${escape(row.pickupLocation||'Review needed')}${row.pickupNeedsReview?' · SCM review required':''}</button>`).join('')||'<p>No matching variants. Try fewer search words or the exact vendor SKU.</p>';
    byId('stockMatches').querySelectorAll('[data-product]').forEach(button=>{button.onclick=()=>{state.selected=state.products.find(row=>row.id===Number(button.dataset.product));matches();};});
    byId('stockRun').disabled=!state.selected||state.selected.pickupNeedsReview||!vendor()?.selectedAccountId||vendor()?.methodKey!=='unilock-ontario-v1';
    byId('stockSelection').textContent=state.selected?state.selected.name+' · '+state.selected.sku+' · '+(state.selected.pickupNeedsReview?'Correct the pickup point before testing.':'Pickup '+state.selected.pickupLocation):'Select the requested colour and size.';
  }
  async function history() {
    const jobs=await api('/jobs?vendorId='+state.vendorId);
    byId('stockHistory').innerHTML=jobs.map(job=>`<div class="stock-actions"><button data-job="${job.id}">${escape(job.payload.product?.name||job.kind.replaceAll('_',' '))} · ${escape(labels[job.result?.status]||job.status)} · ${escape(stamp(job.createdAt))}</button></div>`).join('')||'<p class="stock-muted">No checks recorded yet.</p>';
    byId('stockHistory').querySelectorAll('[data-job]').forEach(button=>{button.onclick=safe(()=>watch(button.dataset.job));});
  }
  async function queue(input) {const job=await api('/vendors/'+state.vendorId+'/jobs','POST',input);message('Check queued.',true);await watch(job.id);}
  async function watch(id) {
    clearTimeout(state.timer);state.job=id;await refreshJob();
  }
  function jobHeading(job) {
    const result=job.result;
    return `<h2>Check Result</h2><p class="stock-status">${escape(labels[result?.status]||job.status)}</p><p>${escape(result?.reason||'Waiting for the vendor portal…')}</p><p class="stock-muted">${escape(job.payload.product?.name||job.kind.replaceAll('_',' '))}${job.payload.quantity?' · '+job.payload.quantity+' bundles':''}${result?.pickupLocation?' · '+escape(result.pickupLocation):''}${result?.requestDate?' · '+escape(result.requestDate):''}</p>${result?.availabilityText?'<p><strong>Vendor availability:</strong> '+escape(result.availabilityText)+'</p>':''}${result?.eta?'<p><strong>ETA:</strong> '+escape(result.eta)+'</p>':''}`;
  }
  function jobDetails(job,running) {
    return `${job.progress.seriesTotal?`<p>Series ${job.progress.seriesVisited}/${job.progress.seriesTotal} · ${job.progress.imported} variants saved · ${job.progress.failed} require review</p>`:''}${running?'<button id="stockCancel">Cancel Check</button>':''}
      <div class="stock-steps"><table class="stock-table"><thead><tr><th>Step</th><th>Result</th><th>Detail</th></tr></thead><tbody>${(job.steps||[]).map((step,index)=>`<tr><td>${index+1}. ${escape(step.key.replaceAll('_',' '))}</td><td><span class="stock-badge ${escape(step.status)}">${escape(step.status)}</span></td><td>${escape(step.detail)}</td></tr>`).join('')}</tbody></table></div><div id="stockEvidence" class="stock-evidence"></div>`;
  }
  async function refreshJob() {
    const job=await api('/jobs/'+state.job);const node=byId('stockJob');node.hidden=false;
    const running=['queued','running'].includes(job.status);
    node.innerHTML=jobHeading(job)+jobDetails(job,running);
    if(running) {byId('stockCancel').onclick=safe(async()=>{await api('/jobs/'+job.id+'/cancel','POST',{});message('Cancellation requested. Cart restoration will finish before the check stops.',true);});}
    for(const step of (job.steps||[]).filter(row=>row.screenshot)) {
      const key=job.id+'/'+step.screenshot;let url=state.blobs.get(key);
      if(!url) {const response=await fetch(base+'/jobs/'+job.id+'/evidence/'+step.screenshot);if(!response.ok) {continue;}url=URL.createObjectURL(await response.blob());state.blobs.set(key,url);}
      const figure=document.createElement('figure'),link=document.createElement('a'),image=document.createElement('img'),caption=document.createElement('figcaption');
      link.href=url;link.target='_blank';link.rel='noopener';image.src=url;image.alt=step.key.replaceAll('_',' ')+' screenshot';caption.textContent=step.key.replaceAll('_',' ');link.append(image);figure.append(link,caption);byId('stockEvidence').append(figure);
    }
    if(running) {state.timer=setTimeout(()=>void refreshJob().catch(error=>message(error.message)),2000);}else {
      if(page==='test') {await history();}if(page==='setup') {await content();}
    }
  }
  window.addEventListener('pagehide',()=>{clearTimeout(state.timer);for(const url of state.blobs.values()) {URL.revokeObjectURL(url);}});
  requireDispatchLogin({mount:app,roles:['admin','scm','scm_staff'],onReady:async operator=>{
    header(operator);try {await vendors();await content();}catch(error) {message(error.message);}
  }});
})();
