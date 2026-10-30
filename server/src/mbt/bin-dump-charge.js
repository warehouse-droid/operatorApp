// @ts-check
import { query } from '../db.js';
import { calculateGarbageDumpCharge } from './customer-charge-calculator.js';
import { currentContractActionRate } from './frontdesk-action-rates.js';

/** @param {string|null} materialId @param {string} effectiveAt @param {boolean} [current] */
async function effectiveGarbageTariff(materialId, effectiveAt, current = false) {
  const tariffs = await query(`SELECT tariff.* FROM mbt_dump_tariffs tariff
    JOIN mbt_rate_card_versions version USING(rate_card_version_id) JOIN mbt_rate_cards card USING(rate_card_id)
    JOIN mbt_local_item_settings item ON item.item_code=tariff.item_code
    WHERE lower(tariff.item_code) IN ('dumpgarbage','dump_garbage') AND tariff.active AND card.active AND item.active
      AND tariff.pricing_basis='per_weight' AND upper(tariff.unit_of_measure)='TONNE' AND item.charge_basis='per_tonne'
      AND tariff.currency='CAD' AND tariff.dump_site_id IS NULL
      AND ($1::uuid IS NULL OR tariff.material_id IS NULL OR tariff.material_id=$1)
      AND version.status IN ('active','retired') AND (NOT $3 OR version.status='active')
      AND (version.effective_from IS NULL OR version.effective_from<=$2)
      AND (version.effective_to IS NULL OR version.effective_to>$2) LIMIT 2`,[materialId,effectiveAt,current]);
  if (tariffs.rowCount!==1) {
    return {status:'needs_review',reason:'One effective DumpGarbage per-tonne rate is required.'};
  }
  const tariff = tariffs.rows[0];
  return {status:'priced',ratePerTonneMinor:Number(tariff.amount_minor),dumpTariffId:tariff.dump_tariff_id,
    rateCardVersionId:tariff.rate_card_version_id,materialId:tariff.material_id};
}

/** Capture the price when work is requested, before any later rate activation.
 * @param {string} contractId @param {string|null} [rateCardVersionId] */
export async function captureCollectionPricing(contractId, rateCardVersionId = null) {
  const currentVersion = rateCardVersionId || await currentContractActionRate(contractId, null, true);
  const requestedAt = new Date().toISOString();
  return {requestedAt,rateCardVersionId:currentVersion,
    garbageDump:await effectiveGarbageTariff(null,requestedAt,true)};
}

/** Confirmation keeps the price already previewed, even after retirement.
 * @param {string} contractId @param {string|null} chargeRequestId */
export async function exchangeCollectionPricing(contractId, chargeRequestId) {
  if (chargeRequestId) {
    const saved = await query(`SELECT pricing_snapshot->'bin'->'collectionPricing' AS pricing
      FROM mbt_frontdesk_charge_requests WHERE charge_request_id=$1 AND contract_id=$2`,[chargeRequestId,contractId]);
    if (saved.rows[0]?.pricing) { return saved.rows[0].pricing; }
  }
  return captureCollectionPricing(contractId);
}

/** @param {any} evidence */
async function collectionGarbageTariff(evidence) {
  const pinned = evidence.collection_pricing?.garbageDump;
  if (!pinned) { return effectiveGarbageTariff(evidence.material_id,evidence.collection_requested_at); }
  if (pinned.materialId && pinned.materialId !== evidence.material_id) {
    return {status:'needs_review',reason:'The collected material differs from the requested collection rate.'};
  }
  return pinned;
}

/** Freeze the measured customer charge only after the collection visit finishes.
 * Missing configuration is a visible billing review item; physical evidence remains durable.
 * @param {any} context @param {boolean} visitCompleted */
export async function completedBinDumpPricing(context, visitCompleted) {
  if (!visitCompleted) { return null; }
  const visit = context.rows.visit;
  const evidence = (await query(`SELECT receipt.*,material.material_code,
      COALESCE(root.service_snapshot->'collectionPricing',work.service_snapshot->'collectionPricing') AS collection_pricing,
      COALESCE(root.service_snapshot->>'collectionRequestedAt',work.service_snapshot->>'collectionRequestedAt',
        root.created_at::text,work.created_at::text) AS collection_requested_at,
      COALESCE(charge.payment_method,contract.pricing_snapshot->>'paymentMethod') AS payment_method,
      COALESCE(charge.charge_request_id::text,contract.pricing_snapshot->>'chargeRequestId') AS charge_id
    FROM mbt_dump_receipts receipt JOIN mbt_materials material USING(material_id)
    JOIN mbt_service_visits work ON work.service_visit_id=receipt.service_visit_id
    JOIN mbt_contracts contract ON contract.contract_id=work.contract_id
    LEFT JOIN mbt_bin_order_parts part ON part.visit_id=work.service_visit_id
    LEFT JOIN mbt_service_visits root ON root.service_visit_id=part.order_id
    LEFT JOIN mbt_contract_service_lines line ON line.service_line_id=work.service_line_id
    LEFT JOIN mbt_frontdesk_charge_requests charge ON charge.charge_request_id::text=
      COALESCE(root.service_snapshot->>'chargeRequestId',work.service_snapshot->>'chargeRequestId',line.pricing_snapshot->>'chargeRequestId')
      AND charge.status='confirmed' AND charge.contract_id=work.contract_id
    WHERE receipt.service_visit_id=$1 ORDER BY receipt.captured_at DESC LIMIT 1`, [visit.service_visit_id])).rows[0];
  if (!evidence?.charge_id || !evidence.payment_method) { return null; }
  const common = {receiptId:evidence.dump_receipt_id,serviceLineId:visit.service_line_id || null,
    paymentMethod:evidence.payment_method,currency:'CAD',recordedAfterCollection:true};
  const material = String(evidence.material_code).toLowerCase().replace(/^dump_?/, '');
  if (['soil','asphalt','concrete'].includes(material)) { return {...common,status:'prepaid',customerAmountMinor:0}; }
  if (material !== 'garbage') { return {...common,status:'needs_review',reason:'Review the order material before calculating its dump charge.'}; }
  const tariff = await collectionGarbageTariff(evidence);
  if (tariff.status!=='priced') { return {...common,...tariff}; }
  if (String(evidence.unit_of_measure).toUpperCase()!=='TONNE' || !evidence.weight) {
    return {...common,status:'needs_review',reason:'The completed collection needs a measured weight in tonnes.'};
  }
  const charge = calculateGarbageDumpCharge(String(evidence.weight),tariff.ratePerTonneMinor,evidence.payment_method);
  return {...common,...charge,status:'priced',weightTonnes:String(evidence.weight),
    ratePerTonneMinor:tariff.ratePerTonneMinor,dumpTariffId:tariff.dumpTariffId,rateCardVersionId:tariff.rateCardVersionId};
}

/** @param {string} contractId */
export async function readBinDumpCharges(contractId) {
  const {rows} = await query(`SELECT DISTINCT ON (trigger_snapshot->'dumpPricing'->>'receiptId')
    trigger_snapshot->'dumpPricing' AS charge FROM mbt_driver_bin_billing_triggers
    WHERE contract_id=$1 AND trigger_snapshot->'dumpPricing' IS NOT NULL
      AND trigger_snapshot->'dumpPricing' <> 'null'::jsonb
    ORDER BY trigger_snapshot->'dumpPricing'->>'receiptId',created_at`,[contractId]);
  return rows.map((/** @type {any} */ row)=>row.charge);
}
