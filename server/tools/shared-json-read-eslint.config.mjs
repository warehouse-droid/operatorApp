import base from '../eslint.mbt.config.js';
export default [...base, { ...base[0], files: ['src/shared-json-read.js'] }];
