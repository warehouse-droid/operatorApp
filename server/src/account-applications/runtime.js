import path from 'node:path';
import { loadOrCreateKeyFile } from '../link-credentials.js';
import { createAccountApplicationRepository } from './repository.js';
import { createAccountApplicationRouter } from './router.js';
import { createVaultClient } from './vault-client.js';
import { createNetSuiteGateway } from './netsuite.js';
import { suiteqlAll, upsertAccountApplicationRecord } from '../netsuite.js';

export function createAccountApplicationRuntime({ authenticate, config, dataDir, logger = console, netsuiteApi = null, vaultFetch }) {
  const enabled = () => config.accountApplications?.enabled === true;
  const vault = createVaultClient({ settings: () => config.accountApplications, ...(vaultFetch ? { fetchImpl: vaultFetch } : {}) });
  const api = netsuiteApi || { suiteqlAll, upsert: upsertAccountApplicationRecord };
  const netsuite = createNetSuiteGateway({ suiteqlAll: api.suiteqlAll, upsert: api.upsert, appBaseUrl: config.appBaseUrl, logger });
  let keyPromise = null, timer = null, running = false;
  const repo = createAccountApplicationRepository({
    baseUrl: config.appBaseUrl, vault, netsuite, logger,
    linkKey: () => {
      if (!keyPromise) keyPromise = loadOrCreateKeyFile(path.join(dataDir, '.account-application-link-key'), 'account application link')
        .catch((error) => { keyPromise = null; throw error; });
      return keyPromise;
    }
  });
  const tick = async () => {
    if (!enabled() || running) return;
    running = true;
    try {
      await repo.expireDue();
      await repo.cleanupAbandoned();
      await repo.purgeExpiredCvvs();
    } catch { logger.error('[Account applications] Maintenance failed.'); }
    finally { running = false; }
  };
  return {
    repo, vault, tick, enabled,
    router: createAccountApplicationRouter({ repo, authenticate, enabled, logger }),
    start() { if (timer) return; timer = setInterval(() => void tick(), 60000); timer.unref(); void tick(); },
    stop() { if (timer) { clearInterval(timer); timer = null; } }
  };
}
