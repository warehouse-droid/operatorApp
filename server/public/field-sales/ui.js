export const $=(selector,root=document)=>root.querySelector(selector);
export const $$=(selector,root=document)=>[...root.querySelectorAll(selector)];
export const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const money=n=>new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD'}).format(Number(n||0)/100);
export const localTime=value=>value?new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',hour:'numeric',minute:'2-digit'}).format(new Date(value)):'';
export const dateTime=value=>value?new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'';
export const options=(list,selected)=>list.map(v=>{const [value,label]=Array.isArray(v)?v:[v,v];return `<option value="${escape(value)}" ${String(selected)===String(value)?'selected':''}>${escape(label)}</option>`;}).join('');
export const priority=value=>['Normal','Low','High','Urgent'][Number(value)||0];
export const badge=(label,type='')=>`<span class="badge ${type}">${escape(label)}</span>`;
export const empty=message=>`<div class="empty">${escape(message)}</div>`;
export function notify(message){const el=$('#notice');el.textContent=message;el.classList.add('show');clearTimeout(notify.timer);notify.timer=setTimeout(()=>el.classList.remove('show'),6500);}
export function on(selector,event,fn,root=document){$$(selector,root).forEach(el=>el.addEventListener(event,async e=>{try{await fn(e,el);}catch(error){notify(error.message);}}));}
export function modal(title,body,footer='') {
  const el=$('#dialog');if(el.open){el.close();}
  el.innerHTML=`<div class="dialog-head"><h2>${escape(title)}</h2><button class="quiet" data-close aria-label="Close dialog">✕</button></div><div class="dialog-body">${body}</div>${footer?`<div class="dialog-footer">${footer}</div>`:''}`;
  el.showModal();on('[data-close]','click',()=>el.close(),el);return el;
}
export function values(form){return Object.fromEntries(new FormData(form));}
export function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
export function safeUrl(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)?u.href:'#';}catch{return '#';}}
export function pageHead(title,description,actions=''){return `<div class="page-head"><div><h1>${escape(title)}</h1><p>${escape(description)}</p></div><div class="actions">${actions}</div></div>`;}
