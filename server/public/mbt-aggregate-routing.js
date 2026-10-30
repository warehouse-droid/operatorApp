export function aggregateRoutingUI({api}) {
  const escapeHtml=value=>String(value ?? '').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const panel=document.getElementById('aggregateRoutingPanel');
  if (!panel) {return {load:async()=>{}};}
  const form=panel.querySelector('form'),rows=panel.querySelector('tbody'),message=panel.querySelector('[role="status"]');
  let request=0;
  async function load() {
    const current=++request;message.textContent='Loading catalog items…';
    try {
      const data=await api(`/api/mbt/config/aggregate-routing?${new URLSearchParams({search:form.elements.search.value,limit:'100'})}`);
      if (request!==current) {return;}
      rows.innerHTML=data.items.map(item=>`<tr data-aggregate-item="${escapeHtml(item.itemId)}"><td>${escapeHtml(item.itemId)}</td>
        <td>${escapeHtml(item.name)}<br>${escapeHtml(item.displayName || '')}</td><td>${escapeHtml(item.unit || '')}</td><td>${item.active?'Active':'Inactive'}</td>
        <td>${item.binOnly?'BIN required':'BIN or flatbed'}</td><td>${item.affectedOrders.map(escapeHtml).join(', ') || 'No current orders'}</td>
        <td><button type="button" data-routing="${escapeHtml(item.itemId)}">${item.binOnly?'Allow flatbed':'Require BIN'}</button></td></tr>`).join('');
      message.textContent=`${data.items.length} catalog items. Routing changes apply to new assignments; existing trips remain available for review.`;
      for (const button of rows.querySelectorAll('[data-routing]')) {button.onclick=async()=>{
        const item=data.items.find(row=>row.itemId===button.dataset.routing);button.disabled=true;
        try {
          await api(`/api/mbt/config/aggregate-routing/${item.itemId}`,{method:'PUT',idempotencyKey:crypto.randomUUID(),
            body:{binOnly:!item.binOnly,expectedRevision:item.revision}});await load();
        } catch(error) {message.textContent=error.message;button.disabled=false;}
      };}
    } catch(error) {if (request===current) {message.textContent=error.message;}}
  }
  form.onsubmit=event=>{event.preventDefault();void load();};
  return {load};
}
