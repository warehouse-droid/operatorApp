// @ts-check
import { query } from './db.js';
import { config } from './config.js';

export const IFIR_POSTING_FLAG_KEY = 'netsuite_ifir_posting_restlet';
/** @param {any} settings */
export function isIfirPostingDeploymentReady(settings) {
  return settings.ifirPostingEnabled === true && settings.directAccessEnabled === true
    && Boolean(String(settings.ifirPostingRestletUrl || '').trim());
}

/** Read every attempt so Admin changes require no restart. A read failure stops
 * posting before either transport can run.
 * @param {{settings?:any,queryFn?:typeof query}} [options] */
export async function getIfirPostingRestletEnabled({ settings = config.netsuite, queryFn = query } = {}) {
  if (!isIfirPostingDeploymentReady(settings)) { return false; }
  const result = await queryFn('SELECT enabled FROM mbt_feature_flags WHERE flag_key = $1 LIMIT 1', [IFIR_POSTING_FLAG_KEY]);
  return result.rows[0]?.enabled === true;
}

/** Separate release hold: the existing Admin gate alone never enables this flow.
 * @param {{settings?:any,queryFn?:typeof query}} [options] */
export async function getIfirQuantityPolicyEnabled({ settings = config.netsuite, queryFn = query } = {}) {
  return settings.ifirPostingQuantityPolicyEnabled === true
    && await getIfirPostingRestletEnabled({ settings, queryFn });
}
