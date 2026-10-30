import base from './return-ra-eslint.config.mjs';
import standard from '../eslint.mbt.config.js';
export default [...base, { ...standard[0], files: ['src/aggregate-reconciliation*.js', 'src/applied-sales-order-billing.js'] }];
