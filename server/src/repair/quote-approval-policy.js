import {fail} from '../../public/repair/domain.js';
export const AUTO_QUOTE_APPROVER='system:repair-quote-auto-approval';
const keys=['trucks','forkliftsLoaders','externalCustomers'];
export const quoteApprovalPolicy=value=>Object.fromEntries(keys.map(key=>[key,value?.[key]===true]));
export function updateQuoteApprovalPolicy(value,current){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.entries(value).some(([key,enabled])=>!keys.includes(key)||typeof enabled!=='boolean'))throw fail('Choose true or false for each known quote approval category.');
 return {...quoteApprovalPolicy(current),...value};
}
export function quoteApprovalCategory(job){
 if(job.data?.repairType==='other')return null;
 if(job.company==='EXTERNAL')return 'externalCustomers';
 if(job.data?.equipmentTypeConfirmed!==true)return null;
 if(job.data.equipmentType==='truck')return 'trucks';
 if(['forklift','loader'].includes(job.data.equipmentType))return 'forkliftsLoaders';
 return null;
}
export function automaticQuoteCategory(settings,job){const category=quoteApprovalCategory(job);return category&&quoteApprovalPolicy(settings.quoteAutoApproval)[category]?category:null;}
