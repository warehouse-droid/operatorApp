import { fail, text } from '../../public/field-sales/domain.js';

// The shared Maps gateway admits at most 12 points per standard road request.
// Overlapping chunk endpoints preserve every leg without double-counting dwell.
export async function estimateSalesRoute(data, gateway, actor) {
  if (!Array.isArray(data.stops) || data.stops.length > 250) {throw fail('A route supports up to 250 stops.');}
  const visits=data.stops.filter(s=>!['completed','skipped'].includes(s.status));
  const stayMinutes=visits.reduce((sum,s)=>{
    const n=Number(s.stayMinutes??15);if(!Number.isFinite(n)||n<0||n>1440){throw fail('Invalid visit duration.');}return sum+n;
  },0);
  const points=[...(data.origin?[data.origin]:[]),...visits,...(data.end?[data.end]:[])].map(s=>{
    const latitude=s.latitude==null?NaN:Number(s.latitude),longitude=s.longitude==null?NaN:Number(s.longitude);
    if(Number.isFinite(latitude)&&Math.abs(latitude)<=90&&Number.isFinite(longitude)&&Math.abs(longitude)<=180){return {latitude,longitude,stayMinutes:0};}
    const location=text(s.address,500);if(!location){throw fail('Every stop needs an address or coordinates.');}return {location,stayMinutes:0};
  });
  const parts=[];
  for(let offset=0;offset<points.length-1;offset+=11){parts.push(await gateway.estimateRoute({stops:points.slice(offset,offset+12),subsystem:'support_route',reason:'manual_refresh',actorId:actor.id,automatic:false,allowTolls:Boolean(data.allowTolls)}));}
  const available=parts.every(p=>p.source==='google_routes_v2');
  const driveMinutes=available?parts.reduce((n,p)=>n+p.driveMinutes,0):null;
  const legs=parts.flatMap(p=>p.legMinutes||[]),arrivals=[];
  let epoch=Date.parse(data.start);if(!Number.isFinite(epoch)){throw fail('A valid route start time is required.');}
  if(available){for(const [i,stop] of visits.entries()) {
    const legIndex=i+(data.origin?1:0)-1;
    if(legIndex>=0){epoch+=(legs[legIndex]||0)*60000;}
    arrivals.push({stopId:stop.id,at:new Date(epoch).toISOString()});epoch+=Number(stop.stayMinutes??15)*60000;
  }}
  const totalMinutes=available?driveMinutes+stayMinutes:null;
  return {available,driveMinutes,stayMinutes,totalMinutes,arrivals,distanceMeters:available?parts.reduce((n,p)=>n+(p.distanceMeters||0),0):null,routePath:available?parts.flatMap(p=>p.routePath||[]):[],finish:available?new Date(Date.parse(data.start)+totalMinutes*60000).toISOString():null,asOf:new Date().toISOString(),message:available?'Road estimate; traffic and access may vary.':'Road estimate unavailable. Visit time is retained; retry when Maps is available.',originIncluded:Boolean(data.origin),endIncluded:Boolean(data.end)};
}
