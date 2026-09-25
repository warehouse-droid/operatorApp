import { config } from '../../src/config.js';
import { closeDb } from '../../src/db.js';
import { fetchItemFulfillmentFromNetSuite } from '../../src/netsuite.js';
import { withOperatorNetSuitePriority } from '../../src/operator-netsuite-request-pool.js';

config.netsuite.directAccessEnabled = true;
config.netsuite.restBaseUrl = process.argv[2];
const operator = process.argv[3] === 'operator';
const base = Number(process.argv[4]);
process.send({ ready: true });
process.once('message', async () => {
  try {
    const work = () => Promise.all(Array.from({ length: 3 }, (_, index) => fetchItemFulfillmentFromNetSuite(base + index)));
    const result = await (operator ? withOperatorNetSuitePriority(work) : work());
    process.send({ result });
  } catch (error) { process.send({ error: error.message }); process.exitCode = 1; }
  finally { await closeDb(); process.disconnect(); }
});
