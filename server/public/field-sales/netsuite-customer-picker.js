import {$$,escape} from './ui.js';

export function netSuiteCustomerFields(companies,customer){
 const groups=[...new Set(companies.map(c=>c==='MBBS'?'MBBS':'MBT_MBR'))];
 return `<section class="stack"><h3>Existing NetSuite customers</h3><p>Create customers in NetSuite, then link them here before creating Sales Orders. MBT and MBR use the same customer account.</p>${groups.map(group=>`<label data-netsuite-picker="${group}">${group==='MBBS'?'MBBS':'MBT / MBR'} NetSuite customer<input data-netsuite-search="${group}" list="confirm-ns-${group}" aria-describedby="confirm-ns-status-${group}" value="${escape(customer.netsuiteCustomers?.[group]||'')}" placeholder="Search name, customer number or ID" autocomplete="off" required><datalist id="confirm-ns-${group}"></datalist><small id="confirm-ns-status-${group}" role="status"></small></label>`).join('')}</section>`;
}

export function bindNetSuiteCustomerFields(ctx,root){
 const readers={};
 for(const input of $$('[data-netsuite-search]',root)){
  const group=input.dataset.netsuiteSearch,list=root.querySelector(`#confirm-ns-${group}`),status=root.querySelector(`#confirm-ns-status-${group}`),choices=new Map();
  let sequence=0,timer;
  const selected=()=>choices.get(input.value)||(/^[1-9]\d*$/.test(input.value.trim())?input.value.trim():'');
  const validate=()=>{const id=selected();input.setCustomValidity(id?'':'Choose an existing NetSuite customer from the suggestions or enter its internal ID.');return id;};
  const search=async(token,initial)=>{
   const term=input.value.trim(),data=await ctx.api(`/customers?search=${encodeURIComponent(term)}`);
   if(token!==sequence||!input.isConnected){return;}
   const rows=data.items.filter(c=>c.currency==='CAD');
   for(const c of rows){choices.set(`${c.display_name} · ${c.entity_number} (${c.id})`,String(c.id));}
   list.innerHTML=rows.map(c=>`<option value="${escape(`${c.display_name} · ${c.entity_number} (${c.id})`)}">${escape([c.email,c.phone].filter(Boolean).join(' · '))}</option>`).join('');
   if(initial){const c=rows.find(row=>String(row.id)===term);if(c){input.value=`${c.display_name} · ${c.entity_number} (${c.id})`;}}
   validate();status.textContent=rows.length?`${rows.length} matching NetSuite customers`:'No matching customer in the synced NetSuite directory.';
  };
  const schedule=(initial=false)=>{
   clearTimeout(timer);const token=++sequence;list.innerHTML='';validate();
   if(!input.value.trim()){status.textContent='Search the existing NetSuite customer directory.';return;}
   if(!initial&&choices.has(input.value)){status.textContent=`Selected customer ID ${selected()}`;return;}
   status.textContent='Searching NetSuite customers…';
   timer=setTimeout(()=>search(token,initial).catch(e=>{if(token===sequence&&input.isConnected){status.textContent=e.message;}}),180);
  };
  input.addEventListener('input',()=>schedule());readers[group]=validate;schedule(true);
 }
 return ()=>Object.fromEntries(Object.entries(readers).map(([group,read])=>[group,read()]));
}
