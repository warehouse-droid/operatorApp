import config from '../eslint.mbt.config.js';
export default [...config, { ...config[1], files: ['src/operator-order-progress-repository.js'] }];
