// @ts-check
import {MbrError,requiredText} from './domain.js';
/** @typedef {{brand:string,model:string,description:string,unitCode:string,serialNumber:string,active:boolean,legacy?:boolean}} Equipment */
/** @typedef {{equipmentModel?:string|null,serialNumber?:string|null}} EquipmentChoice */
/** @param {unknown} input @returns {Equipment} */
export function normalizeEquipmentInput(input) {
  if(!input || typeof input!=='object' || Array.isArray(input)) {throw new MbrError('Equipment details are required.');}
  const data=/** @type {Record<string,unknown>} */ (input);
  const active=data.active===undefined?true:data.active;
  if(typeof active!=='boolean') {throw new MbrError('Equipment availability must be true or false.');}
  const description=data.description===undefined || data.description===''?'':requiredText(data.description,'Description',500);
  return {brand:requiredText(data.brand,'Brand',100),model:requiredText(data.model,'Model',300),
    description,unitCode:requiredText(data.unitCode,'Unit code',100),
    serialNumber:requiredText(data.serialNumber,'Serial number / VIN',150),active};
}
/** @param {Equipment[]} items @param {EquipmentChoice} [previous] */
export function equipmentModels(items,previous={}) {
  const models=new Set(items.filter(item=>item.active).map(item=>item.model));
  if(previous.equipmentModel) {models.add(previous.equipmentModel);}
  return [...models].sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));
}
/** @param {Equipment[]} items @param {string} model @param {EquipmentChoice} [previous] @returns {Equipment[]} */
export function equipmentForModel(items,model,previous={}) {
  const matches=items.filter(item=>item.active && item.model===model);
  if(model && model===previous.equipmentModel && previous.serialNumber
      && !matches.some(item=>item.serialNumber===previous.serialNumber)) {
    const saved=items.find(item=>item.model===model && item.serialNumber===previous.serialNumber);
    matches.push(saved?{...saved,legacy:true}:{brand:'',model,description:'',unitCode:'',serialNumber:previous.serialNumber,active:false,legacy:true});
  }
  return matches.sort((a,b)=>a.unitCode.localeCompare(b.unitCode,'en',{numeric:true}));
}
/** @param {Equipment[]} items @param {EquipmentChoice} fields @param {EquipmentChoice} [previous] */
export function validateEquipmentChoice(items,fields,previous={}) {
  if(!fields.equipmentModel && !fields.serialNumber) {return;}
  if(fields.equipmentModel===previous.equipmentModel
      && (!fields.serialNumber || fields.serialNumber===previous.serialNumber)) {return;}
  if(!items.some(item=>item.active && item.model===fields.equipmentModel
      && (!fields.serialNumber || item.serialNumber===fields.serialNumber))) {
    throw new MbrError('Select an available serial number for the selected equipment model.',400,'MBR_EQUIPMENT_INVALID');
  }
}
