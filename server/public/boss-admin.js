const app=document.getElementById('bossAdmin');
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let snapshot,accounts=[];
async function api(path,options={}){
 const token=localStorage.getItem('mbbs.staff.token')||localStorage.getItem('mbbs.control.token');
 const res=await fetch(path,{...options,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},cache:'no-store'});
 const data=await res.json();if(!res.ok){throw new Error(data.error||'Unable to load setup.');}return data;
}
async function load(message=''){
 try{
  [snapshot,accounts]=await Promise.all([api('/api/admin/boss-approvals'),api('/api/operators')]);
  const selectable=accounts.filter(account=>account.active&&account.roles.includes('boss'));
  app.innerHTML=`<header class="boss-header"><div><p class="eyebrow">MBBS · ADMIN</p><h1>BOSS approval setup</h1><a href="/admin/accounts">← Accounts</a></div></header>
  ${message?`<p class="message" role="status">${escape(message)}</p>`:''}
  <form id="setupForm">${snapshot.principals.map(p=>`<section class="boss-card" data-principal="${p.key}"><h2>${escape(p.name)}</h2><label class="form-field"><span>Active BOSS account</span><select name="${p.key}-account"><option value="">Select account</option>${selectable.map(account=>`<option value="${escape(account.id)}" ${account.id===p.operatorId?'selected':''}>${escape(account.display_name||account.username)} · ${escape(account.email||'email missing')}</option>`).join('')}</select></label><label class="form-field"><span>NetSuite Sales Owner list ID</span><input name="${p.key}-owner" type="number" min="1" step="1" value="${escape(p.ownerId||'')}"></label><p class="subtle">Use the verified internal ID for ${escape(p.name)} in the customer Sales Owner list.</p></section>`).join('')}
  <section class="boss-card"><h2>Approval requests</h2><label class="check"><input name="enabled" type="checkbox" ${snapshot.settings.enabled?'checked':''}> Enable BOSS approvals</label><p class="subtle">All three accounts need the BOSS authority, an email address and their verified Sales Owner ID. Other or missing Sales Owners route to all three. Any one decision completes a shared request.</p><button class="primary" type="submit">Save setup</button><p id="setupError" class="message error" hidden></p></section></form>
  <section class="boss-card"><h2>Email delivery</h2><p><strong>${escape(snapshot.mail.senderName)}</strong><br>${escape(snapshot.mail.senderAddress)}</p><p class="message">${snapshot.mail.configured?'SMTP credentials are configured.':'SMTP credentials are not configured. Emails remain queued until the server mail settings are added.'}</p><p class="subtle">Set the sending account credentials securely on the server. Recipient email addresses are managed in <a href="/admin/accounts">Accounts</a>.</p>${snapshot.health.emails.map(row=>`<p>${escape(row.email_status)}: ${row.count}</p>`).join('')}</section>
  <section class="boss-card"><h2>Refresh status</h2><p class="subtle">Sales orders enter this queue after a successful delayed NetSuite status refresh. The first check is eligible after 10 seconds. Pending or failed checks use the existing retry schedule: 30 seconds, 2 minutes, 10 minutes, 30 minutes, 2 hours, 6 hours and 12 hours.</p>${snapshot.health.sources.map(row=>`<p class="message error">${row.count} source(s): ${escape(row.last_error)}</p>`).join('')}${snapshot.health.decisions.map(row=>`<p>${escape(row.status)} decisions: ${row.count}</p>`).join('')}</section>`;
 }catch(error){app.innerHTML=`<p class="message error">${escape(error.message)}</p><a href="/admin/accounts">Accounts</a>`;}
}
app.addEventListener('submit',async event=>{
 if(event.target.id!=='setupForm'){return;}event.preventDefault();const form=event.target,data=new FormData(form),button=form.querySelector('button[type="submit"]');button.disabled=true;
 try{
  await api('/api/admin/boss-approvals',{method:'PUT',body:JSON.stringify({revision:snapshot.settings.revision,enabled:data.has('enabled'),principals:snapshot.principals.map(p=>({key:p.key,operatorId:data.get(p.key+'-account')||null,ownerId:data.get(p.key+'-owner')||null}))})});
  await load('BOSS approval setup saved.');
 }catch(error){const target=form.querySelector('#setupError');target.textContent=error.message;target.hidden=false;button.disabled=false;}
});
window.requireDispatchLogin({mount:app,roles:['admin'],allowPublicSales:false,onReady:()=>load()});
