import {fail,torontoDate} from './domain.js';

export const PLANNING_MILESTONES=['Statement of Approval Issued','Notice of Approval Conditions Issued','Notice of Complete Application Issued','City Council Decision Made','Community Consultation Meeting Scheduled','Statutory Public Meeting','Application Circulated','Application Submitted','Not Applicable'];
export const SERVICE_CATEGORY_PATTERN='mechanical|plumbing|fire/security|(^|[^a-z])signs?([^a-z]|$)|alternative solution';
export const SERVICE_WORK=['back water valve (sewer only)','sign building permit related','solar collector','party wall admin permits','change of use','window replacement'];
const knownWork=new Set(['new building','new house','addition(s)','interior alterations','multiple projects','garage repair/reconstruction','balcony/guard repairs','fire damage','interior demolition','re-roofing/re-cladding','shoring','underpinning','canopy w/o enclosure','partial permit - shoring','partial permit - structural framing','partial permit - foundation','site service','inside and outside drains','retaining wall','pedestrian bridge','exterior tank & support','building permit related (dr)','new laneway / rear yard suite','second suite (new)','garage','deck','accessory building(s)','porch','walk-out stair','finishing basements','canopy','carport',...SERVICE_WORK]);
/** @param {unknown} value */
export function cityDate(value) {
  if(typeof value!=='string'){return null;}
  const match=value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/),date=match?.[1];
  if(!date||date<'0001-01-01'){return null;}
  const instant=new Date(`${date}T00:00:00Z`);
  return Number.isFinite(instant.getTime())&&instant.toISOString().slice(0,10)===date?date:null;
}
/** @param {unknown} months @param {Date} [now] */
export function recencyCutoff(months,now=new Date()) {
  if(months==null||months===''||months==='all'){return null;}
  if(!['string','number'].includes(typeof months)||!['6','12','24'].includes(String(months))){throw fail('Choose a recency of 6, 12, 24 months or All ages.');}
  const date=new Date(`${torontoDate(now)}T00:00:00Z`),day=date.getUTCDate();
  date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()-Number(months));
  const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(day,last));
  return date.toISOString().slice(0,10);
}
/** @param {Record<string,any>} data */
export function isServiceWork(data) {
  const category=String(data.category||'').trim().toLowerCase(),work=String(data.raw?.WORK||'').trim().toLowerCase();
  return String(data.minor)==='true'||new RegExp(SERVICE_CATEGORY_PATTERN).test(category)||SERVICE_WORK.includes(work)||(category==='drain and site service'&&work==='inside and outside drains');
}
/** @param {string} source @param {Record<string,any>} data @param {string} [key] */
export function sourceEvidence(source,data,key='') {
  const raw=data.raw||{},issued=source==='permit'?cityDate(raw.ISSUED_DATE):null,application=source==='permit'?cityDate(raw.APPLICATION_DATE):null;
  const date=issued||application||cityDate(data.date),work=source==='permit'?String(raw.WORK||'').trim():'';
  return {source,key,status:String(data.status||''),milestone:String(data.milestone||''),category:String(data.category||''),work,date,
    dateKind:source==='planning'?'milestone':issued?'issued':application?'application':'record',
    needsReview:source==='permit'&&!knownWork.has(work.toLowerCase())};
}
/** @param {string} kind */
export const leadDateLabel=kind=>(/** @type {Record<string,string>} */ ({issued:'Issued',application:'Applied',milestone:'Milestone',record:'Source date'}))[kind]||'Source date';
/** @param {Record<string,string>} values @param {string} changed */
export function alignLeadFilters(values,changed) {
  const next={...values};
  if(changed==='milestone'&&next.milestone){next.source='planning';delete next.permitStatus;}
  if(changed==='permitStatus'&&next.permitStatus?.trim()){next.source='permit';delete next.milestone;}
  if(changed==='source'){
    if(next.source==='planning'){delete next.permitStatus;}
    if(next.source==='permit'){delete next.milestone;}
    if(next.source==='manual'){delete next.milestone;delete next.permitStatus;delete next.category;}
  }
  return next;
}
