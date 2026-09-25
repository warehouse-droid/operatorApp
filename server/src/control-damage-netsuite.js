import {fetchInventoryItemUnitsFromNetSuite,inventoryTransferRest} from './netsuite.js';
import {damageNetSuite,getDamageItem} from './inventory-damage-netsuite.js';
import {inventoryId} from './inventory-workflow-domain.js';
export function createControlDamageNetSuite({transfer=damageNetSuite,rest=inventoryTransferRest,item=getDamageItem,itemUnits=fetchInventoryItemUnitsFromNetSuite}={}) {
  return {...transfer,item,itemUnits,
    async apply(id,plan) {
      await rest(`/${inventoryId(id)}${plan.replace?'?replace=inventory':''}`,{method:'PATCH',body:plan.payload});
    }
  };
}
export const controlDamageNetSuite=createControlDamageNetSuite();
