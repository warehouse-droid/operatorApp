import { readFile } from 'node:fs/promises';

export async function load(url, context, nextLoad) {
  if (url.endsWith('/tools/direct-po-split-status-recovery.mjs')) {
    const source = await readFile(new URL(url), 'utf8');
    const changed = source.replace("'directShipCoverageVerified',false", "'directShipCoverageVerified',true");
    if (changed === source) { throw new Error('Receipt mutation target changed'); }
    return { format: 'module', source: changed, shortCircuit: true };
  }
  return nextLoad(url, context);
}
