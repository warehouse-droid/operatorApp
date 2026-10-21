import crypto from 'node:crypto';
import {query} from '../../../src/db.js';
import {graph} from './delivery-request-fixtures.js';

export async function seedDeliveryRates() {
  if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Rate fixtures require an isolated disposable database.');}
  for(const type of ['pos','bin']) {
    const fixture=graph(type),itemCode=type==='pos'?'DELIVERY_CHARGE_MBBS':'DELIVERY_CHARGE_MBT';
    await query(`INSERT INTO mbt_local_item_settings(item_code,display_name,item_type,category,pricing_mode,netsuite_mapping_local_key,
      system_owned,applicable_service_types,applicable_legacy_source_types,charge_basis,active)
      VALUES($1,$1,'delivery_fee','cross_charge','rate_card',$2,false,ARRAY['delivery'],ARRAY['SO','TO','PO','VRMA'],'distance',true)
      ON CONFLICT(item_code) DO NOTHING`,[itemCode,type==='pos'?'delivery_charge_mbbs':'delivery_charge_mbt']);
    await query(`UPDATE mbt_rate_card_versions SET status='retired',retired_at=now() WHERE status='active'
      AND rate_card_id IN (SELECT rate_card_id FROM mbt_rate_cards WHERE rate_card_code=$1)`,[fixture.rateCardCode]);
    const cards=await query(`INSERT INTO mbt_rate_cards(rate_card_id,rate_card_code,display_name,currency,active)
      VALUES($1,$2,$3,'CAD',true) ON CONFLICT(rate_card_code) DO UPDATE SET active=true RETURNING rate_card_id`,
    [crypto.randomUUID(),fixture.rateCardCode,fixture.displayName]);
    await query(`INSERT INTO mbt_rate_card_versions(rate_card_version_id,rate_card_id,version_number,status)
      VALUES($1,$2,(SELECT COALESCE(max(version_number),0)+1 FROM mbt_rate_card_versions WHERE rate_card_id=$2),'draft')`,
    [fixture.rateCardVersionId,cards.rows[0].rate_card_id]);
    let binId=null;
    if(type==='bin') {
      const bins=await query(`INSERT INTO mbt_bin_types(bin_type_id,type_code,display_name,nominal_yards,active)
        VALUES($1,'14YD','14 Yard',14,true) ON CONFLICT(type_code) DO UPDATE SET active=true RETURNING bin_type_id`,[crypto.randomUUID()]);
      binId=bins.rows[0].bin_type_id;
    }
    for(const band of fixture.bands) {
      await query(`INSERT INTO mbt_rate_distance_bands(rate_card_version_id,item_code,service_code,bin_type_id,sequence_number,
        minimum_metres,maximum_metres,amount_minor,pricing_basis,boundary_rule,base_amount_minor,included_metres,origin_yard_codes,currency,rate_distance_band_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'CAD',$14)`,
      [fixture.rateCardVersionId,band.itemCode,band.serviceCode,binId,band.sequenceNumber,band.minimumMetres,band.maximumMetres,
        band.amountMinor,band.pricingBasis,band.boundaryRule,band.baseAmountMinor,band.includedMetres,band.originYardCodes,crypto.randomUUID()]);
    }
    if(type==='pos') {
      await query('INSERT INTO mbt_mbbs_rate_card_policies(rate_card_version_id) VALUES($1) ON CONFLICT DO NOTHING',[fixture.rateCardVersionId]);
    }
    await query(`UPDATE mbt_rate_card_versions SET status='active',effective_from='2020-01-01',activated_at=now() WHERE rate_card_version_id=$1`,[fixture.rateCardVersionId]);
  }
}
