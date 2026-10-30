import {randomUUID} from 'node:crypto';
import {query} from '../db.js';
import * as d from '../../public/repair/domain.js';

const clean=value=>String(value||'').trim();
const identity=value=>/^(?:#|null|n\/a|none)?$/iu.test(clean(value))?'':clean(value).replace(/\W/gu,'').toUpperCase();
export function sameEquipment(vehicle,machine){
 const serial=identity(vehicle.serial),other=identity(machine.serial),item=clean(vehicle.item_id),otherItem=clean(machine.item_id);
 if(serial&&other)return serial===other&&(!item||!otherItem||item===otherItem);
 return Boolean(item&&otherItem&&item===otherItem);
}
const companyFor=(customer,mapping)=>Object.entries({MBT:'mbtCustomerId',MBBS:'mbbsCustomerId',MBR:'mbrCustomerId'}).find(([_company,key])=>customer&&customer===mapping[key])?.[0]||'EXTERNAL';
export async function storeVehicle(v,machine,mapping,trucks=[]){
 const customerId=clean(v.customer_id),company=companyFor(customerId,mapping),plate=clean(v.plate);
 const matches=identity(plate)?trucks.filter(t=>identity(t.plate)===identity(plate)):[];
 // A previously standalone machine keeps its UUID and existing repair links.
 if(machine)await query('UPDATE repair_vehicles SET netsuite_id=$1 WHERE machine_id=$2 AND netsuite_id IS NULL AND NOT EXISTS(SELECT 1 FROM repair_vehicles WHERE netsuite_id=$1)',[d.reference(v.id),d.reference(machine.id)]);
 const data={sourceType:'vehicle',sourceId:String(v.id),masterName:clean(v.name),masterDisplayName:clean(v.altname),itemId:clean(v.item_id),customerName:clean(v.customer_name),netSuiteVehicleType:clean(v.vehicle_type),equipmentType:d.equipmentType(v.vehicle_type),machineName:clean(machine?.name),machineAlias:clean(machine?.alias),machineSerial:clean(machine?.serial)};
 const row=(await query(`INSERT INTO repair_vehicles(id,netsuite_id,machine_id,dispatch_truck_id,company,customer_id,plate,alias,serial,data,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
 ON CONFLICT(netsuite_id) DO UPDATE SET machine_id=EXCLUDED.machine_id,dispatch_truck_id=coalesce(repair_vehicles.dispatch_truck_id,EXCLUDED.dispatch_truck_id),company=CASE WHEN repair_vehicles.data->>'companyOverride'='true' THEN repair_vehicles.company ELSE EXCLUDED.company END,customer_id=EXCLUDED.customer_id,plate=EXCLUDED.plate,alias=EXCLUDED.alias,serial=EXCLUDED.serial,data=repair_vehicles.data||EXCLUDED.data,active=EXCLUDED.active,updated_at=now() RETURNING id`,[randomUUID(),d.reference(v.id),machine?d.reference(machine.id):null,matches.length===1?matches[0].id:null,company,customerId,plate,clean(v.alias||v.altname||v.name),clean(v.serial),data,v.isinactive!=='T'])).rows[0];return row.id;
}
export async function storeMachine(m,mapping,equipmentType){
 const owned=String(m.subsidiary_id)===String(mapping.subsidiaryId),data={sourceType:'machine',sourceId:String(m.id),masterName:clean(m.name),masterDisplayName:clean(m.altname),itemId:clean(m.item_id),manufacturer:clean(m.manufacturer),model:clean(m.model),description:clean(m.description),subsidiaryId:clean(m.subsidiary_id)};
 if(equipmentType)data.equipmentType=equipmentType;
 const row=(await query(`INSERT INTO repair_vehicles(id,machine_id,company,customer_id,alias,serial,data,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
 ON CONFLICT(machine_id) WHERE netsuite_id IS NULL DO UPDATE SET company=CASE WHEN repair_vehicles.data->>'companyOverride'='true' THEN repair_vehicles.company ELSE EXCLUDED.company END,customer_id=EXCLUDED.customer_id,alias=EXCLUDED.alias,serial=EXCLUDED.serial,data=repair_vehicles.data||EXCLUDED.data,active=EXCLUDED.active,updated_at=now() RETURNING id`,[randomUUID(),d.reference(m.id),owned?'MBR':'EXTERNAL',owned?mapping.mbrCustomerId:'',clean(m.alias||m.altname||m.name),clean(m.serial),data,m.isinactive!=='T'])).rows[0];return row.id;
}
export function masterPayload(input,mapping,externalId){
 const recordType=d.choice(input.recordType||'vehicle',['vehicle','machine'],'master type'),alias=d.text(input.alias,'Equipment name / code',200),serial=d.text(input.serial||'','Serial / VIN',100,false),company=d.choice(input.company,d.COMPANIES,'company'),equipmentType=d.choice(input.equipmentType||'unknown',d.EQUIPMENT_TYPES,'equipment type');
 if(recordType==='machine'&&company!=='MBR')throw d.fail('Machine Master is the MBR rental equipment register.');
 const customerId=recordType==='machine'?d.reference(mapping.mbrCustomerId):d.reference(input.customerId);
 if(company!=='EXTERNAL'&&customerId!==mapping[{MBT:'mbtCustomerId',MBR:'mbrCustomerId',MBBS:'mbbsCustomerId'}[company]])throw d.fail('Customer does not match the configured owning company.');
 const payload=recordType==='machine'?{externalId,altName:alias,custrecord50:alias,custrecord2:serial,custrecord30:{id:d.reference(mapping.subsidiaryId)}}:
  {externalId,altName:alias,custrecord68:d.text(input.plate||'','Vehicle number',80,false),custrecord78:alias,custrecord70:serial,custrecord77:{id:customerId},custrecord119:{id:d.reference(mapping.subsidiaryId)},custrecord76:equipmentType==='unknown'?'':{truck:'Truck',forklift:'Forklift',loader:'Loader',other:'Other equipment'}[equipmentType]};
 return {recordType,customerId,equipmentType,payload,type:recordType==='machine'?'customrecord_mrb_machine_master':'customrecord240'};
}
export function verifyMaster(record,payload){
 if(!record?.id||Object.entries(payload).some(([key,value])=>String(value?.id??value)!==String(record[key]?.id??record[key]??'')))throw d.fail('NetSuite master identity differs from this request. Retry the original content or review the existing record.',409,'REPAIR_REMOTE_IDENTITY');
}
