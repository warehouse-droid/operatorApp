(() => {
  const mount=document.getElementById('scmStockRequestApp');if(!mount) {return;}
  const esc=value=>String(value??'').replace(/[&<>"']/gu,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const unilock=name=>/^unilock(?:\s+(?:ltd\.?|limited|inc\.?|ontario))?$/iu.test(String(name??'').trim());
  const eligible=(d,line)=>unilock(line.responseVendorName||line.vendorName||line.brand||d.vendorName);
  const busy=job=>['queued','running'].includes(job?.status);
  let current=null,generation=0,timer=null,scheduled=false,dialog=null;
  const rendered=new WeakMap();
  async function api(url,body,signal) {
    const response=await fetch('/api/scm/stock-check'+url,{cache:'no-store',method:body?'POST':'GET',
      headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal});
    const data=await response.json();if(!response.ok) {const error=new Error(data.error||'Live stock check could not be completed.');error.status=response.status;throw error;}return data;
  }
  function header(d) {
    const lines=d.lines.filter(line=>eligible(d,line));
    if(!lines.length) {return '<h3>Line responses</h3>';}
    const signature=JSON.stringify(lines.map(line=>[line.id,line.productName,line.color,line.size,line.detailSpec,line.quantity,line.uom,line.responseVendorName,line.vendorName,line.brand,line.vendorReference]));
    return `<div class="stock-live-heading"><h3>Line responses</h3><button type="button" data-live-stock-start="${Number(d.id)}" data-live-stock-context="${esc(signature)}">Live Stock Check</button></div><p class="stock-live-feedback" data-live-stock-feedback="${Number(d.id)}" role="status"></p>`;
  }
  function line(d,item) {
    return eligible(d,item)?`<span class="stock-live-result" data-live-stock-request="${Number(d.id)}" data-live-stock-line="${Number(item.id)}">Live stock: Not checked</span>`:'';
  }
  function label(line) {
    if(line.stale) {return 'Recheck required';}
    const job=line.job;if(!job) {return line.product?'Not checked':'Select variant';}
    if(busy(job)) {return job.status==='queued'?'Queued':'Checking…';}
    if(job.status==='cancelled') {return 'Cancelled';}
    const result=job.result??{};
    if(job.status==='failed') {return 'Check failed · retry';}
    if(result.status==='in_production') {return 'Next Production'+(result.eta?' · '+result.eta:' · ETA unavailable');}
    return ({stock_available:'In stock',low_stock:'Low inventory',insufficient_stock:'Unavailable',availability_unverified:'Availability unverified'})[result.status]||'Check failed · retry';
  }
  function paint() {
    if(!current) {return;}
    const button=mount.querySelector('[data-live-stock-start="'+current.id+'"]');
    if(button) {button.disabled=current.loading||current.matching||current.starting||(!current.error&&Boolean(current.data?.lines.some(line=>busy(line.job))));}
    const feedback=mount.querySelector('[data-live-stock-feedback="'+current.id+'"]');
    const message=current.matching?'Matching ambiguous items with Ollama…':current.error;
    if(feedback) {if(feedback.textContent!==message) {feedback.textContent=message;}feedback.classList.toggle('stock-live-matching',Boolean(current.matching));}
    for(const node of mount.querySelectorAll('[data-live-stock-line]')) {paintLine(node);}
  }
  function lineMarkup(row) {
    if(!row) {return 'Live stock: '+(current.loading?'Loading…':'Not checked');}
    const text=esc(label(row)),job=row.job;
    if(!job) {return 'Live stock: '+text;}
    const title=[job.payload.product?.name,job.payload.product?.sku,'Checked '+new Date(job.finishedAt||job.createdAt).toLocaleString(),'Click to view evidence'].filter(Boolean).join(' · ');
    return `Live stock: <a href="/scm/stock-check/history?vendorId=${Number(job.vendorId)}&amp;job=${esc(job.id)}" target="_blank" rel="noopener" title="${esc(title)}">${text}</a>`;
  }
  function paintLine(node) {
    if(Number(node.dataset.liveStockRequest)!==current.id) {return;}
    const row=current.data?.lines.find(line=>line.lineId===Number(node.dataset.liveStockLine)),html=lineMarkup(row);
    if(rendered.get(node)!==html) {node.innerHTML=html;rendered.set(node,html);}
    node.dataset.liveStatus=row?.stale?'stale':row?.job?.result?.status||row?.job?.status||'unchecked';
  }
  function same(entry,version) {return current===entry && generation===version;}
  async function load(entry,version) {
    clearTimeout(timer);entry.loading=true;const read=entry.read=(entry.read||0)+1;paint();
    try {
      const data=await api('/requests/'+entry.id);
      if(!same(entry,version) || entry.read!==read) {return;}
      entry.data=data;entry.error='';
      if(data.lines.some(line=>busy(line.job))) {timer=setTimeout(()=>void load(entry,version),2000);}
    } catch(error) {if(same(entry,version) && entry.read===read) {entry.error=error.message;}}
    finally {if(same(entry,version) && entry.read===read) {entry.loading=false;paint();}}
  }
  function sync() {
    scheduled=false;
    const button=mount.querySelector('[data-live-stock-start]');
    if(!button) {if(current) {current=null;generation++;clearTimeout(timer);closeDialog();}return;}
    const id=Number(button.dataset.liveStockStart),signature=button.dataset.liveStockContext;
    if(current?.id===id && current.signature===signature) {paint();return;}
    closeDialog();clearTimeout(timer);current={id,signature,data:null,loading:true,starting:false,error:''};
    void load(current,++generation);
  }
  function closeDialog() {if(dialog) {dialog.close();dialog.remove();dialog=null;}}
  function productLabel(product) {return [product.name,product.sku,product.colour,product.size,product.pickupLocation].filter(Boolean).join(' · ');}
  function choices(products,selected) {
    return '<option value="">Skip / select a variant</option>'+products.map(product=>`<option value="${Number(product.id)}" ${product.id===selected?'selected':''} ${product.pickupNeedsReview?'disabled':''}>${esc(productLabel(product))}${product.pickupNeedsReview?' · Pickup review needed':''}</option>`).join('');
  }
  async function searchVariant(card,entry) {
    const search=card.querySelector('input').value,version=card.dataset.searchVersion=String(Number(card.dataset.searchVersion||0)+1);
    const data=await api('/products?'+new URLSearchParams({vendorId:entry.data.vendorId,search,limit:100}));
    if(current!==entry || !card.isConnected || card.dataset.searchVersion!==version) {return;}
    card.querySelector('select').innerHTML=choices(data.items,null);
    card.querySelector('[data-live-search-feedback]').textContent=data.total?data.total+' variants found.':'No variants found. Try the product name or SKU.';
  }
  function showDialog(entry,version) {
    closeDialog();dialog=document.createElement('dialog');dialog.className='stock-live-dialog';dialog.setAttribute('aria-labelledby','stockLiveDialogTitle');
    dialog.innerHTML=`<form><div class="stock-live-heading"><h2 id="stockLiveDialogTitle">Select Unilock variants</h2><button type="button" data-live-close aria-label="Close variant selection">Close</button></div><p>Choose the exact colour, size and pickup point. Leave a line blank to skip it.</p>${entry.data.lines.map(row=>{
      const products=row.product?[row.product,...row.candidates.filter(product=>product.id!==row.product.id)]:row.candidates;
      return `<fieldset data-live-variant="${row.lineId}"><legend>${esc([row.productName||row.referenceItemCode||'Description unavailable',row.color,row.size].filter(Boolean).join(' · '))}</legend>${row.aiMatch?`<p class="stock-live-match-note">${esc(row.aiMatch.reason)}</p>`:''}<div class="stock-live-search"><label>Search catalogue<input type="search" value="${esc(row.productName)}"></label><button type="button" data-live-search>Search</button></div><label>Exact vendor variant<select>${choices(products,row.product?.id)}</select></label><p data-live-search-feedback role="status"></p></fieldset>`;
    }).join('')}<p data-live-dialog-error role="alert"></p><div class="stock-live-dialog-actions"><button type="button" data-live-close>Cancel</button><button type="submit" class="primary">Check selected lines</button></div></form>`;
    document.body.append(dialog);
    const node=dialog;
    node.addEventListener('close',()=>{node.remove();if(dialog===node) {dialog=null;}mount.querySelector('[data-live-stock-start="'+entry.id+'"]')?.focus({preventScroll:true});});
    node.querySelectorAll('[data-live-close]').forEach(button=>{button.onclick=closeDialog;});
    node.querySelectorAll('[data-live-search]').forEach(button=>{button.onclick=()=>void searchVariant(button.closest('fieldset'),entry).catch(error=>{if(node.isConnected) {node.querySelector('[data-live-dialog-error]').textContent=error.message;}});});
    node.querySelector('form').onsubmit=event=>{
      event.preventDefault();
      const selected=[...node.querySelectorAll('[data-live-variant]')].map(card=>({lineId:Number(card.dataset.liveVariant),productId:Number(card.querySelector('select').value)})).filter(row=>row.productId);
      if(!selected.length) {node.querySelector('[data-live-dialog-error]').textContent='Select at least one exact vendor variant.';return;}
      closeDialog();void start(entry,version,selected);
    };
    node.showModal();
  }
  async function start(entry,version,selected) {
    if(!same(entry,version)) {return;}
    clearTimeout(timer);entry.read=(entry.read||0)+1;entry.starting=true;entry.error='';paint();
    try {
      const lines=selected.map(row=>({...row,fingerprint:entry.data.lines.find(line=>line.lineId===row.lineId).fingerprint}));
      const data=await api('/requests/'+entry.id,{lines});
      if(!same(entry,version)) {return;}
      entry.data=data;timer=setTimeout(()=>void load(entry,version),1000);
    } catch(error) {if(same(entry,version)) {entry.error=error.message;}}
    finally {if(same(entry,version)) {entry.starting=false;paint();}}
  }
  async function matchAmbiguous(entry,version) {
    if(!entry.data.lines.some(line=>!line.product)) {return true;}
    entry.matching=true;const read=entry.read=(entry.read||0)+1;paint();
    try {
      const data=await api('/requests/'+entry.id+'/match',{},AbortSignal.timeout(100000));
      if(!same(entry,version) || entry.read!==read) {return false;}
      entry.data=data;
    } catch(error) {
      if(!same(entry,version) || entry.read!==read) {return false;}
      if(error.status===409) {entry.error=error.message;return false;}
      entry.data.lines=entry.data.lines.map(line=>line.product?line:{...line,aiMatch:{status:'review',reason:'Ollama could not finish matching. Select a catalogue variant to continue.'}});
    } finally {if(same(entry,version)) {entry.matching=false;paint();}}
    return true;
  }
  mount.addEventListener('click',async event=>{
    const button=event.target.closest('[data-live-stock-start]');if(!button || !current || current.loading || current.matching || current.starting) {return;}
    const entry=current,version=generation;await load(entry,version);
    if(!same(entry,version) || !entry.data || entry.error || !await matchAmbiguous(entry,version)) {return;}
    if(!same(entry,version)) {return;}
    if(entry.data.lines.some(line=>!line.product || line.product.pickupNeedsReview)) {showDialog(entry,version);}
    else {await start(entry,version,entry.data.lines.map(line=>({lineId:line.lineId,productId:line.product.id})));}
  });
  new MutationObserver(()=>{if(!scheduled) {scheduled=true;queueMicrotask(sync);}}).observe(mount,{childList:true,subtree:true});
  window.addEventListener('pagehide',()=>{clearTimeout(timer);generation++;current=null;closeDialog();});
  window.SCMStockCheckLines={header,line};
  sync();
})();
