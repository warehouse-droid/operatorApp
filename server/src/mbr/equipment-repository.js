import {query} from '../db.js';
import {MbrError} from '../../public/mbr/domain.js';
import {normalizeEquipmentInput,validateEquipmentChoice} from '../../public/mbr/equipment.js';

const columns='id,brand,model,description,unit_code AS "unitCode",serial_number AS "serialNumber",active,revision';
function values(input) {
  const data=normalizeEquipmentInput(input);
  return [data.brand,data.model,data.description,data.unitCode,data.serialNumber,data.active];
}
function equipmentId(value) {
  if(!/^[1-9]\d{0,9}$/u.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value)>2147483647) {
    throw new MbrError('Invalid equipment identifier.');
  }
  return Number(value);
}
function duplicate(error) {
  if(error.code==='23505') {throw new MbrError('That unit code or serial number / VIN already exists in MBR Setup.',409,'MBR_EQUIPMENT_DUPLICATE');}
  throw error;
}
export function createMbrEquipmentRepository() {
  async function list() {
    return {items:(await query(`SELECT ${columns} FROM mbr_equipment ORDER BY brand,model,unit_code,id`)).rows};
  }
  async function add(actor,input) {
    const data=values(input);
    try {
      return (await query(`INSERT INTO mbr_equipment(brand,model,description,unit_code,serial_number,active,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`,[...data,actor.id])).rows[0];
    } catch(error) {return duplicate(error);}
  }
  async function edit(actor,id,input) {
    const key=equipmentId(id),data=values(input),revision=input.revision;
    if(!Number.isSafeInteger(revision) || revision<1) {throw new MbrError('A valid equipment revision is required.');}
    let result;
    try {
      result=await query(`UPDATE mbr_equipment SET brand=$2,model=$3,description=$4,unit_code=$5,serial_number=$6,
        active=$7,updated_by=$8,updated_at=clock_timestamp(),revision=revision+1 WHERE id=$1 AND revision=$9 RETURNING ${columns}`,
      [key,...data,actor.id,revision]);
    } catch(error) {return duplicate(error);}
    if(result.rows[0]) {return result.rows[0];}
    if(!(await query('SELECT id FROM mbr_equipment WHERE id=$1',[key])).rows[0]) {throw new MbrError('Equipment not found.',404,'MBR_EQUIPMENT_NOT_FOUND');}
    throw new MbrError('This equipment changed. Reload MBR Setup before editing it again.',409,'MBR_EQUIPMENT_CHANGED');
  }
  return {list,add,edit};
}
export async function requireAvailableEquipment(fields,previous={}) {
  if(!fields.serialNumber && (!fields.equipmentModel || fields.equipmentModel===previous.equipmentModel)) {return;}
  if(fields.equipmentModel===previous.equipmentModel && fields.serialNumber===previous.serialNumber) {return;}
  // Hold a share lock until the contract revision is committed, so a concurrent
  // setup edit cannot retire or reassign a unit halfway through contract creation.
  const items=(await query(`SELECT ${columns} FROM mbr_equipment
    WHERE model=$1 AND ($2::text IS NULL OR serial_number=$2) AND active FOR SHARE`,[fields.equipmentModel,fields.serialNumber])).rows;
  validateEquipmentChoice(items,fields,previous);
}
