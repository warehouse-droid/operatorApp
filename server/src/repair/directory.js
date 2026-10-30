import {query,withTransaction} from '../db.js';
import {hash} from './repository.js';
import {sameEquipment,storeVehicle,storeMachine,masterPayload,verifyMaster} from './master-records.js';
import * as d from '../../public/repair/domain.js';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export function createRepairDirectory({adapter,repo,enabled=()=>false,logger=console}){
 let expiresAt=0,inflight;
 async function refresh(force=false){
  if(inflight)return inflight;if(!force&&expiresAt>Date.now())return;
  inflight=(async()=>{
   const mapping=await repo.directoryMappings(),[vehicles,machines]=await Promise.all([adapter.vehicles(),adapter.machines()]);
   const result=await withTransaction(async()=>{
    await query("SELECT pg_advisory_xact_lock(hashtext('repair_master_directory'))");
    const trucks=(await query('SELECT id,plate FROM dispatch_trucks')).rows,linked=new Set();
    for(const v of vehicles){
     const matches=machines.filter(m=>sameEquipment(v,m)),machine=matches.length===1&&vehicles.filter(other=>sameEquipment(other,matches[0])).length===1?matches[0]:null;
     await storeVehicle(v,machine,mapping,trucks);if(machine)linked.add(String(machine.id));
    }
    for(const machine of machines)if(!linked.has(String(machine.id)))await storeMachine(machine,mapping);
    return {vehicles:vehicles.length,machines:machines.length};
   });expiresAt=Date.now()+60000;return result;
  })();try{return await inflight;}finally{inflight=null;}
 }
 async function register(actor,input){
  d.requireAllowed(d.canViewCosts(actor));if(!enabled())throw d.fail('Repair equipment registration is disabled.',409);
  const commandId=d.uuid(input.commandId),key=d.actorKey(actor),digest=hash(JSON.stringify(canonical(input)));
  const mapping=await repo.directoryMappings(),master=masterPayload(input,mapping,`repair-master-${hash(key+':'+commandId).slice(0,40)}`);
  const customer=await adapter.read('customer',master.customerId);if(String(customer?.id)!==master.customerId)throw d.fail('Choose an existing NetSuite customer.');
  // Commit the intent before the remote write: a lost response must not permit
  // changing the record type or contents under the same retry identity.
  await withTransaction(async()=>{
   await query('SELECT pg_advisory_xact_lock(hashtext($1))',[`repair-master:${key}:${commandId}`]);
   const prior=(await query('SELECT kind,digest,result FROM repair_commands WHERE actor=$1 AND command_id=$2',[key,commandId])).rows[0];
   if(prior){if(prior.kind!=='equipment_master'||prior.digest!==digest)throw d.fail('This command was already saved with different content.',409);return prior.result;}
   await query('INSERT INTO repair_commands(actor,command_id,kind,payload,digest,result) VALUES($1,$2,$3,$4,$5,$6)',[key,commandId,'equipment_master',input,digest,{pending:true}]);
  });
  return withTransaction(async()=>{
   await query('SELECT pg_advisory_xact_lock(hashtext($1))',[`repair-master:${key}:${commandId}`]);
   const prior=(await query('SELECT result FROM repair_commands WHERE actor=$1 AND command_id=$2',[key,commandId])).rows[0];if(!prior.result.pending)return prior.result;
   const record=await adapter.create(master.type,master.payload);verifyMaster(record,master.payload);
   await query("SELECT pg_advisory_xact_lock(hashtext('repair_master_directory'))");
   const vehicleId=master.recordType==='machine'?await storeMachine({id:record.id,name:record.name,altname:record.altName,alias:record.custrecord50,serial:record.custrecord2,subsidiary_id:record.custrecord30?.id},mapping,master.equipmentType):
    await storeVehicle({id:record.id,name:record.name,altname:record.altName,alias:record.custrecord78,serial:record.custrecord70,plate:record.custrecord68,customer_id:record.custrecord77?.id,customer_name:customer.companyName||customer.entityId,vehicle_type:record.custrecord76},null,mapping);
   const result={recordType:master.recordType,netsuiteId:String(record.id),name:record.name||record.altName,vehicleId};
   await query('UPDATE repair_commands SET result=$3 WHERE actor=$1 AND command_id=$2',[key,commandId,result]);
   await query('INSERT INTO repair_events(actor,kind,data) VALUES($1,$2,$3)',[key,'equipment_master_created',result]);expiresAt=0;return result;
  });
 }
 return {register,
  async sync(actor){d.requireAllowed(d.canViewCosts(actor));return refresh(true);},
  async search(actor,search=''){void refresh().catch(()=>{expiresAt=Date.now()+15000;logger.warn('[Repair] Master refresh failed; using cached equipment.');});return repo.vehicles(actor,search);},
  customers:async(actor,q)=>{d.requireAllowed(d.canViewCosts(actor));return adapter.customers(d.text(q||'','Search',100,false));},
  vendors:async(actor,q)=>{d.requireAllowed(d.canViewCosts(actor));return adapter.vendors(d.text(q||'','Search',100,false));},
  services:async actor=>{d.requireAllowed(d.canViewCosts(actor));return adapter.services();},
  async classify(actor,input){d.requireAllowed(d.canViewCosts(actor));const mapping=await repo.directoryMappings(),company=d.choice(input.company,d.COMPANIES,'company');
   return withTransaction(async()=>{await query("SELECT pg_advisory_xact_lock(hashtext('dispatch_fleet_planning_mutation'))");
    const row=(await query('SELECT * FROM repair_vehicles WHERE id=$1 FOR UPDATE',[d.uuid(input.id)])).rows[0];if(!row)throw d.fail('Vehicle not found.',404);
    if(company!=='EXTERNAL'&&row.customer_id!==mapping[{MBT:'mbtCustomerId',MBR:'mbrCustomerId',MBBS:'mbbsCustomerId'}[company]])throw d.fail('Configure the correct billing customer before changing company.');
    await query("UPDATE repair_vehicles SET company=$2,dispatch_truck_id=$3,data=data||'{\"companyOverride\":true}'::jsonb WHERE id=$1",[row.id,company,input.dispatchTruckId?d.integer(Number(input.dispatchTruckId),'Dispatch truck',1):null]);return {ok:true};});
  }
 };
}
