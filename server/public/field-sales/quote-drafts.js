import {COMPANIES,fail,torontoWindow} from './domain.js';

/** @param {string} today @param {{validityDays?:number}} [profile] */
export function quoteDates(today,profile={}){
 torontoWindow(today);
 const days=profile.validityDays??30;
 if(!Number.isInteger(days)||days<0||days>3650){throw fail('Quote validity must be 0–3650 days.');}
 const expiry=new Date(today+'T12:00:00Z');expiry.setUTCDate(expiry.getUTCDate()+days);
 return {quoteDate:today,validUntil:expiry.toISOString().slice(0,10)};
}

// IDs are persisted with the composer before enqueueing, so offline retries use
// the same company records. Existing empty drafts retain their history.
/**
 * @template {{company:string}} T
 * @param {{id:string,revision?:number,company?:string,lines:T[],companyQuotes?:Record<string,{id:string,revision?:number}>,automaticCompanies?:boolean}} draft
 * @param {()=>string} makeId
 */
export function splitCompanyDraft(draft,makeId){
 if(!Array.isArray(draft.lines)||draft.lines.some(l=>!COMPANIES.includes(l.company))){throw fail('Every item needs a valid catalog company.');}
 const companies=COMPANIES.filter(c=>draft.lines.some(l=>l.company===c)||draft.company===c&&Number(draft.revision)>0||Number(draft.companyQuotes?.[c]?.revision)>0);
 if(!companies.length){throw fail('Add at least one item to create a quote.');}
 const {companyQuotes,automaticCompanies:_automaticCompanies,...common}=draft;
 return companies.map((company,i)=>{
  const ref=companyQuotes?.[company]||(draft.company===company?{id:draft.id,revision:draft.revision}:{id:!draft.company&&i===0?draft.id:makeId(),revision:0});
  return {...common,...ref,company,revision:Number(ref.revision||0),lines:draft.lines.filter(l=>l.company===company)};
 });
}
