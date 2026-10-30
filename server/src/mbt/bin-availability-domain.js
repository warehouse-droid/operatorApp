// @ts-check
/** Project saved work without changing physical custody. Intervals are half-open:
 * a return finishing at 10:00 can supply a pickup beginning at 10:00.
 * @param {any} input */
export function plannedBinAvailability(input) {
  const current=availabilityAt(input);
  if (current.available || !input.latestPickupAt || input.actual.unusable) {return current;}
  const latest=Date.parse(input.latestPickupAt),start=Date.parse(input.at);
  const candidates=input.work.filter((/** @type {any} */ row)=>row.release && Date.parse(row.finish)>=start && Date.parse(row.finish)<=latest)
    .sort((/** @type {any} */ a,/** @type {any} */ b)=>Date.parse(a.finish)-Date.parse(b.finish));
  for (const row of candidates) {
    const available=availabilityAt({...input,at:row.finish,until:undefined});
    if (available.available) {return available;}
  }
  return current;
}

/** @param {any[]} work */
function orderedJobs(work) {
  const jobs=work.map(row=>({...row,begin:Date.parse(row.start),end:Date.parse(row.finish)}));
  if (jobs.some(row=>!Number.isFinite(row.begin) || !Number.isFinite(row.end) || row.end<row.begin)) {return null;}
  jobs.sort((a,b)=>a.begin-b.begin || a.end-b.end || String(a.id).localeCompare(String(b.id)));
  return jobs.some((row,index)=>index>0 && row.begin<jobs[index-1].end) ? null : jobs;
}
/** @param {any} job */
function releasedState(job) {
  return {available:Boolean(job.release),projected:Boolean(job.release),location:job.release,
    availableAt:job.release ? new Date(job.end).toISOString() : null,
    predecessorId:job.release ? job.id : null,predecessorReference:job.release ? job.reference : null};
}
/** @param {any} actual @param {number} start @param {number} finish */
function invalidAvailabilityTime(actual,start,finish) {
  return actual.unusable || !Number.isFinite(start) || !Number.isFinite(finish) || finish<start;
}
/** @param {any} state @param {any} truckId */
function wrongTruck(state,truckId) {
  return state.location.kind==='truck' && truckId && String(state.location.id)!==String(truckId);
}
/** @param {any} input @returns {any} */
function availabilityAt({actual,work,at,until,truckId}) {
  const start=Date.parse(at),finish=until ? Date.parse(until) : start;
  const blocked={available:false,projected:false,reason:'This bin is reserved or has no planned empty return.'};
  if (invalidAvailabilityTime(actual,start,finish)) {return blocked;}
  const jobs=orderedJobs(work);if (!jobs) {return blocked;}
  /** @type {any} */
  let state={available:Boolean(actual.empty),projected:false,location:actual.location,
    availableAt:null,predecessorId:null,predecessorReference:null};
  for (const job of jobs) {
    if (job.begin>start) {
      if (job.begin<finish) {return blocked;}
      break;
    }
    if (job.end>start) {return blocked;}
    state=releasedState(job);
  }
  if (!state.available || !state.location) {return blocked;}
  if (wrongTruck(state,truckId)) {
    return {...blocked,reason:'This empty bin is on another truck.'};
  }
  return state;
}
