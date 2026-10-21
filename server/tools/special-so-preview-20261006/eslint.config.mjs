import base from '../special-workflow-native-eslint.config.mjs';
export default [...base, { files: ['public/sales-special-stock-requests.js'],
  languageOptions: { globals: { history: 'readonly' } } }];
