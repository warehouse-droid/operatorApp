import base from '../eslint.mbt.config.js';
export default [...base, { ...base[0], files: ['src/netsuite.js', 'src/server.js',
  'src/operator-netsuite-request-pool.js', 'src/operator-netsuite-priority-middleware.js',
  'src/netsuite-request-*.js', 'src/return-customer-directory.js'] }];
