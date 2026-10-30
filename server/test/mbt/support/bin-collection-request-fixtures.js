import crypto from 'node:crypto';
import {query} from '../../../src/db.js';
import * as frontdesk from '../../../src/mbt/frontdesk-service.js';
import {createFrontdeskPrerequisites,quoteCommand,frontdeskCommand,frontdeskDistanceResolver,frontdeskTaxResolver} from './frontdesk-fixtures.js';
export const actor={operatorId:'explicit-collection-frontdesk',roles:['mbt_frontdesk']};
export async function rental(multi = false, content = null, paymentMethod = "cash") {
  const f = await createFrontdeskPrerequisites({ label: `explicit-${crypto.randomUUID()}` });
  const command = quoteCommand(f, { actor, identity: crypto.randomUUID() });
  if (multi) command.serviceLines = [1, 2].map(() => ({ binTypeId: f.binTypeId,
    proposedDeliveryAt: f.proposedDeliveryAt, proposedReturnAt: f.proposedReturnAt }));
  if (content) {
    await query(`INSERT INTO mbt_deposit_rules(deposit_rule_id,rate_card_version_id,rule_code,rule_type,bin_type_id,fixed_amount_minor,currency,liability_account_mapping_key)
      VALUES($1,$2,'bin_deposit_20yd','bin_type','00000000-0000-4000-8000-000000000020',10000,'CAD','local_bin_deposit')`,[crypto.randomUUID(),f.rateCardVersionId]);
    await query("UPDATE mbt_frontdesk_charge_catalog SET active=true WHERE item_kind='fixed_dump' OR item_code='AGG_LOADING'");
    for (const code of ['DUMP_SOIL','DUMP_ASPHALT','DUMP_CONCRETE','AGG_LOADING']) {
      await query(`INSERT INTO mbt_frontdesk_charge_rates(charge_rate_id,rate_card_version_id,item_code,amount_minor,currency,active,created_by,updated_by)
        VALUES ($1,$2,$3,$4,'CAD',true,'test','test')`, [crypto.randomUUID(),f.rateCardVersionId,code,code==='AGG_LOADING' ? 5000 : 30000]);
    }
    Object.assign(command,{paymentMethod,billingAddressText:'100 Billing Road',serviceAddressText:'200 Site Road',contractTelephone:'4165550123',
      dumpItemCode:undefined,estimatedTonnes:undefined,serviceLines:[{binItemCode:f.binItemCode,binTypeId:f.binTypeId,contentCode:content,
        discountMinor:0,proposedDeliveryAt:f.proposedDeliveryAt,proposedReturnAt:f.proposedReturnAt,siteProfileId:f.siteProfileId}]});
  }
  const created = await frontdesk.createFrontdeskQuote(command,
    { resolveDistance: frontdeskDistanceResolver(f), resolveTaxPolicy: frontdeskTaxResolver });
  const quoteId = created.body.quote.quoteId;
  await frontdesk.issueFrontdeskQuote(frontdeskCommand('issue', actor,
    { quoteId, expectedRevision: 1, validUntil: '2037-08-04T12:00:00Z' }));
  await frontdesk.acceptFrontdeskQuote(frontdeskCommand('accept', actor,
    { quoteId, expectedRevision: 2, acceptedAt: '2037-08-03T10:00:00Z' }));
  const converted = await frontdesk.convertFrontdeskQuote(frontdeskCommand('convert', actor,
    { quoteId, expectedRevision: 3 }));
  return { ...f, ...converted.body, contractId: converted.body.contract.contractId,
    line: converted.body.serviceLines[0] };
}
