/** @param {unknown} value */
export function parseDeliveryExpiryTime(value) {
  if(typeof value!=='string' || value.length>40) {return null;}
  const match=/^(\d{1,4})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value.trim().replace(/^until\s+/i,''));
  if(!match?.[1]) {return null;}
  const suffix=match[3]?.toLowerCase();
  const parts=clockParts(match[1],match[2]),minutes=parts.minutes;
  let hours=parts.hours;
  if(!validClock(hours,minutes,suffix)) {return null;}
  if(suffix) {hours=hours%12+(suffix==='pm'?12:0);}
  return {minutes:hours*60+minutes,formatted:formatClock(hours,minutes)};
}
/** @param {string} digits @param {string|undefined} minutes */
function clockParts(digits,minutes) {
  return minutes===undefined && digits.length>2?{hours:Number(digits.slice(0,-2)),minutes:Number(digits.slice(-2))}
    :{hours:Number(digits),minutes:Number(minutes || 0)};
}
/** @param {number} hours @param {number} minutes @param {string|undefined} suffix */
function validClock(hours,minutes,suffix) {
  return minutes<=59 && hours<=23 && (!suffix || (hours>=1 && hours<=12));
}
/** @param {number} hours @param {number} minutes */
function formatClock(hours,minutes) {
  return `until ${String(hours%12 || 12).padStart(2,'0')}:${String(minutes).padStart(2,'0')} ${hours<12?'am':'pm'}`;
}
const toronto=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
/** @param {number} instant */
function localStamp(instant) {
  const parts=Object.fromEntries(toronto.formatToParts(new Date(instant)).map(part=>[part.type,part.value]));
  return Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute));
}
/** @param {number} wall */
function occurrences(wall) {
  // Sample both sides of a clock change, then validate each real occurrence.
  const offsets=new Set([-12,0,12].map(hours=>{
    const sample=wall+hours*3600000;return localStamp(sample)-sample;
  }));
  return [...offsets].map(offset=>wall-offset).filter(instant=>localStamp(instant)===wall).sort((a,b)=>a-b);
}
/** @param {unknown} value @param {string|Date} now */
export function deliveryExpiryDeadline(value,now) {
  const time=parseDeliveryExpiryTime(value),instant=new Date(now).getTime();
  if(!time || !Number.isFinite(instant)) {return null;}
  const local=localStamp(instant),midnight=Math.floor(local/86400000)*86400000;
  const wall=midnight+time.minutes*60000,candidates=occurrences(wall);
  if(!candidates.length && wall>local) {return null;}
  const next=candidates.find(candidate=>candidate>instant) ?? occurrences(wall+86400000)[0];
  return next===undefined?null:new Date(next).toISOString();
}
/** @param {string} value */
export function formatDeliveryExpiryDeadline(value) {
  const stamp=new Date(localStamp(new Date(value).getTime()));
  return formatClock(stamp.getUTCHours(),stamp.getUTCMinutes());
}
