import { newId } from './identity.js';
import { $,escape,on,notify,modal,options,priority,badge,empty,pageHead,values,dateTime,safeUrl,localTime } from './ui.js';
import { STAGES,torontoWindow } from './domain.js';
import { WARDS,wardLabel,routeAdditions } from './planner-data.js';
import { PLANNING_MILESTONES,sourceEvidence,leadDateLabel,alignLeadFilters } from './lead-policy.js';
let filters={source:'recommended',recencyMonths:'12'},offset=0,selectedSite=null,map=null,mapScript=null,route=null;
let prospect=null,mapState=null,viewport=null;
const districts=['Etobicoke-York','North York','Scarborough','Toronto and East York'];
const priorities=[[0,'Normal'],[1,'Low'],[2,'High'],[3,'Urgent']];
const milestones=PLANNING_MILESTONES;
function sourceLabel(site){
  const lead=site.lead;
  return lead?[lead.category,lead.work,lead.milestone||lead.status,lead.needsReview?'Review work scope':null].filter(Boolean).join(' · '):site.manual?'Added by rep':site.milestone||'City source details available';
}
function filterContext(){
  const age=filters.source==='manual'?'Rep-added sites; City date filters do not apply':filters.recencyMonths==='all'?'All ages':`Last ${filters.recencyMonths||12} months of City records`;
  return [age,filters.source==='manual'?null:filters.includeMinor==='true'?'Includes minor/service work':'Construction work; minor/service work hidden',filters.milestone,filters.permitStatus,filters.category,filters.bounds?'Inside the visible map':null,filters.milestone==='Notice of Complete Application Issued'?'Complete submission — early planning, not approval':null].filter(Boolean).join(' · ');
}

