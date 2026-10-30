import config from '../eslint.mbt.config.js';
export default [...config, {
  files: ['src/operator-load-quantity.js'],
  languageOptions: config[0].languageOptions,
  rules: config[0].rules
}];
