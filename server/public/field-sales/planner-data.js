// Ward names from the City's Community Planning feed, verified 2026-09-18.
const names=['Etobicoke North','Etobicoke Centre','Etobicoke-Lakeshore','Parkdale-High Park','York South-Weston','York Centre','Humber River-Black Creek','Eglinton-Lawrence','Davenport','Spadina-Fort York','University-Rosedale',"Toronto-St. Paul's",'Toronto Centre','Toronto-Danforth','Don Valley West','Don Valley East','Don Valley North','Willowdale','Beaches-East York','Scarborough Southwest','Scarborough Centre','Scarborough-Agincourt','Scarborough North','Scarborough-Guildwood','Scarborough-Rouge Park'];
export const WARDS=names.map((name,index)=>[String(index+1).padStart(2,'0'),`${String(index+1).padStart(2,'0')} · ${name}`]);
export function wardLabel(site) {
  const ward=String(site.ward||'').padStart(2,'0');
  return WARDS.find(([id])=>id===ward)?.[1]||site.ward_name||(site.ward?`Ward ${site.ward}`:'');
}
export function routeAdditions(stops,sites) {
  const key=(id,address)=>`${id}|${String(address||'').trim().replace(/\s+/g,' ').toUpperCase()}`;
  const existing=new Set(stops.map(stop=>key(stop.jobsiteId,stop.address)));
  const additions=sites.filter(site=>{const id=key(site.id,site.address);if(existing.has(id)){return false;}existing.add(id);return true;});
  if(stops.length+additions.length>250){throw new Error(`Routes can have up to 250 stops. This route has ${stops.length}; select fewer jobsites or choose another route.`);}
  return additions;
}
