import base from '../return-ra-eslint.config.mjs';
export default [...base, { ...base[0], files: ['src/history-repository.js'] }];
