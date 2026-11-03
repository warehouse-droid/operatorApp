import {messages} from './messages.js?v=20261030-repair-language';
const browser=typeof document!=='undefined'&&typeof document.createElement==='function';
// Carry the active PWA language across navigation/storage contexts once, then let
// the shared preference govern later switches and reloads.
if(browser){
 const url=new URL(location.href),incoming=url.searchParams.get('language');
 if(['en','zh-CN'].includes(incoming)){
  if(window.MBBS_I18N?.setLanguage)window.MBBS_I18N.setLanguage(incoming);else localStorage.setItem('mbbs.ui.language',incoming);
  document.documentElement.lang=incoming;url.searchParams.delete('language');history.replaceState(history.state,'',url.pathname+url.search+url.hash);
 }
}
const marker=Symbol('repair-ui'),key='mbbs.ui.language',attributes=['placeholder','title','aria-label','alt'];
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
// Mark only interface copy. Ordinary interpolations are opaque record data, even when
// they happen to equal an English label such as "Parts" or "Normal".
class UiText extends String{constructor(value){super(String(value??''));this[marker]=true;}toJSON(){return String(this);}}
export const ui=value=>browser&&String(value??'')?value?.[marker]?value:new UiText(value):String(value??'');
export const isUi=value=>Boolean(value?.[marker]);
export const language=()=>browser?(window.MBBS_I18N?.language()||localStorage.getItem(key)||'en'):'en';
const normalize=value=>String(value??'').replace(/\s+/gu,' ').trim();
const regexEscape=value=>value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
const patterns=Object.entries(messages).filter(([source])=>/\{\d+\}/u.test(source)).map(([source,target])=>({source,target,slots:[...source.matchAll(/\{(\d+)\}/gu)].map(match=>match[1]),pattern:new RegExp('^'+source.split(/(\{\d+\})/u).map(part=>/^\{\d+\}$/u.test(part)?'([\\s\\S]*?)':regexEscape(part)).join('')+'$','u')}));
export function text(value){const source=normalize(value);if(language()!=='zh-CN')return String(value??'');if(messages[source])return messages[source];for(const rule of patterns){const match=source.match(rule.pattern);if(match)return rule.target.replace(/\{(\d+)\}/gu,(_,index)=>match[rule.slots.indexOf(index)+1]??'');}return window.MBBS_I18N?.message(String(value??''))||String(value??'');}
const decode=value=>{const node=document.createElement('textarea');node.innerHTML=value;return node.value;};
function descriptor(source,values,token){const slots=[];const pattern=source.replace(token,(_,index)=>{const value=values[Number(index)];slots.push(isUi(value)?{ui:String(value)}:String(value??''));return '{'+(slots.length-1)+'}';});return {pattern:normalize(pattern),values:slots,before:source.match(/^\s*/u)?.[0]||'',after:source.match(/\s*$/u)?.[0]||''};}
function formatted(data,plain=false){return data.before+text(data.pattern).replace(/\{(\d+)\}/gu,(match,index)=>{if(Number(index)>=data.values.length)return match;const value=data.values[Number(index)];if(typeof value==='object'){const translated=text(decode(value.ui));return plain?translated:escape(translated);}return plain?decode(value||''):value||'';})+data.after;}
function apply(element){
 if(element.dataset.rText){const data=JSON.parse(element.dataset.rText),value=formatted(data,element.tagName==='OPTION'||element.dataset.rPlain==='true');if(element.dataset.rPlain==='true'||element.tagName==='OPTION'){if(element.textContent!==value)element.textContent=value;}else if(element.innerHTML!==value){element.innerHTML=value;for(const child of element.querySelectorAll('[data-r-text],[data-r-attrs]'))apply(child);}}
 if(element.dataset.rAttrs)for(const [name,data] of Object.entries(JSON.parse(element.dataset.rAttrs))){const value=formatted(data,true);if(element.getAttribute(name)!==value)element.setAttribute(name,value);}
}
// Bind literal template copy and UI markers; keep escaped record values in slots.
// Language changes update these bindings in place, preserving forms, files and focus.
export function html(strings,...values){
 if(typeof strings==='string')strings=[strings];
 if(!browser)return strings.reduce((result,part,index)=>result+part+(index<values.length?String(values[index]??''):''),'');
 const prefix='rui'+Math.random().toString(36).slice(2)+'x',token=new RegExp(prefix+'(\\d+)z','gu');
 // A template anchor keeps nested markup inside table/select parsing contexts.
 // Plain text tokens would be moved out of a tbody by the HTML parser.
 const source=strings.reduce((result,part,index)=>{result+=part;if(index>=values.length)return result;const tokenValue=prefix+index+'z',value=values[index],inTag=result.lastIndexOf('<')>result.lastIndexOf('>');return result+(!inTag&&!isUi(value)&&/<\/?[a-z][\w-]*[\s>]/iu.test(String(value??''))?'<template data-r-slot="'+tokenValue+'"></template>':tokenValue);},'');
 const fragment=document.createElement('template');fragment.innerHTML=source;
 for(const element of fragment.content.querySelectorAll('*')){const bindings={};for(const name of attributes){const value=element.getAttribute(name);if(value){const data=descriptor(value,values,token);if(!/^\{\d+\}$/u.test(data.pattern)||data.values.some(slot=>typeof slot==='object'))bindings[name]=data;}}if(Object.keys(bindings).length)element.dataset.rAttrs=JSON.stringify(bindings);}
 const walker=document.createTreeWalker(fragment.content,4),nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
 for(const node of nodes){if(node.parentElement?.closest('script,style,textarea,[data-r-text],[translate=no]'))continue;const data=descriptor(node.data,values,token);if(!/[A-Za-z]/u.test(data.pattern.replace(/\{\d+\}/gu,''))&&!data.values.some(slot=>typeof slot==='object'))continue;
  if(data.values.some(value=>typeof value==='string'&&/<(?:input|textarea|select|button|form|video|canvas|dialog)\b/iu.test(value)))continue;
  if(node.parentElement?.tagName==='OPTION'){node.parentElement.dataset.rText=JSON.stringify(data);continue;}
  const span=document.createElement('span');span.dataset.rText=JSON.stringify(data);node.replaceWith(span);
 }
 for(const element of fragment.content.querySelectorAll('[data-r-text],[data-r-attrs]'))apply(element);
 return fragment.innerHTML.replace(new RegExp('<template data-r-slot="'+prefix+'(\\d+)z"></template>','gu'),(_,index)=>String(values[Number(index)]??'')).replace(new RegExp('('+prefix+'\\d+z)=""','gu'),'$1').replace(token,(_,index)=>String(values[Number(index)]??''));
}
export function setText(element,value){if(!element)return;const source=String(value??'');element.dataset.rText=JSON.stringify({pattern:normalize(source),values:[],before:'',after:''});element.dataset.rPlain='true';apply(element);}
export function setRecordText(element,value){if(!element)return;delete element.dataset.rText;delete element.dataset.rPlain;element.textContent=String(value??'');}
export function fieldAttributes(source){if(!browser)return String(source);const input=document.createElement('template');input.innerHTML='<input '+String(source)+'>';const element=input.content.firstElementChild,bindings={};for(const name of attributes){const value=element.getAttribute(name);if(value)bindings[name]={pattern:value,values:[],before:'',after:''};}if(Object.keys(bindings).length){element.dataset.rAttrs=JSON.stringify(bindings);apply(element);}return element.outerHTML.replace(/^<input\s?/u,'').replace(/>$/u,'');}
export function setAttribute(element,name,value){if(!attributes.includes(name)){element.setAttribute(name,String(value));return;}const current=JSON.parse(element.dataset.rAttrs||'{}');current[name]={pattern:String(value??''),values:[],before:'',after:''};element.dataset.rAttrs=JSON.stringify(current);apply(element);}
export function setTitle(value){if(!browser)return;document.documentElement.dataset.repairTitle=String(value);document.title=text(value);}
export function toggle(){return window.MBBS_I18N?.toggleHtml()||'<div class="language-toggle" role="group" aria-label="Language"><button type="button" data-action="repair-language" data-language="en">EN</button><button type="button" data-action="repair-language" data-language="zh-CN">简</button></div>';}
function mountPicker(host){if(!host||host.querySelector(':scope > [data-repair-language]'))return;const picker=document.createElement('div');picker.dataset.repairLanguage='';picker.className='repair-language';picker.innerHTML=toggle();host.classList.add('repair-language-header');host.append(picker);}
function refresh(){
 for(const element of document.querySelectorAll('[data-repair-copy]')){setText(element,element.dataset.repairCopy);}
 for(const element of document.querySelectorAll('[data-r-text],[data-r-attrs]'))apply(element);
 for(const picker of document.querySelectorAll('[data-repair-language]')){const value=toggle();if(picker.innerHTML!==value)picker.innerHTML=value;}
 if(document.documentElement.dataset.repairTitle)document.title=text(document.documentElement.dataset.repairTitle);
 document.documentElement.lang=language();
}
function mount(){
 const header=document.querySelector('.repair-topbar,.requester-topbar,body.repair-team #repairApp > .topbar');if(header){document.querySelector('[data-repair-page-language]')?.remove();mountPicker(header);}
 if(!header&&document.querySelector('#repairApp,#quoteApp,#requesterApp,#repairOfflinePage')&&!document.querySelector('[data-repair-page-language]')){const bar=document.createElement('nav');bar.className='repair-language-bar';bar.dataset.repairPageLanguage='';document.body.prepend(bar);mountPicker(bar);}
 for(const dialog of document.querySelectorAll('dialog,[role=dialog]'))if(dialog.querySelector('[data-r-text]'))mountPicker(dialog.querySelector('header,.team-section-heading,.row.spread'));
}
if(browser){
 if(!document.documentElement.dataset.repairTitle&&document.querySelector('#repairApp,#quoteApp,#requesterApp,#repairOfflinePage'))document.documentElement.dataset.repairTitle=document.title;
 const style=document.createElement('link');style.rel='stylesheet';style.href='/repair/i18n.css?v=20261030-repair-language';document.head.append(style);
 let pending=false;new window.MutationObserver(()=>{if(pending)return;pending=true;window.queueMicrotask(()=>{pending=false;mount();});}).observe(document.body,{childList:true,subtree:true});
 window.addEventListener('mbbs-language-changed',refresh);window.addEventListener('storage',event=>{if(event.key===key)refresh();});
 document.addEventListener('click',event=>{const button=event.target.closest('[data-action=repair-language]');if(!button)return;localStorage.setItem(key,button.dataset.language);refresh();});mount();refresh();
}
