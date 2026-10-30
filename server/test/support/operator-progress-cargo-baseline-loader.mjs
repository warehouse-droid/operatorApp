import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith('/src/operator-order-progress-repository.js')) { return result; }
  const source = await readFile('/app/test-artifacts/operator-progress-cargo-baseline.js', 'utf8');
  if (createHash('sha256').update(source).digest('hex') !== 'ea4c4f2ff37e0788773427b973890d4dd40d3d1624cdcad8d5e0edaa253b5d3e') {
    throw new Error('The baseline must exactly match the captured live module');
  }
  return { ...result, source };
}
