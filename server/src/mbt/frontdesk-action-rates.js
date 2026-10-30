// @ts-check
import {query} from '../db.js';
import {MbtError} from './errors.js';

/** Resolve new work against the contract's rate card, retaining historical prices.
 * @param {string} contractId @param {string|null} [requestedVersionId] @param {boolean} [lock] */
export async function currentContractActionRate(contractId, requestedVersionId = null, lock = false) {
  const parent = await query(`SELECT original.rate_card_id::text, card.active,
      requested.rate_card_id::text AS requested_card_id
    FROM mbt_contracts contract JOIN mbt_rate_card_versions original USING(rate_card_version_id)
    JOIN mbt_rate_cards card USING(rate_card_id)
    LEFT JOIN mbt_rate_card_versions requested ON requested.rate_card_version_id=$2::uuid
    WHERE contract.contract_id=$1::uuid ${lock ? 'FOR SHARE OF card' : ''}`,[contractId,requestedVersionId]);
  if (!parent.rowCount) {
    throw new MbtError({status:404,code:'MBT_FRONTDESK_CONTRACT_NOT_FOUND',message:'The MBT contract was not found.'});
  }
  const card = parent.rows[0];
  if (requestedVersionId && card.requested_card_id !== card.rate_card_id) {
    throw new MbtError({status:409,code:'MBT_FRONTDESK_RATE_CARD_MISMATCH',message:'Use the current version of this contract\'s MBT rate card.'});
  }
  const active = await query(`SELECT rate_card_version_id::text FROM mbt_rate_card_versions
    WHERE rate_card_id=$1::uuid AND status='active'`,[card.rate_card_id]);
  if (!card.active || active.rowCount !== 1) {
    throw new MbtError({status:409,code:'MBT_FRONTDESK_RATE_NOT_ACTIVE',message:'Activate a current version of this contract\'s MBT rate card before pricing new work.'});
  }
  return String(active.rows[0].rate_card_version_id);
}
