import { newId } from './identity.js';
import { $,escape,on,notify,modal,options,priority,badge,empty,pageHead,values } from './ui.js';
import { customerLinks } from './customers.js';
import { STAGES } from './domain.js';
import { openSite,editSite,newRoute,addToRoute } from './planner.js';

export async function render(ctx,view,page) {
  if(page==='followups'){return followups(ctx,view);}
  const data=await ctx.list('route');
  const mine=data.items.filter(r=>r.owner_id===ctx.state.operator.id||ctx.isAdmin());
  const selected=ctx.state.routeId||await ctx.state.workspace.get('selection:visit-route');
  let route=mine.some(r=>r.id===selected)?await ctx.load('route',selected):mine.find(r=>r.date===ctx.today())||mine[0];
  if(route){ctx.state.routeId=route.id;await ctx.state.workspace.put('selection:visit-route',route.id);}
  if(ctx.state.page&&ctx.state.page!==page){return;}
  view.innerHTML=pageHead('Out in the field','Flexible visits, saved notes, and the next conversation.','<button id="today-new-route">＋ Plan</button>')+`<div class="panel panel-pad"><label>Visit route<select id="visit-route">${options([['','Choose a route'],...mine.map(r=>[r.id,`${r.date} · ${r.name}`])],route?.id)}</select></label></div><div id="visit-content" style="margin-top:18px"></div>`;
  on('#today-new-route','click',()=>newRoute(ctx),view);on('#visit-route','change',async(e,b)=>{ctx.state.routeId=b.value;await render(ctx,view,'today');},view);
  if(!route){$('#visit-content').innerHTML=empty('Choose a route or plan a new one. You can add a jobsite while you are out.');return;}
  const editable=route.owner_id===ctx.state.operator.id||ctx.isAdmin(),stops=route.data.stops,done=stops.filter(s=>s.status==='completed').length,remaining=stops.filter(s=>!['completed','skipped'].includes(s.status)),next=remaining[0];
  $('#visit-content').innerHTML=`<div class="grid three metrics"><div class="panel metric"><small>Visited</small><strong>${done}<small> / ${stops.length}</small></strong></div><div class="panel metric"><small>Planned date</small><strong style="font-size:19px">${escape(route.date)}</strong></div><div class="panel metric"><small>To visit</small><strong>${remaining.length}</strong></div></div><div class="panel" style="margin-top:16px"><div class="panel-title"><div><h2>${escape(route.name)}</h2><small>${escape((route.data.areas||[]).join(' · '))}</small></div>${badge('Toronto time')}</div>${editable?'<div class="actions panel-pad"><button id="add-stop">＋ Add stop</button><button id="edit-plan">Edit plan</button></div>':''}${stops.map((s,i)=>visitStop(s,i,next,editable)).join('')||empty('No stops yet. Add an existing jobsite or one you discover on the road.')}</div><div class="banner" style="margin-top:16px">Your route stays open. Visit any stop or add another whenever you need. Notes, photos and quote drafts save on this device while offline.</div>`;
  const saveRoute=async p=>{route=(await ctx.save('route.save',p)).route;await render(ctx,view,'today');};
  on('#edit-plan','click',()=>{location.hash='prospects';},view);on('#add-stop','click',()=>pickStop(ctx,route,view),view);
  on('[data-site]','click',(e,b)=>openSite(ctx,b.dataset.site),view);
  on('[data-record]','click',async(e,b)=>{const current=await ctx.load('route',route.id),s=current.data.stops.find(candidate=>candidate.id===b.dataset.record);if(!s||s.status==='completed'){throw new Error('This stop already has a visit. Add another stop for a revisit.');}await recordVisit(ctx,await ctx.load('jobsite',s.jobsiteId),current,s);},view);
  on('[data-stop-quote]','click',async(e,b)=>{const s=route.data.stops.find(candidate=>candidate.id===b.dataset.stopQuote),site=await ctx.load('jobsite',s.jobsiteId),quotes=await import('./quotes.js');quotes.chooseJobsite(site);location.hash='quotes';},view);
  on('[data-edit]','click',async(e,b)=>editStop(ctx,await ctx.load('route',route.id),b.dataset.edit,saveRoute),view);
}
function visitStop(stop,index,next,editable) {
  const completed=stop.status==='completed',disabled=!editable||completed?'disabled':'';
  return `<article class="visit-stop ${completed?'completed':''}" data-stop="${stop.id}"><span class="badge ${stop.id===next?.id?'':'gray'}">${index+1}</span><div class="body"><div class="row"><h3><button class="stop-title" data-site="${stop.jobsiteId}">${escape(stop.name||stop.address)}</button></h3>${badge(stop.status==='planned'&&stop.id===next?.id?'Up next':stop.status,stop.id===next?.id?'':'gray')}</div><p>${escape(stop.address)} · ${stop.stayMinutes} min</p>${stop.note?`<p>${escape(stop.note)}</p>`:''}<div class="stop-actions"><button class="primary" data-record="${stop.id}" ${disabled}>Record Visit</button><button data-edit="${stop.id}" ${disabled}>Edit Stop</button><a class="button" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(stop.address)}&travelmode=driving" target="_blank" rel="noopener noreferrer">Navigate ↗</a><button data-stop-quote="${stop.id}">Quote</button></div>${completed?'<small>Visit recorded. Add another stop for a revisit.</small>':''}</div></article>`;
}
function editStop(ctx,route,id,saveRoute) {
  const p=structuredClone(ctx.routePayload(route)),s=p.stops.find(candidate=>candidate.id===id);
  if(!s||s.status==='completed'){throw new Error('Recorded visits stay in history. Add another stop for a revisit.');}
  const el=modal('Edit visit stop',`<form id="stop-edit" class="stack"><label>Visit address<input name="address" value="${escape(s.address)}" required></label><label>Visit time (minutes)<input name="stayMinutes" type="number" min="0" max="1440" value="${s.stayMinutes}" required></label><label>Stop note<textarea name="note">${escape(s.note)}</textarea></label></form><div class="actions stop-options"><button id="next-stop">Visit next</button><button id="skip-stop">${s.status==='skipped'?'Restore stop':'Skip stop'}</button><button id="remove-stop" class="danger">Remove stop</button></div>`,'<button data-close>Cancel</button><button form="stop-edit" class="primary">Save stop</button>');
  const save=async()=>{await saveRoute(p);el.close();};
  on('#stop-edit','submit',async(event,f)=>{event.preventDefault();const v=values(f);if(v.address!==s.address){s.latitude=null;s.longitude=null;}Object.assign(s,v,{stayMinutes:Number(v.stayMinutes)});await save();},el);
  on('#next-stop','click',async()=>{p.stops=p.stops.filter(stop=>stop.id!==s.id);s.status='planned';const i=p.stops.findIndex(stop=>!['completed','skipped'].includes(stop.status));p.stops.splice(i<0?p.stops.length:i,0,s);await save();},el);
  on('#skip-stop','click',async()=>{s.status=s.status==='skipped'?'planned':'skipped';await save();},el);
  on('#remove-stop','click',async()=>{p.stops=p.stops.filter(stop=>stop.id!==s.id);await save();},el);
}
async function pickStop(ctx,route,view) {
  const el=modal('Add a stop',`<form id="stop-search" class="field-row"><label>Find a jobsite<input name="search" placeholder="Address or project"></label><button>Search</button></form><div id="stop-results" class="catalog-results"></div>`,'<button id="manual-stop">＋ Add a new jobsite</button><button data-close>Close</button>');
  const append=async site=>{const p=ctx.routePayload(await ctx.load('route',route.id));p.stops.push({id:newId(),jobsiteId:site.id,name:site.name,address:site.address,latitude:site.latitude,longitude:site.longitude,stayMinutes:15,status:'planned'});await ctx.save('route.save',p);el.close();await render(ctx,view,'today');notify('Stop saved to the route.');};
  on('#manual-stop','click',()=>editSite(ctx,{},append),el);
  on('#stop-search','submit',async(event,f)=>{event.preventDefault();const term=values(f).search.toLowerCase();let items;try{items=(await ctx.list('jobsite',`/jobsites?source=all&search=${encodeURIComponent(term)}`)).items;}catch{items=(await ctx.state.workspace.records('jobsite:')).filter(s=>`${s.name} ${s.address}`.toLowerCase().includes(term));}$('#stop-results',el).innerHTML=items.map(s=>`<div class="catalog-item"><div><strong>${escape(s.name)}</strong>${escape(s.address)}</div><button data-pick="${s.id}" class="small">Add</button></div>`).join('')||empty('No matching cached jobsite. Add a new jobsite.');on('[data-pick]','click',(e,b)=>append(items.find(s=>s.id===b.dataset.pick)),el);},el);
}
async function imageBase64(file) {
  if(file.size>20*1024*1024){throw new Error('Choose a photo smaller than 20 MB.');}
  const bitmap=await createImageBitmap(file),scale=Math.min(1,2000/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
  return canvas.toDataURL('image/jpeg',.82).split(',')[1];
}
export async function recordVisit(ctx,site,route,stop) {
  const el=modal('Record a site visit',`<p style="margin-bottom:16px">${escape(stop?.address||site.address)}</p><form id="visit-form" class="stack"><section id="visit-customers" class="stack"></section><label>Visit result<select name="outcome" required><option value="">Choose an outcome</option>${options(ctx.state.settings.outcomes||ctx.state.status.outcomes)}</select></label><label>Notes<textarea name="note" placeholder="Who did you meet? What is the next step?"></textarea></label><label>Observed construction stage<select name="observedStage">${options(STAGES,site.observed_stage||'Unknown')}</select></label><label>Photos<input type="file" id="visit-photos" accept="image/*" capture="environment" multiple></label><small>Up to 30 photos. They stay on this device until uploaded.</small><div class="grid two"><label>Revisit on<input type="date" name="revisitDate" id="revisit-date"></label><label>Revisit priority<select name="revisitPriority">${options([[0,'Normal'],[1,'Low'],[2,'High'],[3,'Urgent']],0)}</select></label></div><div class="actions"><button type="button" id="two-weeks" class="small">In two weeks</button><button type="button" id="no-revisit" class="small">No follow-up</button></div><label>Follow-up note<textarea name="revisitNote" placeholder="Reason to come back"></textarea></label><small>Revisits go into the follow-up queue. Add them to a route when you are ready.</small></form><section id="visit-customer-editor" class="inline-customer-editor"></section>`,'<button data-close>Cancel</button><button id="visit-submit" form="visit-form" class="primary" disabled>Save visit</button>');
  on('#two-weeks','click',()=>{const date=new Date(ctx.today()+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+14);$('#revisit-date').value=date.toISOString().slice(0,10);},el);on('#no-revisit','click',()=>{$('#revisit-date').value='';},el);
  const contacts=await customerLinks(ctx,$('#visit-customers',el),$('#visit-customer-editor',el),site);
  on('#visit-form','submit',async(e,f)=>{
    e.preventDefault();const button=$('#visit-submit',el);button.disabled=true;
    try {
      if($('#customer-form',el)){throw new Error('Save or cancel the customer edit before saving this visit.');}
      const files=[...$('#visit-photos',el).files];if(files.length>30){throw new Error('A visit supports up to 30 photos.');}
      const id=newId(),photos=[];for(const file of files){photos.push({id:newId(),visitId:id,base64:await imageBase64(file)});}
      await ctx.save('visit.record',{...values(f),id,contacts:contacts.contacts(),jobsiteId:site.id,routeId:route?.id,stopId:stop?.id,occurredAt:new Date().toISOString()},photos);
      el.close();notify('Visit and photos saved on this device.');await ctx.render();
    }finally{button.disabled=false;}
  },el);
  $('#visit-submit',el).disabled=false;
}
async function followups(ctx,view) {
  let items;try{items=(await ctx.read('/followups')).items;}catch{items=[];}
  const queued=await ctx.state.workspace.pending();
  for(const e of queued){if(e.kind==='visit.record'&&e.payload.revisitDate){const p=e.payload,site=await ctx.load('jobsite',p.jobsiteId);if(!items.some(i=>i.visit_id===p.id)){items.push({id:p.followupId||p.id,visit_id:p.id,jobsite_id:site.id,date:p.revisitDate,name:site.name,address:site.address,priority:Number(p.revisitPriority),note:p.revisitNote||p.note});}}}
  items=items.filter(i=>!queued.some(e=>e.kind==='followup.complete'&&e.payload.id===i.id)).sort((a,b)=>a.date.localeCompare(b.date)||b.priority-a.priority);
  view.innerHTML=pageHead('Follow-up queue','Choose when to revisit, then add the jobsite to a dated route.')+`<div class="panel"><div class="panel-title"><h3>${items.length} open follow-ups</h3>${badge(`${items.filter(i=>i.date<=ctx.today()).length} due now`,'amber')}</div>${items.map(f=>`<article class="visit-stop"><span class="badge ${f.date<=ctx.today()?'amber':''}">${escape(f.date)}</span><div class="body"><div class="row"><h3>${escape(f.name)}</h3>${badge(priority(f.priority),f.priority>=2?'amber':'gray')}</div><p>${escape(f.address)}</p><p>${escape(f.note)}</p><div class="actions"><button class="small" data-site="${f.jobsite_id}">Jobsite</button><button class="primary small" data-plan="${f.id}">Add to route</button><button class="small" data-followup-done="${f.id}">Mark done</button></div></div></article>`).join('')||empty('No follow-ups yet. Set a revisit date when recording a visit.')}</div>`;
  on('[data-site]','click',(e,b)=>openSite(ctx,b.dataset.site),view);on('[data-followup-done]','click',async(e,b)=>{await ctx.save('followup.complete',{id:b.dataset.followupDone});await followups(ctx,view);},view);
  on('[data-plan]','click',async(e,b)=>{const f=items.find(i=>i.id===b.dataset.plan),routes=(await ctx.list('route')).items.filter(r=>r.owner_id===ctx.state.operator.id||ctx.isAdmin());const el=modal('Add follow-up to a route',`<p>${escape(f.address)}</p><label style="margin-top:16px">Route<select id="followup-route">${options([['','Create a new route'],...routes.map(r=>[r.id,`${r.date} · ${r.name}`])],ctx.state.routeId)}</select></label>`,'<button data-close>Cancel</button><button id="followup-add" class="primary">Add follow-up stop</button>');on('#followup-add','click',async()=>{ctx.state.routeId=$('#followup-route').value||null;el.close();await addToRoute(ctx,await ctx.load('jobsite',f.jobsite_id),f.id);notify('Follow-up added to visit plan.');},el);},view);
}
