import {query} from '../db.js';
import {config} from '../config.js';
import {fail} from '../../public/repair/domain.js';
import {dispatchLoadAssignment,loadHasPlanningContent} from '../dispatch-load-assignment.js';
export async function assertRepairVehicleAvailable({vehicleId=null,truckId=null,plate='',enabled=config.repair?.enabled}={}){
 if(!enabled)return;
 const rows=(await query(`SELECT r.number FROM repair_requests r JOIN repair_vehicles v ON v.id=r.vehicle_id WHERE r.condition='out_of_service' AND r.status<>'cancelled' AND NOT(r.receipt='accepted' AND r.outcome='repaired') AND (v.id=$1::uuid OR v.dispatch_truck_id::text=$2 OR ($3<>'' AND v.plate<>'#' AND regexp_replace(upper(v.plate),'[^A-Z0-9]','','g')=$3)) ORDER BY r.created_at`,[vehicleId,truckId?String(truckId):null,String(plate).replace(/[^a-z0-9]/gi,'').toUpperCase()])).rows;
 if(rows.length)throw fail(`Vehicle is out of service (${rows.map(row=>row.number).join(', ')}). Reassign this work or resolve the repair hold.`,409,'REPAIR_OUT_OF_SERVICE');
}
export async function assertRepairPlanAvailable(plan){
 if(!config.repair?.enabled)return;
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 if(String(plan.planDate||plan.plan_date||'').slice(0,10)<=today)return;
 const seen=new Set();for(const truck of plan.trucks||[])for(const load of truck.loads||[]){if(!loadHasPlanningContent(load))continue;const assignment=dispatchLoadAssignment(truck,load);const key=assignment.truckId||assignment.truckPlate;if(!key||seen.has(key))continue;seen.add(key);await assertRepairVehicleAvailable({truckId:assignment.truckId,plate:assignment.truckPlate});}
}
