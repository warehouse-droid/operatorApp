import crypto from 'node:crypto';
import {query} from '../../../src/db.js';
import {actor} from './bin-collection-request-fixtures.js';
export const command=fields=>({actor,reason:'Current action regression',idempotencyKey:crypto.randomUUID(),correlationId:crypto.randomUUID(),requestId:crypto.randomUUID(),...fields});
export async function nextVersion(f,deposit=25000) {
  const id=crypto.randomUUID();
  await query(`INSERT INTO mbt_rate_card_versions(rate_card_version_id,rate_card_id,version_number,status,effective_from,created_by,updated_by)
    SELECT $2,rate_card_id,(SELECT max(version_number)+1 FROM mbt_rate_card_versions WHERE rate_card_id=v.rate_card_id),'draft',effective_from,'test','test'
    FROM mbt_rate_card_versions v WHERE rate_card_version_id=$1`,[f.rateCardVersionId,id]);
  await query(`INSERT INTO mbt_deposit_rules(deposit_rule_id,rate_card_version_id,rule_code,rule_type,bin_type_id,fixed_amount_minor,currency,liability_account_mapping_key)
    VALUES($1,$2,'current_deposit','bin_type',$3,$4,'CAD','local_bin_deposit')`,[crypto.randomUUID(),id,f.binTypeId,deposit]);
  await query(`INSERT INTO mbt_rate_distance_bands(rate_distance_band_id,rate_card_version_id,service_code,bin_type_id,sequence_number,minimum_metres,maximum_metres,amount_minor,currency)
    SELECT gen_random_uuid(),$2,service_code,bin_type_id,sequence_number,minimum_metres,maximum_metres,amount_minor,currency
    FROM mbt_rate_distance_bands WHERE rate_card_version_id=$1`,[f.rateCardVersionId,id]);
  await query(`INSERT INTO mbt_rate_components(rate_component_id,rate_card_version_id,component_code,component_kind,service_code,bin_type_id,rate_basis,amount_minor,currency,taxable)
    SELECT gen_random_uuid(),$2,component_code,component_kind,service_code,bin_type_id,rate_basis,amount_minor,currency,taxable
    FROM mbt_rate_components WHERE rate_card_version_id=$1`,[f.rateCardVersionId,id]);
  await query(`UPDATE mbt_rate_card_versions SET status='retired',retired_at=now(),revision=revision+1,updated_at=now(),
    effective_to=CASE WHEN effective_from IS NULL OR effective_from>=now() THEN effective_to
      WHEN effective_to IS NULL OR effective_to>now() THEN now() ELSE effective_to END
    WHERE rate_card_id=$1 AND status='active'`,[f.rateCardId]);
  await query("UPDATE mbt_rate_card_versions SET status='active',activated_at=now() WHERE rate_card_version_id=$1",[id]);
  return id;
}
export function addInput(f,kind='add_bin') {
  return command({kind,contractId:f.contractId,expectedContractRevision:f.contract.revision,
    rateCardVersionId:f.rateCardVersionId,paymentMethod:'cash',billingAddressText:'100 Billing Road',serviceAddressText:'200 Site Road',contractTelephone:'4165550123',
    distanceMetres:12500,bin:{incomingContentCode:'garbage',incomingBinSizeYards:14,incomingBinTypeId:f.binTypeId,binItemCode:f.binItemCode,
      deliveryItemCode:f.deliveryItemCode,discountMinor:0,proposedDeliveryAt:'2037-08-20T12:00:00Z',proposedReturnAt:'2037-09-03T12:00:00Z'}});
}
