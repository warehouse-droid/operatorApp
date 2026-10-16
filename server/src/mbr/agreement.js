import fs from 'node:fs';
import {formatMoney} from '../../public/mbr/domain.js';
const template=JSON.parse(fs.readFileSync(new URL('./agreement-template.json',import.meta.url),'utf8'));

export function snapshotForFields(fields) {
  return {fields,template:structuredClone(template)};
}

function fillBlanks(paragraph,values) {
  let index=0;
  const result=paragraph.replace(/_{3,}/gu,placeholder=>{
    const value=values[index++];
    return value===null || value===undefined || value===''?placeholder:String(value);
  });
  if(index!==values.length) {throw new Error('MBR agreement template fields do not match the supplied source.');}
  return result;
}

function rateText(cents) {return formatMoney(cents).replace(/^\$/u,'');}
function signingDate(signature) {
  return signature ? new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'})
    .format(new Date(signature.signedAt)) : 'To be signed electronically';
}

export function agreementParagraphs(snapshot) {
  if(snapshot.signature && Array.isArray(snapshot.paragraphs)) {return [...snapshot.paragraphs];}
  const {fields:f,signature:s}=snapshot,paragraphs=[...snapshot.template.paragraphs];
  paragraphs[1]=fillBlanks(paragraphs[1],[f.effectiveDate,f.lessee]);
  paragraphs[3]=fillBlanks(paragraphs[3],[f.equipmentModel,f.serialNumber,f.rentalStart,f.rentalEnd,f.pickupLocation,f.returnLocation]);
  paragraphs[5]=fillBlanks(paragraphs[5],[f.dailyRateMinor,f.weeklyRateMinor,f.monthlyRateMinor,f.securityDepositMinor].map(rateText));
  const choice=s ? (s.protectionPlanAccepted?'Accept Rental Protection Plan (RPP) — selected':'Decline Rental Protection Plan (RPP) — selected')
    : 'Choose Accept or Decline Rental Protection Plan (RPP) below.';
  paragraphs[5]=paragraphs[5].replace(/☐ Accept Rental Protection Plan \(RPP\)\s+☐ Decline Rental Protection Plan \(RPP\)/u,choice);
  for(const index of [11,30]) {paragraphs[index]=paragraphs[index].replace(/\s+\(\s+\)$/u,'');}
  paragraphs[32]=fillBlanks(paragraphs[32],[f.lessee,f.effectiveDate,signingDate(s)]);
  return paragraphs;
}
