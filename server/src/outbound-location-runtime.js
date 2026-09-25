// @ts-check
import { config } from './config.js';
import { activeNetSuiteLocationDirectory } from './netsuite.js';
import { getOutboundLocationHierarchy, setOutboundLocationDirectory } from './outbound-location-domain.js';

/** @type {Promise<any> | null} */
let pending = null;
export async function ensureOutboundLocationDirectory() {
  if (!config.netsuite.directAccessEnabled || !config.netsuite.restBaseUrl) {return getOutboundLocationHierarchy();}
  pending ||= activeNetSuiteLocationDirectory().then(setOutboundLocationDirectory).finally(() => { pending = null; });
  return pending;
}