export async function render(ctx,view,page) {
  if(page==='routes'){disposeMap();prospect=null;return renderRoutes(ctx,view);}
  await prospects(ctx,view);
}
async function prospects(ctx,view) {
  disposeMap();
  const [routes,facets]=await Promise.all([ctx.list('route'),ctx.read('/facets').catch(()=>({milestones:milestones,categories:[],permitStatuses:[]}))]);
  if(ctx.state.routeId){route=await ctx.load('route',ctx.state.routeId);}else {route=null;}
  view.innerHTML=pageHead('Find your next jobsite','Open Community Planning applications and active building permits across Toronto.','<button id="new-site">＋ Add jobsite</button><button id="new-route" class="primary">＋ Plan a route</button>')+
    `<form id="filters" class="panel filters"><label>Find an address or project<input name="search" placeholder="Street, project, builder…" value="${escape(filters.search)}"></label><label>Lead source<select name="source">${options([['recommended','Recommended'],['all','All jobsites'],['planning','Planning applications'],['permit','Active permits'],['manual','Added by reps']],filters.source)}</select></label><label>City district<select name="district">${options([['','All city districts'],...districts],filters.district)}</select></label><label>Ward<select name="ward">${options([['','All 25 wards'],...WARDS],filters.ward)}</select></label><label>Recency<select name="recencyMonths">${options([['6','Last 6 months'],['12','Last 12 months'],['24','Last 24 months'],['all','All ages']],filters.recencyMonths||'12')}</select><small>City record dates</small></label><details class="filter-more"><summary>More filters · postcode, milestones, priority, observations</summary><div class="grid four"><label>Postal areas (FSA)<input name="postal" value="${escape(filters.postal)}" placeholder="M9W, M9V"></label><label>Milestone<select name="milestone">${options([['','All milestones'],...(facets.milestones.length?facets.milestones:milestones)],filters.milestone)}</select></label><label>Minimum priority<select name="priority">${options([['','Any priority'],...priorities],filters.priority)}</select></label><label>Observed on site<select name="stage">${options([['','All observations'],...STAGES],filters.stage)}</select></label><label>Permit status<input name="permitStatus" list="permit-statuses" placeholder="e.g. Inspection" value="${escape(filters.permitStatus)}"></label><label>Application / permit category<input name="category" list="source-categories" value="${escape(filters.category)}" placeholder="e.g. Site Plan Approval"></label><label>Visit outcome<select name="outcome">${options([['','Any outcome'],...(ctx.state.settings.outcomes||ctx.state.status.outcomes)],filters.outcome)}</select></label><label>Follow-up due by<input type="date" name="revisitBefore" value="${escape(filters.revisitBefore)}"></label><label class="check"><input type="checkbox" name="includeMinor" ${filters.includeMinor==='true'?'checked':''}>Include minor/service work</label><label>Archived<select name="archived">${options([['','Active jobsites'],['true','Archived'],['all','Include archived']],filters.archived)}</select></label></div></details><div class="actions"><button class="primary small">Apply filters</button><button type="button" id="reset-filters" class="small">Reset</button></div></form>
    <datalist id="permit-statuses">${options(facets.permitStatuses)}</datalist><datalist id="source-categories">${options(facets.categories)}</datalist><p class="muted" style="font-size:12px;margin-bottom:14px">Recent permit issue dates and planning milestones help prioritize visits. Import dates are refresh times. An open or Inspection permit does not confirm work is happening now. Older records remain available under All ages.</p><div class="planner"><section class="panel" id="prospect-results" aria-busy="true"><div class="loading">Loading jobsites…</div></section><section class="panel map-panel"><div id="map" class="map"></div><div class="map-caption">Planning approval does not confirm a construction start.</div></section><aside id="route-box" class="panel route-box"></aside></div>
    <footer class="attribution">Source: City of Toronto Open Data · Community Planning + Open, all wards and districts. Refresh dates and original documents are available on each jobsite.</footer>`;
  prospect={element:$('#prospect-results'),version:0,selectionVersion:0,selected:new Map(),sites:{items:[],total:0},ready:false,selecting:false,adding:false};
  bindFilters(ctx);on('#new-site','click',()=>editSite(ctx));on('#new-route','click',()=>newRoute(ctx));
  await renderRouteBox(ctx,routes.items);
  const shown=prospect;
  void drawMap(ctx).catch(async error=>{
    if(!active(shown)||!$('#map')){return;}
    $('#map').innerHTML=`<div class="map-placeholder"><div><h3>Map unavailable</h3><p class="muted" style="font-size:12px;margin:10px 0">${escape(error.message)}</p><button id="retry-map" class="small">Load map</button></div></div>`;
    on('#retry-map','click',()=>drawMap(ctx));
    delete filters.bounds;await refreshProspects(ctx,true);
  });
}
function active(p){return prospect===p&&p.element.isConnected;}
function bindFilters(ctx) {
  const align=changed=>{
    const form=$('#filters'),next=alignLeadFilters(values(form),changed);
    for(const key of ['source','milestone','permitStatus','category']){form.elements.namedItem(key).value=next[key]||'';}
  };
  on('#filters [name=milestone]','change',()=>align('milestone'));
  on('#filters [name=permitStatus]','input',()=>align('permitStatus'));
  on('#filters [name=source]','change',()=>align('source'));
  on('#filters','submit',async(e,f)=>{
    e.preventDefault();const next=values(f);
    filters={...(filters.bounds?{bounds:filters.bounds}:{}),...Object.fromEntries(Object.entries(next).filter(([,v])=>v))};
    if(next.includeMinor){filters.includeMinor='true';}
    await refreshProspects(ctx,true);
  });
  on('#reset-filters','click',async()=>{
    filters={source:'recommended',recencyMonths:'12',...(filters.bounds?{bounds:filters.bounds}:{})};
    for(const input of $('#filters').elements){if(input.name){if(input.type==='checkbox'){input.checked=false;}else {input.value=filters[input.name]||'';}}}
    await refreshProspects(ctx,true);
  });
}
function selectionControls(p) {
  if(!active(p)){return;}
  const count=$('#selection-count',p.element);if(count){count.textContent=`${p.selected.size} selected`;}
  const all=$('#select-all',p.element);if(all){all.disabled=!p.ready||!p.sites.total||p.selecting||p.adding;all.textContent=p.selecting?'Selecting…':`Select all (${p.sites.total})`;}
  const add=$('#add-selected',p.element);if(add){add.disabled=!p.ready||!p.selected.size||p.selecting||p.adding;add.textContent=p.adding?'Adding…':'Add selected to route';}
  const clear=$('#clear-selection',p.element);if(clear){clear.disabled=!p.selected.size||p.selecting||p.adding;}
  for(const checkbox of p.element.querySelectorAll('[data-select-site]')){checkbox.checked=p.selected.has(checkbox.dataset.selectSite);checkbox.disabled=!p.ready||p.selecting||p.adding;}
}
function renderProspects(ctx,p) {
  if(!active(p)){return;}
  const sites=p.sites;
  p.element.innerHTML=`<div class="panel-title"><h3 id="prospect-count">${sites.total} potential jobsites</h3></div><div class="selection-tools"><small id="filter-context">${escape(filterContext())}</small><small>${filters.bounds?'Inside the map · updates as you move or zoom':'Matching your filters · map unavailable'}</small><div class="actions"><button id="select-all" class="small">Select all (${sites.total})</button><button id="clear-selection" class="small quiet">Clear</button></div><div class="actions"><span id="selection-count" aria-live="polite">${p.selected.size} selected</span><button id="add-selected" class="primary small">Add selected to route</button></div></div><div class="lead-list">${sites.items.map(site=>`<article class="lead ${site.id===selectedSite?'selected':''}"><div class="lead-heading"><input type="checkbox" data-select-site="${site.id}" aria-label="Select ${escape(site.address)}"><button class="lead-name" data-site="${site.id}"><h3>${escape(site.name||site.address)}</h3></button></div><small>${escape(site.address)}</small><div class="lead-meta"><span>${escape(site.district||'District unavailable')}</span><span>${escape(wardLabel(site))}</span><span>${escape(site.postal_prefix)}</span></div><small>${escape(sourceLabel(site))}</small>${site.lead?`<small class="lead-date">${escape(leadDateLabel(site.lead.dateKind))} ${escape(site.lead.date||'unavailable')}</small>`:''}<div class="lead-bottom"><span>${site.priority?badge(priority(site.priority),'amber'):badge(site.observed_stage||'Unknown','gray')}</span><button class="small" data-add="${site.id}">＋ Add to route</button></div></article>`).join('')||empty(filters.bounds?'No matching jobsites in this map area. Zoom out, choose All ages, include minor/service work or adjust the filters.':'No jobsites match these filters. Choose All ages, include minor/service work or adjust the filters.')}</div><div class="page-counter"><button class="small" id="prev" ${offset?'':'disabled'} aria-label="Previous page">←</button><span>${sites.items.length?offset+1:0}–${offset+sites.items.length} of ${sites.total}</span><button class="small" id="next" ${offset+50<sites.total?'':'disabled'} aria-label="Next page">→</button></div>`;
  on('[data-site]','click',(e,b)=>openSite(ctx,b.dataset.site),p.element);on('[data-add]','click',(e,b)=>addToRoute(ctx,sites.items.find(s=>s.id===b.dataset.add)),p.element);
  on('#prev','click',()=>{if(!p.ready){return;}offset=Math.max(0,offset-50);return refreshProspects(ctx);},p.element);on('#next','click',()=>{if(!p.ready){return;}offset+=50;return refreshProspects(ctx);},p.element);
  on('[data-select-site]','change',(e,b)=>{const site=sites.items.find(s=>s.id===b.dataset.selectSite);if(b.checked){p.selected.set(site.id,site);}else {p.selected.delete(site.id);}selectionControls(p);},p.element);
  on('#clear-selection','click',()=>{p.selected.clear();selectionControls(p);},p.element);
  on('#select-all','click',()=>selectAll(ctx,p),p.element);on('#add-selected','click',()=>addSelected(ctx,p),p.element);
  selectionControls(p);
}
async function refreshProspects(ctx,reset=false) {
  const p=prospect;if(!p||!active(p)){return;}
  if(reset){offset=0;p.selected.clear();p.selectionVersion++;p.selecting=false;}
  const version=++p.version,query=new URLSearchParams({...filters,offset:String(offset)});
  p.ready=false;p.element.setAttribute('aria-busy','true');selectionControls(p);
  void refreshMarkers(ctx).catch(error=>{if(active(p)&&version===p.version){notify(error.message);}});
  try {
    // Read the exact query: generic offline lists also include pending sites outside these bounds.
    const sites=await ctx.read(`/jobsites?${query}`);
    if(!active(p)||version!==p.version){return;}
    p.sites=sites;p.ready=true;renderProspects(ctx,p);
  }catch(error){
    if(!active(p)||version!==p.version){return;}
    p.sites={items:[],total:0};p.selected.clear();p.selectionVersion++;renderProspects(ctx,p);
    $('.lead-list',p.element).innerHTML=empty(`Unable to load jobsites for this area. ${escape(error.message)}<br><button id="retry-results" class="small">Retry</button>`);
    on('#retry-results','click',()=>refreshProspects(ctx),p.element);
  }finally {if(active(p)&&version===p.version){p.element.setAttribute('aria-busy','false');}}
}
async function selectAll(ctx,p) {
  if(!p.ready||p.selecting||p.adding){return;}
  if(p.sites.total>250){throw new Error('Select all supports up to 250 jobsites per route. Zoom in or narrow the filters, or select individual jobsites.');}
  const version=p.selectionVersion,query={...filters},selected=new Map(),total=p.sites.total;
  p.selecting=true;selectionControls(p);
  try {
    for(let start=0;start<total;start+=200){
      const data=await ctx.api(`/jobsites?${new URLSearchParams({...query,offset:String(start),limit:'200'})}`);
      if(!active(p)||version!==p.selectionVersion){return;}
      if(data.total!==total||data.items.length!==Math.min(200,total-start)){throw new Error('The jobsite list changed. Refresh this area and select again.');}
      for(const site of data.items){selected.set(site.id,site);}
    }
    if(selected.size!==total){throw new Error('The jobsite list changed. Refresh this area and select again.');}
    p.selected=selected;
  }finally {if(active(p)&&version===p.selectionVersion){p.selecting=false;selectionControls(p);}}
}
async function addSelected(ctx,p) {
  if(!p.ready||!p.selected.size||p.adding||p.selecting){return;}
  if(!ctx.state.routeId){throw new Error('Choose a route in Visit plan, or create a route first.');}
  const routeId=ctx.state.routeId,version=p.selectionVersion,sites=[...p.selected.values()];
  p.adding=true;selectionControls(p);
  try {
    const current=await ctx.load('route',routeId);
    if(!active(p)||version!==p.selectionVersion||routeId!==ctx.state.routeId){return;}
    if(current.owner_id!==ctx.state.operator.id&&!ctx.isAdmin()){throw new Error('Select one of your own routes to add these stops.');}
    const payload=collectRoute(ctx,current),additions=routeAdditions(payload.stops,sites);
    if(!additions.length){p.selected.clear();notify('The selected jobsites are already on this route.');return;}
    payload.stops.push(...additions.map(site=>stopFor(site)));
    const result=await ctx.save('route.save',payload);
    if(active(p)){p.selected.clear();if(ctx.state.routeId===routeId){route=result.route;await renderRouteBox(ctx);}}
    notify(`${additions.length} jobsites added to route.${sites.length>additions.length?' Jobsites already on the route were skipped.':''}`);
  }finally {p.adding=false;selectionControls(p);}
}
async function loadGoogle(ctx) {
  const auth=await ctx.api('/map-session',{sessionId:newId()});
  if(!auth.available){throw new Error('Maps is not available under the current map settings or usage budget. Routes and addresses can still be planned.');}
  if(window.google?.maps){return;}
  if(!mapScript){mapScript=new Promise((resolve,reject)=>{
    const script=document.createElement('script');window.fieldSalesMapReady=()=>{resolve();delete window.fieldSalesMapReady;};script.src=`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(auth.googleMapsApiKey)}&callback=fieldSalesMapReady&loading=async&v=weekly`;script.onerror=()=>{mapScript=null;reject(new Error('Map could not load. Check your connection.'));};document.head.append(script);
  });}
  await mapScript;
}
function disposeMap() {
  if(!mapState){return;}
  clearTimeout(mapState.timer);google.maps.event.clearInstanceListeners(mapState.map);
  mapState.markers.forEach(marker=>marker.setMap(null));mapState.line?.setMap(null);mapState=null;map=null;
}
async function drawMap(ctx,estimate) {
  const element=$('#map');if(!element){return;}
  if(!mapState||mapState.element!==element){
    await loadGoogle(ctx);if($('#map')!==element){return;}
    const bounds=filters.bounds?.split(',').map(Number);
    map=new google.maps.Map(element,{center:viewport?.center||(bounds?{lat:(bounds[1]+bounds[3])/2,lng:(bounds[0]+bounds[2])/2}:{lat:43.716,lng:-79.432}),zoom:viewport?.zoom||(bounds?13:11),mapTypeControl:false,streetViewControl:false,fullscreenControl:true,styles:[{featureType:'poi',stylers:[{visibility:'off'}]}]});
    const state=mapState={element,map,markers:[],generation:0,timer:null,line:null};
    const update=(delay=0)=>{
      if(mapState!==state||!element.isConnected){return;}
      const b=map.getBounds();if(!b){return;}
      const area=[b.getSouthWest().lng(),b.getSouthWest().lat(),b.getNorthEast().lng(),b.getNorthEast().lat()].join(',');
      viewport={center:map.getCenter(),zoom:map.getZoom()};
      if(filters.bounds!==area){
        filters={...filters,bounds:area};offset=0;
        // Invalidate before debouncing so an older response or selection cannot paint here.
        if(prospect){prospect.version++;prospect.selectionVersion++;prospect.ready=false;prospect.selecting=false;prospect.selected.clear();prospect.element.setAttribute('aria-busy','true');selectionControls(prospect);}
      }
      state.generation++;clearTimeout(state.timer);
      state.timer=setTimeout(()=>{if(mapState!==state||!element.isConnected){return;}if(prospect&&!prospect.ready){void refreshProspects(ctx);}else {void refreshMarkers(ctx).catch(error=>notify(error.message));}},delay);
    };
    map.addListener('idle',()=>update(200));
    update();if(!filters.bounds){await refreshProspects(ctx);}
  }
  if(estimate?.routePath?.length){mapState.line?.setMap(null);mapState.line=new google.maps.Polyline({map,path:estimate.routePath,strokeColor:'#174b39',strokeWeight:5});const b=new google.maps.LatLngBounds();estimate.routePath.forEach(p=>b.extend(p));map.fitBounds(b,35);}
}
async function refreshMarkers(ctx) {
  const state=mapState;if(!state||!state.element.isConnected){return;}
  const generation=++state.generation;
  const data=await ctx.read(`/map?${new URLSearchParams({...filters,zoom:String(state.map.getZoom())})}`);
  if(mapState!==state||generation!==state.generation||!state.element.isConnected){return;}
  state.markers.forEach(marker=>marker.setMap(null));state.markers=[];
  for(const pin of data.items){
    const marker=new google.maps.Marker({map:state.map,position:{lat:Number(pin.latitude),lng:Number(pin.longitude)},label:{text:pin.count>1?String(pin.count):'•',color:'#ffffff',fontSize:'11px'},title:pin.count>1?`${pin.count} jobsites`:pin.name,icon:{path:google.maps.SymbolPath.CIRCLE,scale:pin.count>1?17:10,fillColor:pin.priority>=2?'#9b622e':'#285e49',fillOpacity:1,strokeWeight:2,strokeColor:'#fff'}});
    marker.addListener('click',async()=>{try {
      if(pin.count===1){await openSite(ctx,pin.id);return;}
      if(state.map.getZoom()<17){state.map.setCenter(marker.getPosition());state.map.setZoom(state.map.getZoom()+2);return;}
      const lat=Number(pin.latitude),lng=Number(pin.longitude),nearby=[lng-.0002,lat-.0002,lng+.0002,lat+.0002].join(',');
      const result=await ctx.read(`/jobsites?${new URLSearchParams({...filters,bounds:nearby,limit:'200'})}`);
      const dialog=modal('Jobsites at this location',result.items.map(site=>`<div class="record"><button data-map-site="${site.id}">${escape(site.name)}</button><p>${escape(site.address)}</p></div>`).join(''));
      on('[data-map-site]','click',(e,button)=>openSite(ctx,button.dataset.mapSite),dialog);
    }catch(error){notify(error.message);}});state.markers.push(marker);
  }
}
export async function editSite(ctx,site={},afterSave) {
  const contact=site.contacts?.[0]||{};
  const el=modal(site.id?'Edit jobsite':'Add a jobsite',`<form id="site-form" class="stack"><label>Jobsite name<input name="name" value="${escape(site.name)}" placeholder="Project or address" required></label><label>Street address<input name="address" value="${escape(site.address)}" placeholder="e.g. 90 Belfield Road, Toronto" required></label><div class="grid three"><label>City district<select name="district">${options([['','Select district'],...districts],site.district)}</select></label><label>Ward<select name="ward">${options([['','Select ward'],...WARDS],String(site.ward||'').padStart(2,'0'))}</select></label><label>Postal area<input name="postalPrefix" value="${escape(site.postal_prefix)}" placeholder="M9W" maxlength="3"></label></div><div class="grid two"><label>Priority<select name="priority">${options(priorities,site.priority)}</select></label><label>Observed construction<select name="observedStage">${options(STAGES,site.observed_stage||'Unknown')}</select></label></div><details><summary>Map coordinates</summary><p class="muted" style="font-size:12px;margin:10px 0">Use Locate address to look up this jobsite. Coordinates are optional.</p><div class="field-row"><label>Latitude<input name="latitude" value="${escape(site.latitude)}" type="number" step="any"></label><label>Longitude<input name="longitude" value="${escape(site.longitude)}" type="number" step="any"></label><button type="button" id="locate-site">Locate address</button><button type="button" id="gps-site">Use GPS</button></div></details><h3>Site contact</h3><div class="grid two"><label>Name<input name="contactName" value="${escape(contact.name)}"></label><label>Company<input name="contactCompany" value="${escape(contact.company)}"></label><label>Phone<input name="phone" type="tel" value="${escape(contact.phone)}"></label><label>Email<input name="email" type="email" value="${escape(contact.email)}"></label></div>${site.id?`<label class="check"><input type="checkbox" name="archived" ${site.archived?'checked':''}>Archive jobsite</label>`:''}</form>`,'<button data-close>Cancel</button><button class="primary" form="site-form">Save jobsite</button>');
  on('#site-form [name=address]','input',()=>{$('[name=latitude]',el).value='';$('[name=longitude]',el).value='';},el);
  on('#locate-site','click',async()=>{const p=await ctx.api('/locate',{address:$('[name=address]',el).value});$('[name=latitude]',el).value=p.latitude??p.lat;$('[name=longitude]',el).value=p.longitude??p.lng;},el);
  on('#gps-site','click',()=>new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(p=>{$('[name=latitude]',el).value=p.coords.latitude;$('[name=longitude]',el).value=p.coords.longitude;resolve();},reject,{enableHighAccuracy:true,timeout:15000})),el);
  on('#site-form','submit',async(e,f)=>{e.preventDefault();const v=values(f),payload={...site,...v,id:site.id||newId(),priority:Number(v.priority),archived:Boolean(v.archived),contacts:[{...contact,name:v.contactName,company:v.contactCompany,phone:v.phone,email:v.email},...(site.contacts||[]).slice(1)]};const result=await ctx.save('jobsite.save',payload);el.close();notify('Jobsite saved on this device.');if(afterSave){await afterSave(result.jobsite);}else {await ctx.render();}return result;},el);
}
export async function openSite(ctx,id) {
  selectedSite=id;const site=await ctx.load('jobsite',id),sources=site.sources||[];
  const sourceHtml=s=>`<div class="record"><strong>${escape(s.data.applicationNumber||s.data.raw?.PERMIT_NUM||s.source)}</strong><p>${escape(s.data.address)}</p><p>${escape(s.data.category)} · ${escape(s.data.status)}</p><p>${escape(s.data.milestone||'')}</p><small>${escape(leadDateLabel(sourceEvidence(s.source,s.data).dateKind))} ${escape(sourceEvidence(s.source,s.data).date||'unavailable')} · Last imported ${escape(dateTime(s.last_seen_at))}${s.present?'':' · No longer in latest feed'}</small><p>${escape(s.data.description)}</p><a href="${escape(safeUrl(s.data.sourceUrl))}" target="_blank" rel="noopener noreferrer">Open original City record ↗</a></div>`;
  const el=modal(site.name,`<div class="detail-layout"><div class="stack"><div><p>${escape(site.address)}</p><small>${escape([site.district,wardLabel(site),site.postal_prefix].filter(Boolean).join(' · '))}</small></div><div class="actions">${badge(priority(site.priority),'amber')}${badge(site.observed_stage||'Unknown')}</div><div class="actions"><button id="site-edit">Edit details</button><button id="site-visit">Record visit</button><button id="site-quote">New quote</button></div><h3>Customers</h3>${(site.customers||[]).map(c=>`<div class="record"><strong>${escape(c.name)}${c.archived?' · Archived':''}</strong><small>${escape((c.types||[]).map(t=>t.name).join(' · '))}</small>${(c.representatives||[]).filter(r=>!r.archived).map(r=>`<p>${escape(r.name)} · ${escape(r.phone)} · ${escape(r.email)}</p>`).join('')}</div>`).join('')||'<small>No linked customers yet. Add a customer when recording a visit.</small>'}<h3>Site contact</h3>${(site.contacts||[]).map(c=>`<div class="record"><strong>${escape(c.name)} ${escape(c.company)}</strong><p>${escape(c.phone)} · ${escape(c.email)}</p></div>`).join('')||'<small>No contact yet.</small>'}<h3>Notes</h3><form id="note-form" class="stack"><textarea name="body" placeholder="Who to contact, access instructions, next opportunity…" required aria-label="Jobsite note"></textarea><button class="primary">Add note</button></form>${(site.notes||[]).map(n=>`<div class="record"><p>${escape(n.body)}</p><small>${escape(dateTime(n.created_at))}</small></div>`).join('')}<h3>Visit history</h3>${(site.visits||[]).map(v=>`<div class="record"><strong>${escape(v.outcome)} · ${escape(dateTime(v.occurred_at))}</strong><p>${escape(v.note)}</p>${(v.data?.contacts||[]).map(c=>`<p><strong>${escape(c.name)}</strong>${c.representatives?.length?` · ${c.representatives.map(r=>escape([r.name,r.phone,r.email].filter(Boolean).join(' · '))).join('; ')}`:''}</p>`).join('')}<small>${escape(v.observed_stage)}</small><div class="photos">${(v.photos||[]).map(p=>`<button class="small" data-photo="${p.id}">View photo</button>`).join('')}</div></div>`).join('')||'<small>No visits yet.</small>'}<h3>Quotes</h3>${(site.quotes||[]).map(q=>`<button data-quote="${q.id}">FS-${q.company?escape(q.company)+'-':''}${String(q.quote_number).padStart(6,'0')} · Revision ${q.revision}</button>`).join('')||'<small>No quotes yet.</small>'}</div><div><h3>City records</h3>${sources.map((source,index)=>sourceHtml(source)+(source.source==='planning'&&source.data.address!==site.address?`<button class="small" data-source-stop="${index}">Add this address to route</button>`:'')).join('')||'<p class="muted">Manually added jobsite.</p>'}${site.addressEvidence?.length?`<hr class="divider"><h3>Permits at a matching address</h3><div class="banner warning">An address match does not verify that this permit belongs to this project. Check its date and description.</div>${site.addressEvidence.map(sourceHtml).join('')}`:''}${site.duplicates?.length?`<hr class="divider"><h3>Possible related records</h3><p class="muted" style="font-size:12px">Different applications at one address can be separate projects. Merge only after reviewing.</p>${site.duplicates.map(d=>`<div class="record"><a href="#" data-related="${d.id}">${escape(d.name)}</a><button class="small" data-merge="${d.id}">Merge into this site</button></div>`).join('')}`:''}</div></div>`,'<button data-close>Close</button><button class="primary" id="site-add-route">Add to route</button>');
  on('[data-source-stop]','click',async(e,button)=>{const source=sources[Number(button.dataset.sourceStop)].data;el.close();await addToRoute(ctx,{...site,address:source.address,latitude:source.latitude??null,longitude:source.longitude??null});},el);
  on('#site-edit','click',()=>editSite(ctx,site),el);on('#site-add-route','click',async()=>{el.close();await addToRoute(ctx,site);},el);
  on('#note-form','submit',async(e,f)=>{e.preventDefault();await ctx.save('note.add',{id:newId(),jobsiteId:site.id,body:values(f).body});await openSite(ctx,site.id);},el);
  on('#site-visit','click',async()=>{const m=await import('./visiting.js');await m.recordVisit(ctx,site);},el);
  on('#site-quote','click',async()=>{const m=await import('./quotes.js');m.chooseJobsite(site);el.close();location.hash='quotes';},el);
  on('[data-quote]','click',async(e,b)=>{el.close();const m=await import('./quotes.js');m.chooseQuote(b.dataset.quote);location.hash='quotes';},el);
  on('[data-related]','click',(e,b)=>{e.preventDefault();return openSite(ctx,b.dataset.related);},el);
  on('[data-merge]','click',(e,b)=>{const d=modal('Merge jobsite records',`<p>Move the selected record’s notes, visits, sources, follow-ups and quotes into <strong>${escape(site.name)}</strong>. Historical quote PDFs retain their original revision.</p>`,'<button data-close>Cancel</button><button id="merge-confirm" class="primary">Merge records</button>');on('#merge-confirm','click',async()=>{await ctx.api('/commands',{id:newId(),kind:'jobsite.merge',payload:{fromId:b.dataset.merge,toId:site.id}});await openSite(ctx,site.id);},d);},el);
  on('[data-photo]','click',async(e,b)=>{const blob=await ctx.api(`/photos/${b.dataset.photo}`),url=URL.createObjectURL(blob);const d=modal('Visit photo',`<img src="${url}" alt="Jobsite visit" style="max-width:100%">`);d.addEventListener('close',()=>URL.revokeObjectURL(url),{once:true});},el);
}
export async function newRoute(ctx,site,followupId) {
  const reps=ctx.isAdmin()?await ctx.read('/reps'):{items:[]};
  const el=modal('Plan a visit route',`<form id="new-route-form" class="stack"><label>Route name<input name="name" placeholder="Etobicoke North · afternoon" required></label><div class="grid two"><label>Date<input type="date" name="date" value="${ctx.today()}" required></label><label>Time of day<select name="period">${options([['afternoon','Afternoon · 1–5 pm'],['morning','Morning · 9 am–noon'],['day','Full day · 9 am–5 pm'],['custom','Custom hours']],'afternoon')}</select></label><label>Custom start<input type="time" name="startTime" value="13:00"></label><label>Custom end<input type="time" name="endTime" value="17:00"></label></div><label>Areas to visit<input name="areas" placeholder="Etobicoke North, M9W, M9V"></label>${ctx.isAdmin()?`<label>Assigned rep<select name="ownerId">${options(reps.items.map(r=>[r.id,r.display_name]),ctx.state.operator.id)}</select></label>`:''}<small>Times use Toronto time. You can plan multiple routes and multiple areas per day.</small></form>`,'<button data-close>Cancel</button><button class="primary" form="new-route-form">Create route</button>');
  on('#new-route-form','submit',async(e,f)=>{e.preventDefault();const p=values(f);const result=await ctx.save('route.save',{...p,id:newId(),areas:p.areas.split(',').map(v=>v.trim()).filter(Boolean),stops:site?[stopFor(site,followupId)]:[]});route=result.route;ctx.state.routeId=route.id;el.close();if(location.hash!=='#prospects'){location.hash='prospects';}else {await ctx.render();}},el);
}
const stopFor=(site,followupId)=>({id:newId(),jobsiteId:site.id,name:site.name,address:site.address,latitude:site.latitude,longitude:site.longitude,status:'planned',stayMinutes:15,...(followupId?{followupId}:{})});
export async function addToRoute(ctx,site,followupId) {
  if(!ctx.state.routeId){return newRoute(ctx,site,followupId);}
  const current=await ctx.load('route',ctx.state.routeId);
  if(current.owner_id!==ctx.state.operator.id&&!ctx.isAdmin()){throw new Error('Select one of your own routes to add this stop.');}
  const p=route?.id===current.id?collectRoute(ctx,current):ctx.routePayload(current);p.stops.push(stopFor(site,followupId));
  route=(await ctx.save('route.save',p)).route;notify('Jobsite added to route.');if($('#route-box')){await renderRouteBox(ctx);}return route;
}
function collectRoute(ctx,current) {
  const p=ctx.routePayload(current),form=$('#route-edit');if(!form){return p;}
  const v=values(form);return {...p,...v,areas:v.areas.split(',').map(a=>a.trim()).filter(Boolean),origin:v.origin?{address:v.origin}:null,end:v.end?{address:v.end}:null,allowTolls:Boolean(v.allowTolls)};
}
async function renderRouteBox(ctx,savedRoutes) {
  const box=$('#route-box');if(!box){return;}
  const routes=savedRoutes||(await ctx.list('route')).items;
  if(ctx.state.routeId){route=await ctx.load('route',ctx.state.routeId);}
  const mine=routes.filter(r=>r.owner_id===ctx.state.operator.id||ctx.isAdmin());
  box.innerHTML=`<div class="panel-title"><h3>Visit plan</h3><button class="quiet small" id="builder-new">＋ New</button></div><div class="route-fields"><label>Selected route<select id="route-select">${options([['','Choose a route'],...mine.map(r=>[r.id,`${r.date} · ${r.name}`])],route?.id)}</select></label>${route?`<form id="route-edit" class="stack"><label>Route name<input name="name" value="${escape(route.name)}" required></label><div class="grid two"><label>Date<input type="date" name="date" value="${escape(route.date)}" required></label><label>Time<select name="period">${options([['morning','Morning'],['afternoon','Afternoon'],['day','Full day'],['custom','Custom']],route.data.period)}</select></label></div><div class="grid two"><label>Start<input type="time" name="startTime" value="${route.data.startTime||'13:00'}"></label><label>End<input type="time" name="endTime" value="${route.data.endTime||'17:00'}"></label></div><label>Areas<input name="areas" value="${escape((route.data.areas||[]).join(', '))}"></label><label>Start from (optional)<input name="origin" placeholder="Office, home or current address" value="${escape(route.data.origin?.address)}"></label><label>Finish at (optional)<input name="end" placeholder="Leave empty to finish at last stop" value="${escape(route.data.end?.address)}"></label><label class="check"><input type="checkbox" name="allowTolls" ${route.data.allowTolls?'checked':''}>Allow toll roads</label><button class="small" type="submit">Save plan details</button></form><div class="route-stops"><div class="row"><h3>${route.data.stops.length} stops</h3><small>Visit time per stop</small></div>${route.data.stops.map((s,i)=>`<div class="stop" draggable="${s.status!=='completed'}" data-drag="${i}"><span class="num">${i+1}</span><div><h3>${escape(s.address)}</h3><small>${escape(s.status)}</small><div class="stop-tools">${s.status!=='completed'?`<button class="small" data-move="${i}" data-dir="-1" aria-label="Move stop up">↑</button><button class="small" data-move="${i}" data-dir="1" aria-label="Move stop down">↓</button><input aria-label="Minutes at ${escape(s.address)}" type="number" min="0" max="1440" data-stay="${i}" value="${s.stayMinutes}"><small>min</small><button class="small quiet danger" data-remove="${i}" aria-label="Remove stop">✕</button>`:''}</div></div></div>`).join('')||empty('Add jobsites from the list to build this route.')}</div><div class="actions"><button id="suggest" class="small">Suggest order</button><button id="estimate" class="primary small">Estimate road time</button></div><div id="estimate-result"></div><a class="button" href="#today">Open visiting view →</a>`:empty('Choose a saved route or create a dated visit plan.')}</div>`;
  on('#builder-new','click',()=>newRoute(ctx),box);
  on('#route-select','change',async(e,b)=>{ctx.state.routeId=b.value||null;route=null;await renderRouteBox(ctx);},box);
  if(!route){return;}
  const persist=async p=>{route=(await ctx.save('route.save',p)).route;await renderRouteBox(ctx);};
  on('#route-edit','submit',async e=>{e.preventDefault();await persist(collectRoute(ctx,route));notify('Plan saved.');},box);
  on('[data-move]','click',async(e,b)=>{const p=collectRoute(ctx,route),i=Number(b.dataset.move),j=i+Number(b.dataset.dir);if(j<0||j>=p.stops.length||p.stops[j].status==='completed'){return;}[p.stops[i],p.stops[j]]=[p.stops[j],p.stops[i]];await persist(p);},box);
  on('[data-remove]','click',async(e,b)=>{const p=collectRoute(ctx,route);p.stops.splice(Number(b.dataset.remove),1);await persist(p);},box);
  on('[data-stay]','change',async(e,b)=>{const p=collectRoute(ctx,route);p.stops[Number(b.dataset.stay)].stayMinutes=Number(b.value);await persist(p);},box);
  let dragged;on('[data-drag]','dragstart',(e,b)=>{dragged=Number(b.dataset.drag);},box);on('[data-drag]','dragover',e=>e.preventDefault(),box);on('[data-drag]','drop',async(e,b)=>{e.preventDefault();const i=Number(b.dataset.drag),p=collectRoute(ctx,route);if(dragged==null||p.stops[dragged].status==='completed'||p.stops[i].status==='completed'){return;}const [s]=p.stops.splice(dragged,1);p.stops.splice(i,0,s);await persist(p);},box);
  on('#estimate','click',async()=>{const p=collectRoute(ctx,route),data={...p,...torontoWindow(p.date,p.period,p.startTime,p.endTime),end:p.end};const estimate=await ctx.api('/route-estimate',data);$('#estimate-result').innerHTML=estimate.available?`<div class="estimate"><strong>${Math.floor(estimate.totalMinutes/60)}h ${Math.round(estimate.totalMinutes%60)}m</strong><p>${estimate.driveMinutes} min driving + ${estimate.stayMinutes} min visiting</p><p>Finish around ${escape(localTime(estimate.finish))}</p><small>${p.origin?'Includes start location':'Starts at first stop'} · ${p.end?'Includes finish location':'Ends at last stop'}<br>${escape(estimate.message)}</small>${estimate.arrivals.map(a=>`<p>${escape(localTime(a.at))} · ${escape(p.stops.find(s=>s.id===a.stopId)?.address)}</p>`).join('')}</div>`:`<div class="banner warning">${escape(estimate.message)} ${estimate.stayMinutes} min visiting.</div>`;if(estimate.available&&$('#map')){await drawMap(ctx,estimate);}},box);
  on('#suggest','click',async()=>{const p=collectRoute(ctx,route);let origin=p.origin;if(origin?.latitude==null&&origin?.address){origin=await ctx.api('/locate',{address:origin.address});}origin||=p.stops.find(s=>s.latitude!=null);const proposal=await ctx.api('/route-order',{stops:p.stops,origin});const el=modal('Suggested visit order',`<div class="banner">${escape(proposal.method)} Your saved order changes only when you apply this suggestion.</div><ol>${proposal.stops.map(s=>`<li style="margin:12px 0">${escape(s.address)}</li>`).join('')}</ol>`,'<button data-close>Keep current order</button><button id="apply-order" class="primary">Apply suggested order</button>');on('#apply-order','click',async()=>{p.stops=proposal.stops;await persist(p);el.close();notify('Suggested order applied.');},el);},box);
}
async function renderRoutes(ctx,view) {
  const date=new URLSearchParams(location.hash.split('?')[1]||'').get('date')||'';
  const data=await ctx.list('route',`/routes${date?'?date='+date:''}`);
  view.innerHTML=pageHead('Visit plans','Arrange several areas, afternoons, and routes ahead of time.','<button id="new-route" class="primary">＋ Plan a route</button>')+`<div class="actions" style="margin-bottom:18px"><label>Plan date<input type="date" id="route-date" value="${escape(date)}"></label><button id="all-dates">All dates</button></div><div class="grid three">${data.items.filter(r=>!date||r.date===date).map(r=>`<article class="panel route-card"><div class="row"><span class="eyebrow">${escape(r.date)} · ${escape(r.data.period)}</span>${badge(r.status)}</div><h2>${escape(r.name)}</h2><p class="muted" style="font-size:12px">${escape((r.data.areas||[]).join(' · '))}</p><div class="row"><span class="number">${r.data.stops.length}<small> stops</small></span><small>${escape(r.owner_name||'Assigned rep')}</small></div><div class="actions"><button class="small" data-plan="${r.id}">Open plan</button><button class="primary small" data-visit-route="${r.id}">Visit route</button>${ctx.isAdmin()?`<button class="small" data-reassign="${r.id}">Reassign</button>`:''}</div></article>`).join('')||empty('No visit plans yet. Create a morning or afternoon route.')}</div>`;
  on('#new-route','click',()=>newRoute(ctx),view);on('#route-date','change',(e,b)=>{location.hash=`routes?date=${b.value}`;},view);on('#all-dates','click',()=>{location.hash='routes';},view);
  on('[data-plan]','click',(e,b)=>{ctx.state.routeId=b.dataset.plan;location.hash='prospects';},view);on('[data-visit-route]','click',(e,b)=>{ctx.state.routeId=b.dataset.visitRoute;location.hash='today';},view);
  on('[data-reassign]','click',async(e,b)=>{const r=await ctx.load('route',b.dataset.reassign),reps=await ctx.read('/reps');const el=modal('Reassign route',`<label>Assigned rep<select id="assign-rep">${options(reps.items.map(p=>[p.id,p.display_name]),r.owner_id)}</select></label>`,'<button data-close>Cancel</button><button id="apply-reassign" class="primary">Reassign</button>');on('#apply-reassign','click',async()=>{await ctx.save('route.save',{...ctx.routePayload(r),ownerId:$('#assign-rep').value});el.close();await ctx.render();},el);},view);
}
