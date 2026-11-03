import {html as rh,ui as ru} from './i18n.js?v=20261030-repair-language';
import {field,select} from './client.js?v=20261030-repair-language';
import {REPAIR_ADDRESSES} from './targets.js?v=20261030-repair-language';
export const repairTypeField=()=>select('repairType','Repair type',[['equipment','Equipment'],['other','Others']]);
export const addressFields=()=>rh`<fieldset data-other-address hidden disabled><legend>Address</legend><div class="request-grid grid">${select('addressChoice',ru('Address'),[['',ru('Choose address')],...REPAIR_ADDRESSES.map(a=>[a.choice,a.label]),['custom',ru('Custom address')]])}${field('customAddress',ru('Custom address'),'text','','maxlength="500"')}</div></fieldset>`;
export function updateIntakeFields(form,vehicles=[]){
 const other=form.elements.repairType?.value==='other',saved=Boolean(form.querySelector('[data-equipment-fields]')?.hasAttribute('data-saved'));
 for(const group of form.querySelectorAll('[data-equipment-fields]')){group.hidden=other;group.disabled=other||saved;}
 const address=form.querySelector('[data-other-address]');if(address){address.hidden=!other;address.disabled=!other||saved;const custom=form.elements.addressChoice.value==='custom';form.elements.addressChoice.required=other;form.elements.customAddress.closest('label').hidden=!custom;form.elements.customAddress.disabled=!other||!custom;form.elements.customAddress.required=other&&custom;}
 const condition=form.elements.condition;if(condition){condition.closest('label').hidden=other;condition.disabled=other||saved;}
 const type=form.elements.equipmentType,vehicle=vehicles.find(v=>v.id===form.elements.vehicleId?.value),fresh=form.elements.intakeMode?.value==='new';
 if(type){const known=!fresh&&vehicle&&vehicle.company!=='EXTERNAL'&&vehicle.equipmentType&&vehicle.equipmentType!=='unknown';type.closest('label').hidden=other||Boolean(known);type.disabled=other||Boolean(known)||saved;if(known)type.value=vehicle.equipmentType;}
 const notice=form.querySelector('[data-equipment-notice]');if(notice)notice.hidden=other;
}
